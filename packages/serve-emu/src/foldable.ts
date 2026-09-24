import { setTimeout as sleep } from "node:timers/promises";
import { execText } from "./exec.ts";
import { isFoldPosture, type FoldPosture, type FoldableState } from "./shared/foldable-contracts.ts";

type Dependencies = {
  execText?: typeof execText;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
};

async function adb(serial: string, args: string[], signal: AbortSignal | undefined, deps: Dependencies) {
  const result = await (deps.execText ?? execText)("adb", ["-s", serial, ...args], {
    timeout: 5_000, maxBuffer: 64 * 1024, signal,
  });
  const output = result.stdout.trim();
  // The emulator console may report KO with a successful adb exit code.
  if (result.status !== 0 || result.error || /^KO:/m.test(output)) {
    throw new Error(result.error?.message || result.stderr.trim() || output || "Emulator command failed");
  }
  return output;
}

export function parseFoldPosture(output: string): FoldableState["posture"] {
  const name = output.match(/name=['"]([^'"]+)['"]/)?.[1]?.toUpperCase();
  if (!name) return "unknown";
  if (/HALF/.test(name)) return "half-open";
  if (/UNFOLDED|OPENED|^OPEN$/.test(name)) return "unfolded";
  if (/FOLDED|CLOSED/.test(name)) return "folded";
  return "unknown";
}

export async function getFoldableState(serial: string, signal?: AbortSignal, deps: Dependencies = {}): Promise<FoldableState> {
  if (!/^emulator-\d+$/.test(serial)) {
    return { supported: false, posture: "unknown", reason: "Fold controls require an Android foldable emulator." };
  }
  const sensors = await adb(serial, ["emu", "sensor", "status"], signal, deps);
  if (!/^hinge-angle0:\s*enabled\./m.test(sensors)) {
    return { supported: false, posture: "unknown", reason: "This emulator has no hinge sensor. Create a Pixel Fold or Fold-in AVD to test folding." };
  }
  const state = await adb(serial, ["shell", "cmd", "device_state", "state"], signal, deps);
  return { supported: true, posture: parseFoldPosture(state) };
}

const changing = new Set<string>();
export async function setFoldPosture(serial: string, posture: FoldPosture, signal?: AbortSignal, deps: Dependencies = {}): Promise<FoldableState> {
  if (!isFoldPosture(posture)) throw new Error("posture must be folded, half-open, or unfolded");
  if (changing.has(serial)) throw new Error("A fold transition is already in progress for this emulator.");
  changing.add(serial);
  try {
    const state = await getFoldableState(serial, signal, deps);
    if (!state.supported) throw new Error(state.reason);
    const args = posture === "folded" ? ["fold"] : posture === "unfolded" ? ["unfold"] : ["posture", "2"];
    await adb(serial, ["emu", ...args], signal, deps);
    // Sensor delivery and Android's display switch are asynchronous. Report the
    // committed Android state, not the requested posture or a stale sensor value.
    for (let attempt = 0; attempt < 20; attempt++) {
      const output = await adb(serial, ["shell", "cmd", "device_state", "state"], signal, deps);
      if (parseFoldPosture(output) === posture) return { supported: true, posture };
      await (deps.sleep ?? ((ms, abort) => sleep(ms, undefined, { signal: abort })))(100, signal);
    }
    throw new Error("Android did not confirm the requested posture. Check for a device-state override in the emulator, then retry.");
  } finally {
    changing.delete(serial);
  }
}
