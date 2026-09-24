import { describe, expect, test } from "bun:test";
import { SessionRecorder } from "../src/session-recorder.ts";
import { createSessionReplayHandlers } from "../src/session-replay-session.ts";
import { parseSessionSnapshot } from "../src/shared/api-contracts.ts";

describe("foldable session replay", () => {
  test("postures survive export, parsing and both replay APIs", async () => {
    const recorder = new SessionRecorder({ now: () => 0, sleep: async () => {} });
    recorder.recordPosture("half-open", "test");
    const snapshot = recorder.snapshot();
    expect(parseSessionSnapshot(snapshot).events[0]).toMatchObject({ kind: "posture", posture: "half-open" });
    snapshot.events[0]!.source = "changed";
    expect(recorder.export().events[0]!.source).toBe("test");
    const calls: string[] = [];
    const handlers = { dispatchGesture: () => {}, setLocation: () => {}, setPosture: (posture: string) => { calls.push(posture); } };
    await recorder.replay(handlers);
    const run = recorder.startReplay(handlers);
    expect((await run.completion).replayStatus).toBe("completed");
    expect(calls).toEqual(["half-open", "half-open"]);
  });
  test("fails before replay if a consumer cannot apply postures", async () => {
    const recorder = new SessionRecorder(); recorder.recordPosture("folded", "test");
    const handlers = { dispatchGesture: () => {}, setLocation: () => {} };
    expect(() => recorder.startReplay(handlers)).toThrow("posture replay is not supported");
    await expect(recorder.replay(handlers)).rejects.toThrow("posture replay is not supported");
    expect(recorder.isReplaying).toBe(false);
  });
  test("posture replay obeys session generation and cancellation", async () => {
    let generation = 1;
    const calls: string[] = [];
    const handlers = createSessionReplayHandlers({
      generation: 1, getGeneration: () => generation,
      dispatchGesture: () => {}, setLocation: () => {},
      setPosture: (posture) => { calls.push(posture); },
    });
    const controller = new AbortController();
    await handlers.setPosture!("folded", controller.signal);
    generation = 2;
    await expect(handlers.setPosture!("unfolded", controller.signal)).rejects.toThrow("device session changed");
    generation = 1; controller.abort();
    await expect(handlers.setPosture!("unfolded", controller.signal)).rejects.toThrow();
    expect(calls).toEqual(["folded"]);
  });
});
