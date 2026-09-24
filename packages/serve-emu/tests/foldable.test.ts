import { describe, expect, test } from "bun:test";
import { getFoldableState, parseFoldPosture, setFoldPosture } from "../src/foldable.ts";
import type { execText } from "../src/exec.ts";

function fixture({ supported = true, reject = false, settle = true } = {}) {
  const calls: string[][] = [];
  let name = "OPENED";
  const exec: typeof execText = async (_command, args, opts) => {
    if (opts?.signal?.aborted) return { status: null, signal: null, stdout: "", stderr: "", error: new Error("aborted"), timedOut: false };
    calls.push(args);
    let stdout = `Committed state: DeviceState{identifier=9, name='${name}'}`;
    if (args.includes("sensor")) stdout = `hinge-angle0: ${supported ? "enabled" : "disabled"}.\r\nOK`;
    else if (args[2] === "emu") {
      if (settle) name = args[3] === "fold" ? "CLOSED" : args[3] === "unfold" ? "OPENED" : "HALF_OPENED";
      stdout = reject ? "KO: Failed to set posture" : "OK";
    }
    return { status: 0, signal: null, stdout, stderr: "", error: null, timedOut: false };
  };
  return { calls, deps: { execText: exec, sleep: async () => {} } };
}

describe("native foldable control", () => {
  test("reads Android names rather than assuming device-state IDs", () => {
    expect(parseFoldPosture("DeviceState{identifier=7, name='HALF_OPENED'}")).toBe("half-open");
    expect(parseFoldPosture("DeviceState{identifier=0, name='UNFOLDED'}")).toBe("unfolded");
    expect(parseFoldPosture("DeviceState{identifier=2, name='CLOSED'}")).toBe("folded");
    expect(parseFoldPosture("DeviceState{identifier=3, name='REAR_DISPLAY_MODE'}")).toBe("unknown");
    expect(parseFoldPosture("unsupported")).toBe("unknown");
  });
  test("physical devices and non-foldable emulators cannot be mutated", async () => {
    const { deps, calls } = fixture({ supported: false });
    expect((await getFoldableState("usb-device", undefined, deps)).supported).toBe(false);
    expect(calls).toHaveLength(0);
    await expect(setFoldPosture("emulator-5554", "folded", undefined, deps)).rejects.toThrow("no hinge sensor");
    expect(calls).toHaveLength(1);
  });
  test("folds, half-opens and unfolds through the native console with serial targeting", async () => {
    const { deps, calls } = fixture();
    for (const posture of ["folded", "half-open", "unfolded"] as const) {
      expect(await setFoldPosture("emulator-5558", posture, undefined, deps)).toEqual({ supported: true, posture });
    }
    expect(calls.filter((args) => args[2] === "emu" && args[3] !== "sensor")).toEqual([
      ["-s", "emulator-5558", "emu", "fold"],
      ["-s", "emulator-5558", "emu", "posture", "2"],
      ["-s", "emulator-5558", "emu", "unfold"],
    ]);
  });
  test("rejects console KO even with exit code zero and releases mutation lock", async () => {
    await expect(setFoldPosture("emulator-5558", "folded", undefined, fixture({ reject: true }).deps)).rejects.toThrow("KO:");
    expect((await setFoldPosture("emulator-5558", "folded", undefined, fixture().deps)).posture).toBe("folded");
  });
  test("does not claim success if Android never changes posture", async () => {
    await expect(setFoldPosture("emulator-5558", "folded", undefined, fixture({ settle: false }).deps)).rejects.toThrow("did not confirm");
  });
  test("aborts device work and rejects overlapping changes", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(setFoldPosture("emulator-5558", "folded", abort.signal, fixture().deps)).rejects.toThrow("aborted");
    const first = setFoldPosture("emulator-5558", "folded", undefined, fixture().deps);
    await expect(setFoldPosture("emulator-5558", "unfolded", undefined, fixture().deps)).rejects.toThrow("already in progress");
    await first;
  });
});
