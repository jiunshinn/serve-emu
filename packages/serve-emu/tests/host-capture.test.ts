import { expect, spyOn, test } from "bun:test";
import { startHostCaptureSession, openCaptureSession } from "../src/host-capture.ts";
import type { ScreenshotFrame } from "../src/emulator-grpc.ts";
import type { VideoPacket } from "../src/scrcpy.ts";
import { createDeviceService } from "../src/device-service.ts";
import { createHarness, fakeScrcpy, response, waitFor } from "./helpers/server-harness.ts";
import { deferred } from "./helpers/deferred.ts";
import { ManualClock } from "./helpers/manual-clock.ts";

class Feed<T> implements AsyncIterableIterator<T> {
  values: Array<{ value?: T; error?: Error; done?: boolean }> = [];
  wake?: () => void;
  push(value: T) { this.values.push({ value }); this.wake?.(); }
  end() { this.values.push({ done: true }); this.wake?.(); }
  fail(error: Error) { this.values.push({ error }); this.wake?.(); }
  async next(): Promise<IteratorResult<T>> {
    while (!this.values.length) await new Promise<void>((resolve) => { this.wake = resolve; });
    const next = this.values.shift()!;
    if (next.error) throw next.error;
    return next.done ? { done: true, value: undefined } : { done: false, value: next.value! };
  }
  [Symbol.asyncIterator]() { return this; }
}

type EncoderPacket = Omit<Extract<VideoPacket, { type: "frame" }>, "type">;
const frame = (width = 64, height = 32): ScreenshotFrame => ({ width, height, rotation: 0, seq: 1n, timestampUs: 1n });

function harness(failure?: string) {
  const control = fakeScrcpy();
  const frames = new Feed<ScreenshotFrame>();
  if (failure === "empty") frames.end();
  else if (failure !== "timeout") frames.push(frame());
  const encoders: Array<{ closeCalls: number; pushes: number; keys: number; packets: Feed<EncoderPacket>; width: number; height: number }> = [];
  let streamClosed = 0;
  let video: boolean | undefined;
  const deps: NonNullable<Parameters<typeof startHostCaptureSession>[1]> = {
    firstFrameTimeoutMs: 30,
    discover: async () => { if (failure === "discover") throw new Error("private-token"); return { port: 8554, token: "private-token" }; },
    startControl: async (opts) => { video = opts.video; if (failure === "control") throw new Error("private-token"); return control; },
    startStream: async () => {
      if (failure === "stream") throw new Error("private-token");
      return { mmapPath: "pixels", frames: async function* () { yield* frames; }, close: async () => { streamClosed++; frames.end(); } };
    },
    startEncoder: async (opts) => {
      if (failure === "encoder") throw new Error("private-token");
      const state = { closeCalls: 0, pushes: 0, keys: 0, packets: new Feed<EncoderPacket>(), width: opts.width, height: opts.height };
      encoders.push(state);
      return {
        pushFrame() {
          state.pushes++;
          if (failure === "encoder-output") { state.packets.fail(new Error("private-token")); return; }
          if (state.pushes === 1) state.packets.push({ data: Buffer.from([7, 8]), pts: 1n, isConfig: true, isKey: false });
          state.packets.push({ data: Buffer.from([5]), pts: 2n, isConfig: false, isKey: true });
        },
        requestKeyFrame() { state.keys++; },
        packets: async function* () { yield* state.packets; },
        close: async () => { state.closeCalls++; state.packets.end(); },
      };
    },
  };
  return { control, frames, encoders, deps, get streamClosed() { return streamClosed; }, get video() { return video; } };
}

