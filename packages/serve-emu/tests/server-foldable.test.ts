import { describe, expect, test } from "bun:test";
import { CommandFailureError } from "../src/command-failure.ts";
import type { DeviceService } from "../src/device-service.ts";
import { FoldableError } from "../src/foldable.ts";
import { parseApiResponse, parseSessionExport } from "../src/shared/api-contracts.ts";
import type { FoldPosture, FoldableState } from "../src/shared/foldable-contracts.ts";
import { createHarness, response, waitFor } from "./helpers/server-harness.ts";

const post = (value: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});

function foldableDevice(
  setFoldPosture: DeviceService["setFoldPosture"],
  foldable: FoldableState = { supported: true, posture: "unfolded" },
) {
  return new Proxy({} as DeviceService, {
    get: (_target, method) => {
      if (method === "foldable") return async () => foldable;
      if (method === "setFoldPosture") return setFoldPosture;
      return async () => ({});
    },
  });
}

describe("foldable API", () => {
  test("records native posture actions, skips record:false, and replays them", async () => {
    const calls: FoldPosture[] = [];
    const h = await createHarness({}, {
      deviceService: foldableDevice(async (serial, posture, signal) => {
        expect(serial).toBe("emulator-5554");
        expect(signal).toBeInstanceOf(AbortSignal);
        calls.push(posture);
        return { supported: true, posture };
      }),
    });
    const read = await (await response(h.request("/api/foldable"))).json();
    expect(parseApiResponse("/api/foldable", "GET", read)).toEqual({
      ok: true,
      foldable: { supported: true, posture: "unfolded" },
    });
    const folded = await response(h.request("/api/foldable", post({ posture: "folded" })));
    expect(folded.status).toBe(200);
    expect(parseApiResponse("/api/foldable", "POST", await folded.json())).toEqual({
      ok: true,
      foldable: { supported: true, posture: "folded" },
    });
    await response(h.request("/api/foldable", post({ posture: "unfolded", record: false })));
    const exported = parseSessionExport(await (await response(h.request("/api/session/export"))).json());
    expect(exported.events).toHaveLength(1);
    expect(exported.events[0]).toMatchObject({ kind: "posture", posture: "folded", source: "rest:foldable" });
    const replay = await response(h.request("/api/session/replay", post({})));
    expect(replay.status).toBe(200);
    await waitFor(() => calls.length === 3);
    expect(calls).toEqual(["folded", "unfolded", "folded"]);
  });

  test("validates and bounds requests before native work", async () => {
    let calls = 0;
    const h = await createHarness({}, {
      deviceService: foldableDevice(async () => {
        calls++;
        return { supported: true, posture: "folded" };
      }),
    });
    for (const payload of [null, [], {}, { posture: "tent" }, { posture: "folded", record: "false" }]) {
      const res = await response(h.request("/api/foldable", post(payload)));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_request");
    }
    expect((await response(h.request("/api/foldable", post({ posture: "a".repeat(9000) })))).status).toBe(413);
    expect(calls).toBe(0);
  });

  test("failed changes do not record, and console output stays out of the response", async () => {
    let failure: Error = new CommandFailureError("emulator-failed", "adb emu fold failed", "KO: secret detail");
    const h = await createHarness({}, {
      deviceService: foldableDevice(async () => {
        throw failure;
      }),
    });
    const failed = await response(h.request("/api/foldable", post({ posture: "folded" })));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({
      ok: false,
      error: { code: "downstream_failure", message: "adb emu fold failed", reason: "emulator-failed" },
    });
    failure = new FoldableError("busy", "A fold transition is already in progress for this emulator.");
    const busy = await response(h.request("/api/foldable", post({ posture: "folded" })));
    expect(busy.status).toBe(409);
    expect((await busy.json()).error.reason).toBe("foldable-busy");
    const exported = await (await response(h.request("/api/session/export"))).json();
    expect(exported.events).toHaveLength(0);
  });
});
