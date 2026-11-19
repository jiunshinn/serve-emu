import { setTimeout as sleep } from "node:timers/promises";
import { getDisplaySize } from "./adb.ts";
import { adbText, type AdbDeps } from "./adb-command.ts";
import { CommandFailureError } from "./command-failure.ts";
import type { FoldPosture, FoldableState } from "./shared/foldable-contracts.ts";

export type FoldableDeps = AdbDeps & {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
};

/**
 * Why a posture change was refused or not confirmed. `busy` and `unsupported`
 * are caller errors; `unconfirmed` means Android never reported the posture.
 */
export class FoldableError extends Error {
  constructor(
    readonly code: "busy" | "unsupported" | "unconfirmed",
    message: string,
  ) {
    super(message);
    this.name = "FoldableError";
  }
}

const COMMAND = { timeout: 5_000, maxBuffer: 64 * 1024 };
const CONFIRM_ATTEMPTS = 20;
const CONFIRM_INTERVAL_MS = 100;
const RESIZE_ATTEMPTS = 10;

async function emulatorConsole(
  serial: string,
  args: string[],
  deps: FoldableDeps,
): Promise<string> {
  const operation = `adb emu ${args[0]}`;
  const output = (
    await adbText(serial, ["emu", ...args], { ...COMMAND, operation }, deps)
  ).trim();
  // The emulator console reports KO with a successful adb exit code.
  if (/^KO:/m.test(output)) {
    throw new CommandFailureError("emulator-failed", `${operation} failed`, output);
  }
  return output;
}

async function deviceState(serial: string, deps: FoldableDeps): Promise<string> {
  return adbText(
    serial,
    ["shell", "cmd", "device_state", "state"],
    { ...COMMAND, operation: "adb shell cmd device_state" },
    deps,
  );
}

export function parseFoldPosture(output: string): FoldableState["posture"] {
  const name = output.match(/name=['"]([^'"]+)['"]/)?.[1]?.toUpperCase();
  if (!name) return "unknown";
  if (/HALF/.test(name)) return "half-open";
  if (/UNFOLDED|OPENED|^OPEN$/.test(name)) return "unfolded";
  if (/FOLDED|CLOSED/.test(name)) return "folded";
  return "unknown";
}

export async function getFoldableState(
  serial: string,
  deps: FoldableDeps = {},
): Promise<FoldableState> {
  if (!/^emulator-\d+$/.test(serial)) {
    return {
      supported: false,
      posture: "unknown",
      reason: "Fold controls require an Android foldable emulator.",
    };
  }
  const sensors = await emulatorConsole(serial, ["sensor", "status"], deps);
  if (!/^hinge-angle0:\s*enabled\./m.test(sensors)) {
    return {
      supported: false,
      posture: "unknown",
      reason:
        "This emulator has no hinge sensor. Create a Pixel Fold or Fold-in AVD to test folding.",
    };
  }
  return { supported: true, posture: parseFoldPosture(await deviceState(serial, deps)) };
}

const changing = new Set<string>();

export async function setFoldPosture(
  serial: string,
  posture: FoldPosture,
  deps: FoldableDeps = {},
): Promise<FoldableState> {
  if (changing.has(serial)) {
    throw new FoldableError(
      "busy",
      "A fold transition is already in progress for this emulator.",
    );
  }
  changing.add(serial);
  try {
    const state = await getFoldableState(serial, deps);
    if (!state.supported) throw new FoldableError("unsupported", state.reason!);
    // Folding switches to the cover display only when the image has one.
    const expectsResize =
      posture === "folded" && state.posture !== "unknown" && state.posture !== "folded";
    const displaySize = () => getDisplaySize(serial, deps).catch(() => null);
    const before = expectsResize ? await displaySize() : null;
    const args =
      posture === "folded" ? ["fold"] : posture === "unfolded" ? ["unfold"] : ["posture", "2"];
    await emulatorConsole(serial, args, deps);
    // Sensor delivery and Android's display switch are asynchronous. Report the
    // committed Android state, not the requested posture or a stale sensor value.
    const wait = deps.sleep ?? ((ms, signal) => sleep(ms, undefined, { signal }));
    for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
      if (parseFoldPosture(await deviceState(serial, deps)) === posture) {
        if (!before) return { supported: true, posture };
        // The display can switch after Android commits the posture.
        for (let check = 0; check < RESIZE_ATTEMPTS; check++) {
          const after = await displaySize();
          if (!after) return { supported: true, posture };
          if (after.width !== before.width || after.height !== before.height) {
            return { supported: true, posture, displayChanged: true };
          }
          if (check < RESIZE_ATTEMPTS - 1) await wait(CONFIRM_INTERVAL_MS, deps.signal);
        }
        return { supported: true, posture, displayChanged: false };
      }
      await wait(CONFIRM_INTERVAL_MS, deps.signal);
    }
    throw new FoldableError(
      "unconfirmed",
      "Android did not confirm the requested posture. Check for a device-state override in the emulator, then retry.",
    );
  } finally {
    changing.delete(serial);
  }
}