test("native frames become session/config/video packets and size changes restart the encoder", async () => {
  const h = harness();
  const startEncoder = h.deps.startEncoder!;
  h.deps.startEncoder = async (opts) => {
    expect(opts.keyFrameInterval).toBe(3);
    expect(opts.maxFps).toBe(15);
    expect(opts.bitRate).toBe(1_000_000);
    return startEncoder(opts);
  };
  const session = await startHostCaptureSession({ serial: "emulator-5554", maxSize: 1, keyFrameInterval: 3, maxFps: 15, bitRate: 1_000_000 }, h.deps);
  try {
    expect(h.video).toBe(false);
    expect(session.meta).toMatchObject({ width: 64, height: 32 });
    expect(session.transport).toBe("host-capture");
    expect(await session.readFrame()).toEqual({ type: "session", width: 64, height: 32, clientResized: false });
    expect(await session.readFrame()).toMatchObject({ type: "frame", isConfig: true });
    expect(await session.readFrame()).toMatchObject({ type: "frame", isKey: true, pts: 2n });
    session.requestKeyFrame?.();
    expect(h.encoders[0]!.keys).toBe(1);
    h.frames.push(frame(32, 64));
    expect(await session.readFrame()).toEqual({ type: "session", width: 32, height: 64, clientResized: false });
    expect(h.encoders[0]!.closeCalls).toBe(1);
    expect(session.meta).toMatchObject({ width: 32, height: 64 });
    expect(await session.readFrame()).toMatchObject({ isConfig: true });
    expect(await session.readFrame()).toMatchObject({ isKey: true });
  } finally { await session.close(); await session.close(); }
  expect(h.streamClosed).toBe(1);
  expect(h.control.closeCalls).toBe(1);
  expect(h.encoders[1]!.closeCalls).toBe(1);
});

test.each(["discover", "control", "stream", "empty", "timeout", "encoder", "encoder-output"])("startup failure at %s falls back and cleans up", async (failure) => {
  const h = harness(failure);
  const logs: string[] = [];
  const fallback = fakeScrcpy();
  const result = await openCaptureSession({ serial: "emulator-5554", hostCapture: true }, {
    platform: "darwin", startHost: (opts) => startHostCaptureSession(opts, h.deps),
    startScrcpy: async () => fallback, log: (line) => logs.push(line),
  });
  expect(result).toBe(fallback);
  expect(logs).toHaveLength(1);
  expect(logs[0]).not.toContain("private-token");
  expect(result.hostCaptureFallbackReason).toBeDefined();
  if (!["discover", "control"].includes(failure)) expect(h.control.closeCalls).toBe(1);
  if (["empty", "timeout", "encoder", "encoder-output"].includes(failure)) expect(h.streamClosed).toBe(1);
  if (failure === "encoder-output") expect(h.encoders[0]!.closeCalls).toBe(1);
});

test.each([
  { hostCapture: false, serial: "emulator-5554", platform: "darwin" },
  { hostCapture: true, serial: "physical-device", platform: "darwin" },
  { hostCapture: true, serial: "emulator-5554", platform: "linux" },
] as const)("bypasses host capture when ineligible: %p", async (opts) => {
  const control = fakeScrcpy();
  const result = await openCaptureSession(opts, { platform: opts.platform, startHost: async () => { throw new Error("must not run"); }, startScrcpy: async () => control });
  expect(result).toBe(control);
  expect(result.hostCaptureFallbackReason).toBeUndefined();
});

test("successful host capture does not open a second scrcpy session", async () => {
  const h = harness();
  const result = await openCaptureSession({ serial: "emulator-5554", hostCapture: true }, {
    platform: "darwin", startHost: (opts) => startHostCaptureSession(opts, h.deps),
    startScrcpy: async () => { throw new Error("unexpected fallback"); },
  });
  expect(result.transport).toBe("host-capture");
  await result.close();
});

test("host capture preserves control-only socket identity for the sharing guard and contention probe", async () => {
  const captures: ReturnType<typeof harness>[] = [];
  const clock = new ManualClock(1_000);
  let foreignSession = false;
  const server = await createHarness({ serials: ["emulator-5554"], hostCapture: true, refuseSharedDevice: true, probeDeviceContention: true }, {
    recoveryClock: clock,
    deviceService: {
      ...createDeviceService(),
      scrcpySockets: async () => [
        ...captures.map((capture) => `scrcpy_${capture.control.scid}`),
        ...(foreignSession ? ["scrcpy_deadbeef"] : []),
      ],
    },
    openScrcpy: async (serial, signal, quality) => {
      const capture = harness();
      capture.control.scid = (captures.length + 1).toString(16).padStart(8, "0");
      captures.push(capture);
      return openCaptureSession({ serial, signal, ...quality, hostCapture: true }, {
        platform: "darwin", startHost: (opts) => startHostCaptureSession(opts, capture.deps),
        startScrcpy: async () => { throw new Error("unexpected fallback"); },
      });
    },
  });
  const health = async () => (await response(server.request("/health"))).json();
  const changeQuality = () => response(server.request("/api/stream-quality", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxFps: 15 }),
  }));
  try {
    expect(captures[0]!.video).toBe(false);
    clock.advance(2_000);
    clock.fireActive();
    await waitFor(async () => (await health()).contention !== null);
    expect(await health()).toMatchObject({ stream: { capture: "host" }, contention: { otherScrcpySessions: 0 } });
    foreignSession = true;
    expect((await changeQuality()).status).toBe(409);
    expect(captures).toHaveLength(1);
    foreignSession = false;
    expect((await changeQuality()).status).toBe(200);
    expect(captures).toHaveLength(2);
    expect(captures[0]!.control.closeCalls).toBe(1);
    expect(captures[1]!.video).toBe(false);
  } finally { await server.started.stop(); }
});

