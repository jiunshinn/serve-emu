import { describe, expect, test } from "bun:test";
import { createSessionReplayHandlers } from "../src/session-replay-session.ts";
import { SessionReplayConflictError } from "../src/session-recorder.ts";

describe("createSessionReplayHandlers", () => {
  test("forwards gesture and location calls while the generation is current", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const handlers = createSessionReplayHandlers({
      generation: 7,
      getGeneration: () => 7,
      dispatchGesture: (gesture, signal) => {
        expect(signal).toBe(controller.signal);
        calls.push(`gesture:${gesture.type}`);
      },
      setLocation: (fix, signal) => {
        expect(signal).toBe(controller.signal);
        calls.push(`location:${fix.latitude},${fix.longitude}`);
      },
    });

    await handlers.dispatchGesture({ type: "home" }, controller.signal);
    await handlers.setLocation(
      { latitude: 51.5, longitude: -0.1 },
      controller.signal,
    );

    expect(calls).toEqual(["gesture:home", "location:51.5,-0.1"]);
  });

  test("blocks both handler types before work starts for a stale generation", async () => {
    let calls = 0;
    const handlers = createSessionReplayHandlers({
      generation: 3,
      getGeneration: () => 4,
      dispatchGesture: () => {
        calls++;
      },
      setLocation: () => {
        calls++;
      },
    });
    const signal = new AbortController().signal;

    await expect(
      handlers.dispatchGesture({ type: "back" }, signal),
    ).rejects.toThrow("device session changed during session replay");
    await expect(
      handlers.setLocation({ latitude: 0, longitude: 0 }, signal),
    ).rejects.toBeInstanceOf(SessionReplayConflictError);
    expect(calls).toBe(0);
  });

  test("detects a generation change after an awaited gesture", async () => {
    let generation = 10;
    let calls = 0;
    const handlers = createSessionReplayHandlers({
      generation,
      getGeneration: () => generation,
      dispatchGesture: async () => {
        calls++;
        await Promise.resolve();
        generation++;
      },
      setLocation: () => {},
    });

    await expect(
      handlers.dispatchGesture(
        { type: "tap", x: 0.25, y: 0.75 },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SessionReplayConflictError);
    expect(calls).toBe(1);
  });

  test("detects a generation change after an awaited location update", async () => {
    let generation = 20;
    let calls = 0;
    const handlers = createSessionReplayHandlers({
      generation,
      getGeneration: () => generation,
      dispatchGesture: () => {},
      setLocation: async () => {
        calls++;
        await Promise.resolve();
        generation++;
      },
    });

    await expect(
      handlers.setLocation(
        { latitude: 37.5, longitude: 127 },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SessionReplayConflictError);
    expect(calls).toBe(1);
  });

  test("preserves an Error abort reason before invoking a handler", async () => {
    const reason = new Error("device disconnected");
    const controller = new AbortController();
    controller.abort(reason);
    let called = false;
    const handlers = createSessionReplayHandlers({
      generation: 1,
      getGeneration: () => 1,
      dispatchGesture: () => {
        called = true;
      },
      setLocation: () => {},
    });

    await expect(
      handlers.dispatchGesture({ type: "power" }, controller.signal),
    ).rejects.toBe(reason);
    expect(called).toBe(false);
  });

  test("normalizes a non-Error abort reason after location work", async () => {
    const controller = new AbortController();
    const handlers = createSessionReplayHandlers({
      generation: 1,
      getGeneration: () => 1,
      dispatchGesture: () => {},
      setLocation: () => {
        controller.abort("manual cancellation");
      },
    });

    try {
      await handlers.setLocation(
        { latitude: 0, longitude: 0 },
        controller.signal,
      );
      throw new Error("expected location replay to be aborted");
    } catch (error) {
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe("AbortError");
      expect((error as DOMException).message).toBe("session replay cancelled");
    }
  });
});
