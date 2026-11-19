import { describe, expect, test } from "bun:test";
import { FoldableError, getFoldableState, parseFoldPosture, setFoldPosture } from "../src/foldable.ts";
import { CommandFailureError } from "../src/command-failure.ts";
import type { execText } from "../src/exec.ts";

function fixture({ supported = true, reject = false, settle = true, sizes = {} as Record<string, string> } = {}) {
  const calls: string[][] = [];
  let name = "OPENED";
  const exec: typeof execText = async (_command, args, opts) => {
    if (opts?.signal?.aborted) return { status: null, signal: null, stdout: "", stderr: "", error: new Error("aborted"), timedOut: false };
    calls.push(args);
    let stdout = `Committed state: DeviceState{identifier=9, name='${name}'}`;
    if (args.includes("wm")) stdout = sizes[name] ?? "";
    else if (args.includes("sensor")) stdout = `hinge-angle0: ${supported ? "enabled" : "disabled"}.\r\nOK`;
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
    expect((await getFoldableState("usb-device", deps)).supported).toBe(false);
    expect(calls).toHaveLength(0);
    await expect(setFoldPosture("emulator-5554", "folded", deps)).rejects.toThrow("no hinge sensor");
    expect(calls).toHaveLength(1);
  });
  test("folds, half-opens and unfolds through the native console with serial targeting", async () => {
    const { deps, calls } = fixture();
    for (const posture of ["folded", "half-open", "unfolded"] as const) {
      expect(await setFoldPosture("emulator-5558", posture, deps)).toEqual({ supported: true, posture });
    }
    expect(calls.filter((args) => args[2] === "emu" && args[3] !== "sensor")).toEqual([
      ["-s", "emulator-5558", "emu", "fold"],
      ["-s", "emulator-5558", "emu", "posture", "2"],
      ["-s", "emulator-5558", "emu", "unfold"],
    ]);
  });
  test("rejects console KO even with exit code zero and releases mutation lock", async () => {
    const rejected = setFoldPosture("emulator-5558", "folded", fixture({ reject: true }).deps);
    await expect(rejected).rejects.toBeInstanceOf(CommandFailureError);
    await expect(rejected).rejects.toMatchObject({ code: "emulator-failed", publicMessage: "adb emu fold failed" });
    expect((await setFoldPosture("emulator-5558", "folded", fixture().deps)).posture).toBe("folded");
  });
  test("does not claim success if Android never changes posture", async () => {
    await expect(setFoldPosture("emulator-5558", "folded", fixture({ settle: false }).deps)).rejects.toMatchObject({ code: "unconfirmed" });
  });
  test("aborts device work and rejects overlapping changes", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(setFoldPosture("emulator-5558", "folded", { ...fixture().deps, signal: abort.signal })).rejects.toThrow("aborted");
    const first = setFoldPosture("emulator-5558", "folded", fixture().deps);
    await expect(setFoldPosture("emulator-5558", "unfolded", fixture().deps)).rejects.toBeInstanceOf(FoldableError);
    await first;
  });
  test("reports whether folding changed the display size", async () => {
    const twoDisplays = fixture({ sizes: { OPENED: "Physical size: 1768x2208", CLOSED: "Physical size: 884x2208" } });
    expect(await setFoldPosture("emulator-5560", "folded", twoDisplays.deps)).toEqual({ supported: true, posture: "folded", displayChanged: true });
    const oneDisplay = fixture({ sizes: { OPENED: "Physical size: 1768x2208", CLOSED: "Physical size: 1768x2208" } });
    expect(await setFoldPosture("emulator-5560", "folded", oneDisplay.deps)).toEqual({ supported: true, posture: "folded", displayChanged: false });
    expect(oneDisplay.calls.filter((args) => args.includes("wm"))).toHaveLength(11);
  });
  test("waits for a display switch that lands after the posture commits", async () => {
    const { deps } = fixture({ sizes: { OPENED: "Physical size: 1768x2208", CLOSED: "Physical size: 1768x2208" } });
    let closedChecks = 0;
    const execText: typeof deps.execText = async (command, args, opts) => {
      const output = await deps.execText(command, args, opts);
      if (args.includes("wm") && closedChecks++ >= 3) return { ...output, stdout: "Physical size: 884x2208" };
      return output;
    };
    expect(await setFoldPosture("emulator-5564", "folded", { ...deps, execText })).toEqual({ supported: true, posture: "folded", displayChanged: true });
  });
  test("skips the display check when the posture cannot switch displays", async () => {
    const { deps, calls } = fixture({ sizes: { OPENED: "Physical size: 1768x2208", HALF_OPENED: "Physical size: 1768x2208" } });
    expect(await setFoldPosture("emulator-5562", "half-open", deps)).toEqual({ supported: true, posture: "half-open" });
    expect(await setFoldPosture("emulator-5562", "half-open", deps)).toEqual({ supported: true, posture: "half-open" });
    await setFoldPosture("emulator-5562", "folded", deps);
    expect(await setFoldPosture("emulator-5562", "half-open", deps)).toEqual({ supported: true, posture: "half-open" });
    expect(await setFoldPosture("emulator-5562", "unfolded", deps)).toEqual({ supported: true, posture: "unfolded" });
    expect(calls.filter((args) => args.includes("wm"))).toHaveLength(2);
  });
});
