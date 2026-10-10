import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { startScrcpy, type AdbCommandResult } from "../src/scrcpy.ts";
import {
  createHarness,
  fakeScrcpy,
  response,
} from "./helpers/server-harness.ts";

// What a failing adb prints: host paths, its argument list, and a Java stack
// trace. None of it may reach an API response; all of it must reach the log.
const SECRET = "/home/me/SECRET-PATH";
const STUB_ADB = `#!/bin/sh
echo "stdout ${SECRET} adb $*"
echo "java.lang.RuntimeException at ${SECRET}" >&2
exit 1
`;

type ErrorLog = ReturnType<typeof spyOn<Console, "error">>;

async function withErrorLog<T>(run: (log: ErrorLog) => Promise<T>): Promise<T> {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    return await run(log);
  } finally {
    log.mockRestore();
  }
}

function expectNoOutput(body: string): void {
  expect(body).not.toContain("SECRET-PATH");
  expect(body).not.toContain("RuntimeException");
}

describe("API responses for failing adb commands", () => {
  // Until the adb helpers are injectable (#111), a stub `adb` on PATH stands
  // in for a device whose commands fail.
  let stubDir = "";
  const originalPath = process.env.PATH;

  beforeAll(async () => {
    stubDir = await mkdtemp(join(tmpdir(), "serve-emu-stub-adb-"));
    const adb = join(stubDir, "adb");
    await writeFile(adb, STUB_ADB);
    await chmod(adb, 0o755);
    process.env.PATH = `${stubDir}${delimiter}${originalPath ?? ""}`;
  });

  afterAll(async () => {
    process.env.PATH = originalPath;
    await rm(stubDir, { recursive: true, force: true });
  });

  test("return 502 with the operation name and log the output", async () => {
    const cases = [
      { method: "GET", path: "/api/screenshot", error: "screencap failed" },
      {
        method: "GET",
        path: "/api/foreground",
        error: "adb shell dumpsys failed",
      },
      {
        method: "GET",
        path: "/api/orientation",
        error: "cmd window user-rotation failed",
      },
      { method: "GET", path: "/api/devices", error: "adb devices failed" },
      {
        method: "POST",
        path: "/api/apps/launch",
        body: { packageName: "com.example.app" },
        error: "adb shell monkey failed",
      },
      {
        method: "GET",
        path: "/api/accessibility",
        error: "uiautomator dump failed",
      },
      {
        method: "POST",
        path: "/api/accessibility/tap",
        body: { text: "OK" },
        error: "uiautomator dump failed",
      },
    ];
    const h = await createHarness();

    await withErrorLog(async (log) => {
      for (const entry of cases) {
        log.mockClear();
        const res = await response(
          h.request(entry.path, {
            method: entry.method,
            ...(entry.body
              ? {
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(entry.body),
                }
              : {}),
          }),
        );
        const body = await res.text();

        expect({ path: entry.path, status: res.status }).toEqual({
          path: entry.path,
          status: 502,
        });
        expect(JSON.parse(body)).toEqual({
          ok: false,
          code: "adb-failed",
          error: entry.error,
        });
        expectNoOutput(body);
        expect(log).toHaveBeenCalledTimes(1);
        expect(log.mock.calls[0]?.[0]).toBe(
          `[api] ${entry.method} ${entry.path} -> 502 ${entry.error}:`,
        );
        expect((log.mock.calls[0]?.[1] as Error).message).toContain(SECRET);
      }
    });
  }, 15_000);

  test("never log the auth token from the query string", async () => {
    const token = "query-token-0123456789";
    const h = await createHarness({ token });

    await withErrorLog(async (log) => {
      const res = await response(h.request(`/api/screenshot?token=${token}`));
      expect(res.status).toBe(502);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]?.[0]).toBe(
        "[api] GET /api/screenshot -> 502 screencap failed:",
      );
      expect((log.mock.calls[0]?.[1] as Error).message).not.toContain(token);
    });
  });
});

describe("API responses for a failing scrcpy startup", () => {
  test("device select and AVD start name only the failed adb step", async () => {
    const jar = `${SECRET}/scrcpy-server.jar`;
    const runAdb = async (
      _serial: string,
      args: string[],
    ): Promise<AdbCommandResult> => {
      const failed = args[0] === "push" || args[1] === "test";
      return {
        status: failed ? 1 : 0,
        stdout: "",
        stderr:
          args[0] === "push" ? `adb: error: failed to copy '${jar}'` : "",
        timedOut: false,
        error: null,
      };
    };
    const initial = fakeScrcpy("emulator-5554");
    let stops = 0;
    const h = await createHarness(
      { serial: "emulator-5554" },
      {
        openScrcpy: async (serial, signal) =>
          serial === initial.serial
            ? initial
            : startScrcpy(
                { serial, signal },
                {
                  ensureServer: async () => jar,
                  serverFingerprint: async () => "a".repeat(64),
                  runAdb,
                  spawnAdb: () => {
                    throw new Error("scrcpy must not start after a failed push");
                  },
                },
              ),
        listDevices: async () => [
          { serial: "emulator-5554", state: "device" },
          { serial: "emulator-5556", state: "device" },
        ],
        startEmulator: async () => ({
          serial: "emulator-5556",
          proc: null,
          ownsProcess: true,
          stop: () => {
            stops++;
          },
        }),
      },
    );

    await withErrorLog(async (log) => {
      for (const [path, payload] of [
        ["/api/devices/select", { serial: "emulator-5556" }],
        ["/api/avds/start", { avd: "Pixel_8" }],
      ] as const) {
        log.mockClear();
        const res = await response(
          h.request(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }),
        );
        const body = await res.text();

        expect({ path, status: res.status }).toEqual({ path, status: 502 });
        expect(JSON.parse(body)).toEqual({
          ok: false,
          code: "adb-failed",
          error: "adb push failed",
        });
        expectNoOutput(body);
        expect(log).toHaveBeenCalledTimes(1);
        expect(log.mock.calls[0]?.[0]).toBe(
          `[api] POST ${path} -> 502 adb push failed:`,
        );
        expect((log.mock.calls[0]?.[1] as Error).message).toContain(
          `push ${jar}`,
        );
      }
    });
    // The failed switch leaves the working device published.
    const api = await response(h.request("/api"));
    expect(await api.json()).toMatchObject({ serial: "emulator-5554" });
    expect(stops).toBe(1);
  });
});
