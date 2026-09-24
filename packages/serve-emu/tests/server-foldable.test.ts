import { describe, expect, test } from "bun:test";
import { createHarness, response, waitFor } from "./helpers/server-harness.ts";
import type { FoldPosture } from "../src/shared/foldable-contracts.ts";

const post = (value: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });

describe("foldable API", () => {
  test("records native posture actions, skips record:false, and replays them", async () => {
    const calls: FoldPosture[] = [];
    const h = await createHarness({}, {
      getFoldableState: async () => ({ supported: true, posture: "unfolded" }),
      setFoldPosture: async (serial, posture, signal) => {
        expect(serial).toBe("emulator-5554"); expect(signal).toBeInstanceOf(AbortSignal);
        calls.push(posture); return { supported: true, posture };
      },
    });
    expect(await (await response(h.request("/api/foldable"))).json()).toEqual({ ok: true, foldable: { supported: true, posture: "unfolded" } });
    expect((await response(h.request("/api/foldable", post({ posture: "folded" })))).status).toBe(200);
    await response(h.request("/api/foldable", post({ posture: "unfolded", record: false })));
    const exported = await (await response(h.request("/api/session/export"))).json();
    expect(exported.events).toHaveLength(1);
    expect(exported.events[0]).toMatchObject({ kind: "posture", posture: "folded", source: "api:foldable" });
    const replay = await response(h.request("/api/session/replay", post({})));
    expect(replay.status).toBe(200);
    await waitFor(() => calls.length === 3);
    expect(calls).toEqual(["folded", "unfolded", "folded"]);
  });
  test("bounds and validates requests before native work; errors do not record", async () => {
    let calls = 0;
    const h = await createHarness({}, { setFoldPosture: async () => { calls++; throw new Error("KO: Failed to set posture"); } });
    for (const payload of [null, [], {}, { posture: "tent" }, { posture: "folded", record: "false" }]) {
      expect((await response(h.request("/api/foldable", post(payload)))).status).toBe(400);
    }
    expect((await response(h.request("/api/foldable", post({ posture: "a".repeat(9000) })))).status).toBe(413);
    expect(calls).toBe(0);
    expect((await response(h.request("/api/foldable", post({ posture: "folded" })))).status).toBe(400);
    const exported = await (await response(h.request("/api/session/export"))).json();
    expect(exported.events).toHaveLength(0);
  });
});
