import { describe, expect, spyOn, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { AppManagementError } from "../src/app-management.ts";
import type { StagedMultipartFile } from "../src/multipart-upload.ts";
import { startServer } from "../src/server.ts";
import { deferred } from "./helpers/deferred.ts";
import {
  createHarness,
  fakeScrcpy,
  response,
  type HarnessOptions,
} from "./helpers/server-harness.ts";

/** Fake adb lists both devices; the server starts on device-old. */
const DEVICES: HarnessOptions = { serials: ["device-old", "device-new"] };

function jsonRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function streamedJsonRequest(
  chunks: string[],
  headers: HeadersInit = {},
): RequestInit {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(encoder.encode(chunk));
      },
    }),
  };
}

function fakeUploadRequest(signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=fake" },
    body: "--fake--\r\n",
    signal,
  };
}

function stagedFile(
  name: string,
  cleanup: () => Promise<void> = async () => {},
): StagedMultipartFile {
  return {
    path: `/tmp/${name}`,
    filename: name,
    mediaType: "application/octet-stream",
    size: 4,
    cleanup,
  };
}

async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition did not become true");
}

describe("server request and upload limits", () => {
  test.each([
    ["chunked", { "transfer-encoding": "chunked" }],
    ["missing Content-Length", {}],
    ["understated Content-Length", { "content-length": "1" }],
  ])("rejects %s oversized JSON with a structured 413", async (_, headers) => {
    const harness = await createHarness(DEVICES);
    const res = await response(
      harness.request(
        "/api/devices/select",
        streamedJsonRequest(
          ["{\"serial\":\"", "x".repeat(9_000), "\"}"],
          headers,
        ),
      ),
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "payload_too_large" },
    });
  });

  test("accepts ordinary APK and media multipart requests and removes staging files", async () => {
    const stagedPaths: string[] = [];
    const observed: Array<{
      kind: "apk" | "media";
      serial: string;
      filename: string;
      bytes: string;
    }> = [];
    const harness = await createHarness(
      { ...DEVICES, maxApkUploadBytes: 1_024, maxMediaUploadBytes: 2_048 },
      {
        installApk: async (serial, file) => {
          if (file instanceof File) throw new Error("expected staged APK");
          stagedPaths.push(file.path);
          observed.push({
            kind: "apk",
            serial,
            filename: file.filename,
            bytes: (await readFile(file.path)).toString(),
          });
          return { ok: true, output: "installed" };
        },
        importMediaFile: async (serial, file) => {
          if (file instanceof File) throw new Error("expected staged media");
          stagedPaths.push(file.path);
          observed.push({
            kind: "media",
            serial,
            filename: file.filename,
            bytes: (await readFile(file.path)).toString(),
          });
          return {
            ok: true,
            output: "imported",
            path: "/sdcard/Pictures/photo.jpg",
            kind: "image",
          };
        },
      },
    );

    const apk = new FormData();
    apk.set(
      "apk",
      new File(["apk-bytes"], "demo.apk", {
        type: "application/vnd.android.package-archive",
      }),
    );
    const media = new FormData();
    media.set("file", new File(["jpg-bytes"], "photo.jpg", { type: "image/jpeg" }));

    const installResponse = await response(
      harness.request("/api/apps/install", {
        method: "POST",
        body: apk,
      }),
    );
    const importResponse = await response(
      harness.request("/api/files/import", {
        method: "POST",
        body: media,
      }),
    );

    expect(installResponse.status).toBe(200);
    expect(importResponse.status).toBe(200);
    expect(observed).toEqual([
      {
        kind: "apk",
        serial: "device-old",
        filename: "demo.apk",
        bytes: "apk-bytes",
      },
      {
        kind: "media",
        serial: "device-old",
        filename: "photo.jpg",
        bytes: "jpg-bytes",
      },
    ]);
    for (const path of stagedPaths) {
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test("returns structured 413 responses for oversized APK and media files", async () => {
    let actionCalls = 0;
    const harness = await createHarness(
      { ...DEVICES, maxApkUploadBytes: 4, maxMediaUploadBytes: 5 },
      {
        installApk: async () => {
          actionCalls++;
          return { ok: true, output: "unexpected" };
        },
        importMediaFile: async () => {
          actionCalls++;
          return {
            ok: true,
            output: "unexpected",
            path: "/sdcard/unexpected",
            kind: "file",
          };
        },
      },
    );
    const apk = new FormData();
    apk.set("apk", new File(["12345"], "too-large.apk"));
    const media = new FormData();
    media.set("file", new File(["123456"], "too-large.bin"));

    const responses = await Promise.all([
      response(
        harness.request("/api/apps/install", {
          method: "POST",
          body: apk,
        }),
      ),
      response(
        harness.request("/api/files/import", {
          method: "POST",
          body: media,
        }),
      ),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({
        ok: false,
        error: { code: "payload_too_large" },
      });
    }
    expect(actionCalls).toBe(0);
  });

  test("bounds active and queued uploads and rejects overflow before staging", async () => {
    const actions = [deferred<void>(), deferred<void>()];
    let actionCount = 0;
    let stageCalls = 0;
    let cleanupCalls = 0;
    const harness = await createHarness(
      { ...DEVICES, maxActiveUploads: 1, maxQueuedUploads: 1 },
      {
        stageMultipartUpload: async () => {
          stageCalls++;
          return stagedFile(`upload-${stageCalls}.apk`, async () => {
            cleanupCalls++;
          });
        },
        installApk: async () => {
          const action = actions[actionCount++]!;
          await action.promise;
          return { ok: true, output: "installed" };
        },
      },
    );

    const first = response(
      harness.request("/api/apps/install", fakeUploadRequest()),
    );
    const second = response(
      harness.request("/api/apps/install", fakeUploadRequest()),
    );
    const overflow = await response(
      harness.request("/api/apps/install", fakeUploadRequest()),
    );

    expect(overflow.status).toBe(429);
    expect(await overflow.json()).toMatchObject({
      ok: false,
      error: { code: "rate_limited", reason: "upload-queue-full" },
    });
    expect(stageCalls).toBe(1);

    const health = await response(harness.request("/health"));
    expect(await health.json()).toMatchObject({
      uploads: { active: 1, queued: 1 },
    });

    actions[0]!.resolve();
    expect((await first).status).toBe(200);
    await flushUntil(() => stageCalls === 2);
    actions[1]!.resolve();
    expect((await second).status).toBe(200);
    expect(cleanupCalls).toBe(2);
  });

  test("switching during staging cancels the old generation before closing it", async () => {
    let stageStarted = false;
    let actionCalled = false;
    let oldClosesAtStagingCleanup: number | undefined;
    const harness = await createHarness(DEVICES, {
      stageMultipartUpload: async (_request, options) => {
        stageStarted = true;
        return await new Promise<StagedMultipartFile>((_resolve, reject) => {
          const abort = () => {
            oldClosesAtStagingCleanup = harness.session.closeCalls;
            reject(options.signal?.reason);
          };
          options.signal?.addEventListener("abort", abort, { once: true });
          if (options.signal?.aborted) abort();
        });
      },
      installApk: async () => {
        actionCalled = true;
        return { ok: true, output: "unexpected" };
      },
    });
    const old = harness.sessions.get("device-old")!;
    const next = harness.sessions.get("device-new")!;

    const upload = response(
      harness.request("/api/apps/install", fakeUploadRequest()),
    );
    await flushUntil(() => stageStarted);
    const switching = response(
      harness.request(
        "/api/devices/select",
        jsonRequest({ serial: "device-new" }),
      ),
    );
    const [uploadResponse, switchResponse] = await Promise.all([upload, switching]);

    expect(uploadResponse.status).toBe(409);
    expect(await uploadResponse.json()).toMatchObject({
      error: { code: "conflict", reason: "device-session-changed" },
    });
    expect(switchResponse.status).toBe(200);
    expect(actionCalled).toBe(false);
    // Staging was cleaned up while the old session was still open, then the
    // old session (and not the new one) was closed.
    expect(oldClosesAtStagingCleanup).toBe(0);
    expect(old.closeCalls).toBe(1);
    expect(next.closeCalls).toBe(0);
  });

  test("switching during ADB keeps the captured old serial and cancels it once the switch commits", async () => {
    const events: string[] = [];
    const cleanupGate = deferred<void>();
    const nextReady = deferred<void>();
    const old = fakeScrcpy("device-old");
    const next = fakeScrcpy("device-new");
    let adbStarted = false;
    let actionSerial = "";
    const harness = await createHarness({ sessions: [old, next] }, {
      // Gates the candidate's scrcpy start so the test can act mid-switch.
      openScrcpy: async (serial) => {
        if (serial === "device-old") return old;
        events.push("next-prepare");
        await nextReady.promise;
        return next;
      },
      stageMultipartUpload: async () =>
        stagedFile("switch.apk", async () => {
          events.push("cleanup-start");
          await cleanupGate.promise;
          events.push("cleanup-done");
        }),
      installApk: async (serial, _file, { signal } = {}) => {
        actionSerial = serial;
        adbStarted = true;
        return await new Promise((_resolve, reject) => {
          const abort = () => {
            events.push("adb-abort");
            reject(signal?.reason);
          };
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      },
    });

    const upload = response(
      harness.request("/api/apps/install", fakeUploadRequest()),
    );
    await flushUntil(() => adbStarted);
    let switchSettled = false;
    const switching = response(
      harness.request(
        "/api/devices/select",
        jsonRequest({ serial: "device-new" }),
      ),
    ).finally(() => {
      switchSettled = true;
    });

    // While the candidate is prepared, the still-current device keeps its
    // upload: a switch that fails here must leave it untouched.
    await flushUntil(() => events.includes("next-prepare"));
    expect(events).toEqual(["next-prepare"]);
    expect(old.closeCalls).toBe(0);

    nextReady.resolve();
    await flushUntil(() => events.includes("cleanup-start"));
    expect(actionSerial).toBe("device-old");
    expect(switchSettled).toBe(false);

    cleanupGate.resolve();
    const [uploadResponse, switchResponse] = await Promise.all([upload, switching]);
    expect(uploadResponse.status).toBe(409);
    expect(switchResponse.status).toBe(200);
    expect(events.indexOf("adb-abort")).toBeGreaterThan(0);
    expect(events.indexOf("cleanup-start")).toBeGreaterThan(
      events.indexOf("adb-abort"),
    );
    expect(events.indexOf("cleanup-done")).toBeGreaterThan(
      events.indexOf("cleanup-start"),
    );
    expect(old.closeCalls).toBe(1);
  });

  test("a failed switch leaves uploads on the current device working", async () => {
    const installs: string[] = [];
    const harness = await createHarness(DEVICES, {
      stageMultipartUpload: async () => stagedFile("again.apk"),
      installApk: async (serial) => {
        installs.push(serial);
        return { ok: true, output: "Success" };
      },
    });

    const before = await response(
      harness.request("/api/apps/install", fakeUploadRequest()),
    );
    expect(before.status).toBe(200);

    const failedSwitch = await response(
      harness.request(
        "/api/devices/select",
        jsonRequest({ serial: "device-missing" }),
      ),
    );
    expect(failedSwitch.status).toBe(400);

    const after = await response(
      harness.request("/api/apps/install", fakeUploadRequest()),
    );
    expect(after.status).toBe(200);
    expect(installs).toEqual(["device-old", "device-old"]);
  });

  test("request abort cancels active work and cleans its staged file", async () => {
    const controller = new AbortController();
    let actionStarted = false;
    let cleanupCalls = 0;
    const harness = await createHarness(DEVICES, {
      stageMultipartUpload: async () =>
        stagedFile("aborted.apk", async () => {
          cleanupCalls++;
        }),
      installApk: async (_serial, _file, { signal } = {}) => {
        actionStarted = true;
        return await new Promise((_resolve, reject) => {
          const abort = () => reject(signal?.reason);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      },
    });

    const upload = response(
      harness.request(
        "/api/apps/install",
        fakeUploadRequest(controller.signal),
      ),
    );
    await flushUntil(() => actionStarted);
    controller.abort(new Error("client disconnected"));
    const res = await upload;

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "invalid_request", reason: "upload-cancelled" },
    });
    expect(cleanupCalls).toBe(1);
  });

  test("reports a staging cleanup failure even when the request is cancelled", async () => {
    const controller = new AbortController();
    let actionStarted = false;
    const harness = await createHarness(DEVICES, {
      stageMultipartUpload: async () =>
        stagedFile("cleanup-failure.apk", async () => {
          throw new Error("temporary directory is still present");
        }),
      installApk: async (_serial, _file, { signal } = {}) => {
        actionStarted = true;
        return await new Promise((_resolve, reject) => {
          const abort = () => reject(signal?.reason);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      },
    });

    const upload = response(
      harness.request(
        "/api/apps/install",
        fakeUploadRequest(controller.signal),
      ),
    );
    await flushUntil(() => actionStarted);
    controller.abort(new Error("client disconnected"));
    const res = await upload;

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "internal_error", reason: "upload-cleanup-failed" },
    });
  });

  test("reports a remote partial cleanup failure after cancellation", async () => {
    const controller = new AbortController();
    let actionStarted = false;
    const harness = await createHarness(DEVICES, {
      stageMultipartUpload: async () => stagedFile("cleanup-failure.jpg"),
      importMediaFile: async (_serial, _file, { signal } = {}) => {
        actionStarted = true;
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else
            signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
        throw new AppManagementError(
          "adb-cleanup-failed",
          "failed to remove remote partial upload",
        );
      },
    });

    const upload = response(
      harness.request(
        "/api/files/import",
        fakeUploadRequest(controller.signal),
      ),
    );
    await flushUntil(() => actionStarted);
    controller.abort(new Error("client disconnected"));
    const res = await upload;

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "downstream_failure", reason: "adb-cleanup-failed" },
    });
  });

  test("maps ADB failure and timeout errors and still cleans staging", async () => {
    let action = 0;
    let cleanupCalls = 0;
    const adbOutput =
      "Performing Streamed Install\nadb: failed to install /tmp/serve-emu-upload-x1/error.apk: Failure [INSTALL_FAILED_INVALID_APK]";
    const harness = await createHarness(DEVICES, {
      stageMultipartUpload: async () =>
        stagedFile("error.apk", async () => {
          cleanupCalls++;
        }),
      installApk: async () => {
        action++;
        throw new AppManagementError(
          action === 1 ? "adb-failed" : "adb-timeout",
          adbOutput,
          {
            publicMessage:
              action === 1 ? "adb install failed" : "adb install timed out",
          },
        );
      },
    });

    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    try {
      const failed = await response(
        harness.request("/api/apps/install", fakeUploadRequest()),
      );
      const timedOut = await response(
        harness.request("/api/apps/install", fakeUploadRequest()),
      );

      expect(failed.status).toBe(502);
      const failedBody = await failed.text();
      expect(JSON.parse(failedBody)).toEqual({
        ok: false,
        error: {
          code: "downstream_failure",
          message: "adb install failed",
          reason: "adb-failed",
        },
      });
      expect(failedBody).not.toContain("serve-emu-upload");
      expect(timedOut.status).toBe(504);
      expect(await timedOut.json()).toEqual({
        ok: false,
        error: {
          code: "downstream_timeout",
          message: "adb install timed out",
          reason: "adb-timeout",
        },
      });
      expect(cleanupCalls).toBe(2);
      // The detail is kept for the server log.
      expect(errorLog).toHaveBeenCalledTimes(2);
      expect(String(errorLog.mock.calls[0]?.[0])).toBe(
        "[api] POST /api/apps/install -> 502 adb install failed:",
      );
      expect(String(errorLog.mock.calls[1]?.[0])).toBe(
        "[api] POST /api/apps/install -> 504 adb install timed out:",
      );
      expect((errorLog.mock.calls[0]?.[1] as Error).message).toBe(adbOutput);
    } finally {
      errorLog.mockRestore();
    }
  });

  test("async stop waits for active upload cleanup", async () => {
    const cleanupGate = deferred<void>();
    let actionStarted = false;
    let cleanupStarted = false;
    const harness = await createHarness(DEVICES, {
      stageMultipartUpload: async () =>
        stagedFile("stop.apk", async () => {
          cleanupStarted = true;
          await cleanupGate.promise;
        }),
      installApk: async (_serial, _file, { signal } = {}) => {
        actionStarted = true;
        return await new Promise((_resolve, reject) => {
          const abort = () => reject(signal?.reason);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      },
    });

    const upload = response(
      harness.request("/api/apps/install", fakeUploadRequest()),
    );
    await flushUntil(() => actionStarted);
    let stopSettled = false;
    const stopping = harness.started.stop().finally(() => {
      stopSettled = true;
    });
    await flushUntil(() => cleanupStarted);

    expect(harness.server.stopArguments).toHaveLength(1);
    expect(stopSettled).toBe(false);
    cleanupGate.resolve();
    await stopping;
    expect(stopSettled).toBe(true);

    const res = await upload;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: "conflict", reason: "device-session-changed" },
    });
  });

  test("passes HTTP and WebSocket byte ceilings to Bun.serve", async () => {
    const harness = await createHarness({
      ...DEVICES,
      maxApkUploadBytes: 123,
      maxMediaUploadBytes: 456,
    });

    expect(harness.handlers.maxRequestBodySize).toBe(
      456 + 2 * 1024 * 1024,
    );
    expect(harness.handlers.websocket.maxPayloadLength).toBe(16 * 1024);
  });

  test("rejects upload limits that would overflow Bun's body ceiling", async () => {
    const unsafeUploadLimit =
      Number.MAX_SAFE_INTEGER - 2 * 1024 * 1024 + 1;

    // Calls startServer directly: it must reject the options before serving.
    await expect(
      startServer({
        serial: "device-old",
        port: 0,
        maxMediaUploadBytes: unsafeUploadLimit,
      }),
    ).rejects.toThrow("upload byte limit is too large");
  });

  test("rejects queue timeouts above the platform timer range", async () => {
    // Calls startServer directly: it must reject the options before serving.
    await expect(
      startServer({
        serial: "device-old",
        port: 0,
        uploadQueueTimeoutMs: 2_147_483_648,
      }),
    ).rejects.toThrow("uploadQueueTimeoutMs must be at most 2147483647");
  });
});