test.each(["grpc", "encoder"])("propagates %s stream failure through readFrame", async (failure) => {
  const h = harness();
  const token = crypto.randomUUID();
  h.deps.discover = async () => ({ port: 8554, token });
  const session = await startHostCaptureSession({ serial: "emulator-5554" }, h.deps);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (let i = 0; i < 3; i++) await session.readFrame();
    const cause = new Error(failure === "grpc" ? token : "Host encoder exited (1): Encoder output failed: -1");
    if (failure === "grpc") h.frames.fail(cause);
    else h.encoders[0]!.packets.fail(cause);
    const error = await session.readFrame().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(failure === "grpc" ? "Host screenshot stream failed" : "Host encoder stream failed");
    if (failure === "encoder") {
      expect((error as Error).cause).toBe(cause);
      await expect(session.readFrame()).rejects.toBe(error);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith("[host-capture]", error);
    } else expect(log).not.toHaveBeenCalled();
    expect(Bun.inspect(log.mock.calls)).not.toContain(token);
  } finally { await session.close(); log.mockRestore(); }
});

test("clean gRPC EOF ends readFrame and close interrupts idle readers", async () => {
  const h = harness();
  const session = await startHostCaptureSession({ serial: "emulator-5554" }, h.deps);
  for (let i = 0; i < 3; i++) await session.readFrame();
  h.frames.end();
  expect(await session.readFrame()).toBeNull();
  await session.close();
  expect(h.control.closeCalls).toBe(1);
});

test("abort closes all resources without falling back", async () => {
  const h = harness();
  const controller = new AbortController();
  const session = await startHostCaptureSession({ serial: "emulator-5554", signal: controller.signal }, h.deps);
  controller.abort();
  await waitFor(() => h.streamClosed === 1);
  await session.close();
  expect(h.control.closeCalls).toBe(1);
});

test("abort interrupts first-frame startup without falling back", async () => {
  const h = harness("timeout");
  h.deps.firstFrameTimeoutMs = 60_000;
  const controller = new AbortController();
  const started = openCaptureSession({ serial: "emulator-5554", hostCapture: true, signal: controller.signal }, {
    platform: "darwin", startHost: (opts) => startHostCaptureSession(opts, h.deps),
    startScrcpy: async () => { throw new Error("must not fall back"); },
  });
  await waitFor(() => h.video === false);
  controller.abort();
  await expect(started).rejects.toThrow();
  expect(h.control.closeCalls).toBe(1);
});

test("close cleans up an encoder that finishes starting during a size change", async () => {
  const h = harness();
  const original = h.deps.startEncoder!;
  const pending = deferred<Awaited<ReturnType<typeof original>>>();
  let opens = 0;
  h.deps.startEncoder = async (opts) => ++opens === 1 ? original(opts) : pending.promise;
  const session = await startHostCaptureSession({ serial: "emulator-5554" }, h.deps);
  h.frames.push(frame(32, 64));
  await waitFor(() => opens === 2);
  await session.close();
  const late = await original({ mmapPath: "pixels", width: 32, height: 64, bitRate: 1000, maxFps: 60 });
  pending.resolve(late);
  await waitFor(() => h.encoders[1]!.closeCalls === 1);
  expect(h.control.closeCalls).toBe(1);
});
