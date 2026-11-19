import { describe, expect, test } from "bun:test";
import {
  createHarness,
  fakeScrcpy,
  response,
  waitFor,
  type Harness,
} from "./helpers/server-harness.ts";
import { deferred } from "./helpers/deferred.ts";

async function health(harness: Harness) {
  const res = await response(harness.request("/health"));
  return { status: res.status, body: await res.json() };
}

async function waitForStatus(harness: Harness, status: string) {
  await waitFor(async () => (await health(harness)).body.status === status);
}

describe("scrcpy stream termination", () => {
  test("reopens the same serial after an offline retry and publishes a new generation", async () => {
    const serial = "emulator-5554";
    const initial = fakeScrcpy(serial);
    const replacement = fakeScrcpy(serial);
    const waits: { ms: number; next: ReturnType<typeof deferred<void>> }[] = [];
    let online = false;
    let opens = 0;
    const harness = await createHarness({ sessions: [initial] }, {
      listDevices: async () => online ? [{ serial, state: "device" }] : [],
      openScrcpy: async (target) => {
        expect(target).toBe(serial);
        return ++opens === 1 ? initial : replacement;
      },
      waitForDeviceRetry(ms) {
        const next = deferred<void>();
        waits.push({ ms, next });
        return next.promise;
      },
    });
    initial.endFrames();
    await waitFor(() => waits.length === 1);
    initial.proc.emit("exit", 137, null);
    expect((await health(harness)).body).toMatchObject({ status: "error", recovering: true });
    expect((await response(harness.request("/ws"))).status).toBe(503);
    expect(initial.closeCalls).toBe(1);
    waits[0]!.next.resolve();
    await waitFor(() => waits.length === 2);
    expect(waits.map(({ ms }) => ms)).toEqual([500, 1000]);
    online = true;
    waits[1]!.next.resolve();
    await waitForStatus(harness, "streaming");
    expect((await health(harness)).body).toMatchObject({
      serial, generation: 2, recovering: false,
    });
    expect(opens).toBe(2);
    await harness.openWebSocket();
  });

  test("an explicit stop cancels a preparing automatic replacement", async () => {
    const serial = "emulator-5554";
    const initial = fakeScrcpy(serial);
    const replacement = fakeScrcpy(serial);
    const candidate = deferred<typeof replacement>();
    let attemptSignal: AbortSignal | undefined;
    const harness = await createHarness({ sessions: [initial] }, {
      openScrcpy: async (_serial, signal) => {
        if (!initial.closeCalls) return initial;
        attemptSignal = signal;
        return candidate.promise;
      },
      waitForDeviceRetry: async () => {},
      stopEmulator: async () => {},
    });
    initial.failFrames(new Error("encoder interrupted"));
    await waitFor(() => attemptSignal !== undefined);
    const stopped = harness.request("/api/avds/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serial }),
    });
    await waitFor(() => attemptSignal?.aborted ?? false);
    candidate.resolve(replacement);
    expect((await response(stopped)).status).toBe(200);
    expect(replacement.closeCalls).toBe(1);
    expect((await health(harness)).body).toMatchObject({
      generation: 0, recovering: false,
    });
    expect(harness.started.deviceSerial).toBeNull();
  });

  test("an abnormal scrcpy exit marks the session as errored", async () => {
    const harness = await createHarness();
    harness.session.proc.emit("exit", 137, null);
    await waitForStatus(harness, "error");

    const { status, body } = await health(harness);
    expect(status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      status: "error",
      lastError: "scrcpy exited with code 137 signal null",
      lastErrorCode: "process-exit",
      lastErrorMeta: { exitCode: 137 },
    });
  });

  test("a clean scrcpy exit leaves a streaming session alone", async () => {
    const harness = await createHarness();
    harness.session.proc.emit("exit", 0, null);
    await Promise.resolve();

    const { status, body } = await health(harness);
    expect(status).toBe(200);
    expect(body.status).toBe("streaming");
  });

  test("a crash after a clean end of the video stream escalates to error", async () => {
    const harness = await createHarness();
    harness.session.endFrames();
    await waitForStatus(harness, "stopped");

    harness.session.proc.emit("exit", null, "SIGKILL");
    await waitForStatus(harness, "error");
    expect((await health(harness)).body).toMatchObject({
      lastError: "scrcpy exited with code null signal SIGKILL",
      lastErrorCode: "process-exit",
      lastErrorMeta: { signal: "SIGKILL" },
    });
  });

  test("a control socket error marks the session as errored", async () => {
    const harness = await createHarness();
    harness.session.controlSocket.emit("error", new Error("EPIPE"));
    await waitForStatus(harness, "error");

    expect((await health(harness)).body).toMatchObject({
      status: "error",
      lastError: "scrcpy control socket error: EPIPE",
      lastErrorCode: null,
    });
  });

  test("an unstructured frame read failure is reported as text", async () => {
    const harness = await createHarness();
    harness.session.failFrames(new Error("read failed"));
    await waitForStatus(harness, "error");

    expect((await health(harness)).body).toMatchObject({
      status: "error",
      lastError: "Error: read failed",
      lastErrorCode: null,
    });
  });

  test("scrcpy ending during server stop is not reported as a failure", async () => {
    const harness = await createHarness();
    await harness.started.stop();
    harness.session.proc.emit("exit", 1, null);
    harness.session.controlSocket.emit("error", new Error("closed"));
    await Promise.resolve();

    expect((await health(harness)).body).toMatchObject({
      status: "stopped",
      lastError: "server stopping",
    });
  });
});
