import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { listAllDevices, type Device } from "./adb.ts";
import { adbCommandFailure, CommandFailureError } from "./command-failure.ts";
import { execText, type ExecResult } from "./exec.ts";

export type EmulatorLaunch = {
  serial: string;
  proc: ChildProcess | null;
  ownsProcess: boolean;
  /**
   * Stops an emulator this launch started (`emu kill`, then SIGTERM, then
   * SIGKILL after a grace period) and resolves once the process has exited.
   * A launch that only attached to a running emulator resolves at once.
   */
  stop: () => Promise<void>;
};

const STOP_GRACE_MS = 10_000;
const KILL_REAP_MS = 2_000;

export type RunningAvd = {
  serial: string;
  avd: string;
  state: string;
};

export type StartEmulatorOpts = {
  avd: string;
  emulatorPath?: string;
  port?: number;
  restartAvd?: boolean;
  bootTimeoutMs?: number;
  /**
   * Emulator `-gpu` mode. Defaults to `host` because the AVD's own `auto`
   * frequently falls back to a software Vulkan compositor (llvmpipe/lavapipe),
   * which caps the guest at a janky ~20fps and makes the stream stutter no
   * matter how good the transport is. `host` uses the real GPU (Metal/Vulkan)
   * for smooth ~60fps rendering. Pass `swiftshader_indirect` for headless hosts
   * without a usable GPU.
   */
  gpu?: string;
  /**
   * Emulator `-camera-back` mode, such as `webcam0` to show a host webcam in
   * the Android back camera. The emulator picks cameras at boot, so a running
   * AVD only gets this through `restartAvd`.
   */
  cameraBack?: string;
  /** Emulator `-camera-front` mode; same values as `cameraBack` except `virtualscene`. */
  cameraFront?: string;
  /** Aborting ends the boot wait and stops the emulator this launch spawned. */
  signal?: AbortSignal;
};

type CameraDirection = "back" | "front";

/** A host webcam as named by `emulator -webcam-list`. */
export type HostWebcam = {
  /** Camera mode that selects this webcam, such as `webcam0`. */
  name: string;
  /** Host device behind that name, such as `FaceTime HD Camera`. */
  device: string;
};

export type EmulatorResolverDependencies = {
  execText?: typeof execText;
  existsSync?: typeof existsSync;
  env?: NodeJS.ProcessEnv;
  cacheKey?: string;
};

export type EmulatorRuntimeDependencies = EmulatorResolverDependencies & {
  listAllDevices?: typeof listAllDevices;
  spawn?: typeof spawn;
  sleep?: (delayMs: number) => Promise<unknown>;
  now?: () => number;
};

function execSucceeded(result: ExecResult<string>): boolean {
  return result.status === 0 && result.error === null;
}

function execFailure(result: ExecResult<string>): string {
  return (
    result.stderr.trim() ||
    result.error?.message ||
    result.stdout.trim() ||
    "unknown error"
  );
}

let emulatorResolutionCache: {
  key: string;
  resolution: Promise<string>;
} | null = null;

function sdkEmulatorCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    env.HOME ? join(env.HOME, "Library", "Android", "sdk") : undefined,
  ].filter((v): v is string => Boolean(v));
  return [...new Set(roots)].flatMap((root) => [
    join(root, "emulator", "emulator"),
    join(root, "tools", "emulator"),
  ]);
}

function emulatorEnvironmentKey(env: NodeJS.ProcessEnv): string {
  return [
    env.PATH ?? "",
    env.ANDROID_HOME ?? "",
    env.ANDROID_SDK_ROOT ?? "",
    env.HOME ?? "",
  ].join("\0");
}

export function clearEmulatorResolutionCache(): void {
  emulatorResolutionCache = null;
}

export async function resolveEmulator(
  explicit?: string,
  dependencies: EmulatorResolverDependencies = {},
): Promise<string> {
  if (explicit) return explicit;

  const env = dependencies.env ?? process.env;
  const cacheKey = dependencies.cacheKey ?? emulatorEnvironmentKey(env);
  if (emulatorResolutionCache?.key === cacheKey) {
    return emulatorResolutionCache.resolution;
  }

  const runExec = dependencies.execText ?? execText;
  const pathExists = dependencies.existsSync ?? existsSync;
  const resolution = (async () => {
    const pathProbe = await runExec("emulator", ["-version"], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    if (
      (pathProbe.status === 0 && !pathProbe.error) ||
      pathProbe.error?.message.includes("EPIPE")
    ) {
      return "emulator";
    }

    for (const candidate of sdkEmulatorCandidates(env)) {
      if (pathExists(candidate)) return candidate;
    }

    throw new Error(
      "Could not find Android Emulator. Put `emulator` on PATH or set ANDROID_HOME / ANDROID_SDK_ROOT.",
      { cause: pathProbe.error ?? undefined },
    );
  })();
  emulatorResolutionCache = { key: cacheKey, resolution };
  try {
    return await resolution;
  } catch (error) {
    if (emulatorResolutionCache?.resolution === resolution) {
      emulatorResolutionCache = null;
    }
    throw error;
  }
}

async function listAvdsWithEmulator(
  emulator: string,
  runExec: typeof execText = execText,
): Promise<string[]> {
  const r = await runExec(emulator, ["-list-avds"], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  if (!execSucceeded(r)) {
    throw new CommandFailureError(
      "emulator-failed",
      "emulator -list-avds failed",
      execFailure(r),
      { cause: r.error ?? undefined },
    );
  }
  return r.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function listAvds(
  emulatorPath?: string,
  dependencies: EmulatorResolverDependencies = {},
): Promise<string[]> {
  return listAvdsWithEmulator(
    await resolveEmulator(emulatorPath, dependencies),
    dependencies.execText,
  );
}

const WEBCAM_MODE = /^webcam\d+$/;
const FILE_CAMERA_MODE = /^(?:videofile|imagefile|image360):./;
const NAMED_CAMERA_MODES = new Set(["emulated", "environment", "none"]);
const WEBCAM_LIST_LINE = /Camera '(webcam\d+)' is connected to device '(.*)' on channel /;

async function listWebcamsWithEmulator(
  emulator: string,
  runExec: typeof execText = execText,
): Promise<HostWebcam[]> {
  const r = await runExec(emulator, ["-webcam-list"], {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  if (!execSucceeded(r)) {
    throw new Error(
      `emulator -webcam-list failed: ${execFailure(r)}`,
      { cause: r.error ?? undefined },
    );
  }
  return r.stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(WEBCAM_LIST_LINE);
    return match ? [{ name: match[1], device: match[2] }] : [];
  });
}

/** Host webcams the emulator can assign to `-camera-back` or `-camera-front`. */
export async function listWebcams(
  emulatorPath?: string,
  dependencies: EmulatorResolverDependencies = {},
): Promise<HostWebcam[]> {
  return listWebcamsWithEmulator(
    await resolveEmulator(emulatorPath, dependencies),
    dependencies.execText,
  );
}

function validateCameraMode(direction: CameraDirection, mode: string): void {
  if (
    NAMED_CAMERA_MODES.has(mode) ||
    (direction === "back" && mode === "virtualscene") ||
    WEBCAM_MODE.test(mode) ||
    FILE_CAMERA_MODE.test(mode)
  ) {
    return;
  }
  const modes =
    direction === "back"
      ? "webcam<N>, emulated, virtualscene, environment, none"
      : "webcam<N>, emulated, environment, none";
  throw new Error(
    `--camera-${direction} must be one of ${modes}, or videofile:/imagefile:/image360:<path> (got "${mode}").`,
  );
}

/** Validate camera modes before anything boots or restarts. */
function cameraArgs(opts: StartEmulatorOpts): string[] {
  const args: string[] = [];
  if (opts.cameraBack !== undefined) {
    validateCameraMode("back", opts.cameraBack);
    args.push("-camera-back", opts.cameraBack);
  }
  if (opts.cameraFront !== undefined) {
    validateCameraMode("front", opts.cameraFront);
    args.push("-camera-front", opts.cameraFront);
  }
  // The emulator hands each webcam to one camera and leaves the other empty.
  if (opts.cameraBack === opts.cameraFront && WEBCAM_MODE.test(opts.cameraBack ?? "")) {
    throw new Error(
      `${opts.cameraBack} can feed only one camera; use a different webcam for --camera-front.`,
    );
  }
  return args;
}

/**
 * The emulator boots without a camera, rather than failing, when a requested
 * webcam is missing, so check the host list first.
 */
async function assertWebcamsConnected(
  emulator: string,
  opts: StartEmulatorOpts,
  runExec: typeof execText = execText,
): Promise<void> {
  const requested = [opts.cameraBack, opts.cameraFront].filter(
    (mode): mode is string => mode !== undefined && WEBCAM_MODE.test(mode),
  );
  if (!requested.length) return;
  const webcams = await listWebcamsWithEmulator(emulator, runExec);
  for (const name of requested) {
    if (webcams.some((webcam) => webcam.name === name)) continue;
    const available = webcams.length
      ? webcams.map((webcam) => `${webcam.name} (${webcam.device})`).join(", ")
      : "(none)";
    throw new Error(`Unknown webcam "${name}". Available webcams: ${available}`);
  }
}

function avdName(avd: string): string {
  return avd.startsWith("@") ? avd.slice(1) : avd;
}

function emulatorAvdArg(avd: string): string {
  return avd.startsWith("@") ? avd : `@${avd}`;
}

async function usedEmulatorPorts(
  readDevices: typeof listAllDevices = listAllDevices,
): Promise<Set<number>> {
  const ports = new Set<number>();
  for (const device of await readDevices()) {
    const match = device.serial.match(/^emulator-(\d+)$/);
    if (match) ports.add(Number(match[1]));
  }
  return ports;
}

// Ports picked by launches in this process that have not registered with adb
// yet. Two concurrent launches would otherwise both pick the first free port.
const reservedPorts = new Set<number>();

/** Picks and reserves a free port; the caller releases it after boot. */
async function pickEmulatorPort(
  readDevices: typeof listAllDevices = listAllDevices,
): Promise<number> {
  const used = await usedEmulatorPorts(readDevices);
  for (let port = 5554; port <= 5682; port += 2) {
    if (!used.has(port) && !reservedPorts.has(port)) {
      reservedPorts.add(port);
      return port;
    }
  }
  throw new Error("No available emulator console ports in the 5554-5682 range.");
}

async function assertPortFree(
  port: number,
  dependencies: Pick<EmulatorRuntimeDependencies, "execText" | "listAllDevices">,
): Promise<void> {
  const used = await usedEmulatorPorts(dependencies.listAllDevices);
  if (!used.has(port) && !reservedPorts.has(port)) {
    reservedPorts.add(port);
    return;
  }
  const owner = used.has(port)
    ? await runningAvdName(`emulator-${port}`, dependencies.execText)
    : null;
  throw new Error(
    `--emulator-port ${port} is already in use by emulator-${port}` +
      (owner ? ` (AVD "${owner}")` : "") +
      ". Pick another port or omit --emulator-port.",
  );
}

function validateEmulatorPort(port: number): void {
  if (!Number.isInteger(port) || port < 5554 || port > 5682 || port % 2 !== 0) {
    throw new Error("--emulator-port must be an even integer from 5554 through 5682.");
  }
}

function adb(
  serial: string,
  args: string[],
  runExec: typeof execText = execText,
): Promise<ExecResult<string>> {
  return runExec("adb", ["-s", serial, ...args], { timeout: 5_000 });
}

function parseEmuAvdName(stdout: string): string | null {
  return (
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && line !== "OK" && !line.startsWith("KO:")) ?? null
  );
}

async function runningAvdName(
  serial: string,
  runExec: typeof execText = execText,
): Promise<string | null> {
  const fromConsole = await adb(serial, ["emu", "avd", "name"], runExec);
  if (execSucceeded(fromConsole)) {
    const name = parseEmuAvdName(fromConsole.stdout);
    if (name) return name;
  }

  const fromProp = await adb(
    serial,
    ["shell", "getprop", "ro.boot.qemu.avd_name"],
    runExec,
  );
  if (execSucceeded(fromProp)) {
    const name = fromProp.stdout.trim();
    if (name) return name;
  }

  return null;
}

export async function resolveRunningAvds(
  devices: readonly Device[],
  runExec: typeof execText = execText,
): Promise<RunningAvd[]> {
  const emulators = devices.filter((device) =>
    /^emulator-\d+$/.test(device.serial),
  );
  const named = await Promise.all(
    emulators.map(async (device) => {
      const avd = await runningAvdName(device.serial, runExec);
      return avd ? { serial: device.serial, avd, state: device.state } : null;
    }),
  );
  return named.filter((entry): entry is RunningAvd => entry !== null);
}

export async function listRunningAvds(
  devices?: readonly Device[],
  dependencies: Pick<EmulatorRuntimeDependencies, "execText" | "listAllDevices"> = {},
): Promise<RunningAvd[]> {
  const snapshot = devices ?? (await (dependencies.listAllDevices ?? listAllDevices)());
  return resolveRunningAvds(snapshot, dependencies.execText);
}

async function findRunningAvd(
  name: string,
  dependencies: Pick<EmulatorRuntimeDependencies, "execText" | "listAllDevices"> = {},
): Promise<RunningAvd | null> {
  return (await listRunningAvds(undefined, dependencies)).find(
    (running) => running.avd === name,
  ) ?? null;
}

export async function stopEmulator(
  serial: string,
  runExec: typeof execText = execText,
): Promise<void> {
  const r = await adb(serial, ["emu", "kill"], runExec);
  if (!execSucceeded(r)) {
    throw adbCommandFailure("adb emu kill", r);
  }
}

async function waitForEmulatorExit(
  serial: string,
  timeoutMs = 30_000,
  dependencies: Pick<EmulatorRuntimeDependencies, "listAllDevices" | "sleep" | "now"> = {},
): Promise<void> {
  const now = dependencies.now ?? Date.now;
  const pause = dependencies.sleep ?? sleep;
  const readDevices = dependencies.listAllDevices ?? listAllDevices;
  const startedAt = now();
  while (now() - startedAt < timeoutMs) {
    if (!(await readDevices()).some((device) => device.serial === serial)) return;
    await pause(500);
  }
  throw new Error(`Timed out waiting for ${serial} to stop.`);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("emulator launch aborted");
}

async function waitForBoot(
  serial: string,
  avd: string,
  proc: ChildProcess,
  timeoutMs: number,
  dependencies: Pick<EmulatorRuntimeDependencies, "execText" | "sleep" | "now"> = {},
  signal?: AbortSignal,
): Promise<void> {
  const now = dependencies.now ?? Date.now;
  const pause = dependencies.sleep ?? sleep;
  const runExec = dependencies.execText ?? execText;
  const startedAt = now();
  let nameUnreadable = false;
  while (now() - startedAt < timeoutMs) {
    throwIfAborted(signal);
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`emulator exited before boot completed (code ${proc.exitCode ?? "null"})`);
    }

    const state = await adb(serial, ["get-state"], runExec);
    if (execSucceeded(state) && state.stdout.trim() === "device") {
      const boot = await adb(
        serial,
        ["shell", "getprop", "sys.boot_completed"],
        runExec,
      );
      if (execSucceeded(boot) && boot.stdout.trim() === "1") {
        // Another emulator that was already booted on this port also answers
        // here; only the requested AVD counts as ours. An unreadable name
        // (an adb timeout while the device settles) is not a verdict either
        // way, so keep polling until the boot timeout.
        const running = await runningAvdName(serial, runExec);
        if (running === avd) return;
        if (running !== null) throw new EmulatorIdentityError(serial, avd, running);
        nameUnreadable = true;
      }
    }

    await pause(1_000);
  }

  throw new Error(
    nameUnreadable
      ? `Timed out waiting for ${serial} to report AVD "${avd}": it booted, but its AVD name could not be read.`
      : `Timed out waiting for ${serial} to boot.`,
  );
}

/** The booted emulator on the launch's port is another AVD, which is left running. */
export class EmulatorIdentityError extends Error {
  constructor(serial: string, expected: string, actual: string) {
    super(
      `${serial} is running AVD "${actual}", not "${expected}"; ` +
        `AVD "${actual}" was left running.`,
    );
    this.name = "EmulatorIdentityError";
  }
}

export async function startEmulator(
  opts: StartEmulatorOpts,
  dependencies: EmulatorRuntimeDependencies = {},
): Promise<EmulatorLaunch> {
  const runExec = dependencies.execText ?? execText;
  const camera = cameraArgs(opts);
  const emulator = await resolveEmulator(opts.emulatorPath, dependencies);
  const name = avdName(opts.avd);
  const avds = await listAvdsWithEmulator(emulator, runExec);
  if (!avds.includes(name)) {
    const available = avds.length ? avds.join(", ") : "(none)";
    throw new Error(`Unknown AVD "${name}". Available AVDs: ${available}`);
  }
  await assertWebcamsConnected(emulator, opts, runExec);

  const running = await findRunningAvd(name, dependencies);
  if (running) {
    if (!opts.restartAvd) {
      if (camera.length) {
        throw new Error(
          `AVD "${name}" is already running as ${running.serial}, and the emulator picks cameras at boot. Add --restart-avd to relaunch it with the requested camera.`,
        );
      }
      return {
        serial: running.serial,
        proc: null,
        ownsProcess: false,
        stop: async () => {},
      };
    }
    await stopEmulator(running.serial, runExec);
    await waitForEmulatorExit(running.serial, 30_000, dependencies);
  }

  if (opts.port !== undefined) {
    validateEmulatorPort(opts.port);
    await assertPortFree(opts.port, dependencies);
  }
  const port = opts.port ?? (await pickEmulatorPort(dependencies.listAllDevices));
  try {
    return await launchOnPort(port, name, emulator, camera, opts, dependencies);
  } finally {
    // Booted emulators are listed by adb, so the reservation is no longer needed.
    reservedPorts.delete(port);
  }
}

async function launchOnPort(
  port: number,
  name: string,
  emulator: string,
  camera: string[],
  opts: StartEmulatorOpts,
  dependencies: EmulatorRuntimeDependencies,
): Promise<EmulatorLaunch> {
  const runExec = dependencies.execText ?? execText;
  const args = [emulatorAvdArg(name), "-port", String(port)];
  if (opts.gpu) args.push("-gpu", opts.gpu);
  args.push(...camera);

  throwIfAborted(opts.signal);
  const proc = (dependencies.spawn ?? spawn)(emulator, args, {
    stdio: ["ignore", "inherit", "inherit"],
  });
  const spawnError = new Promise<never>((_, reject) => {
    proc.once("error", reject);
  });
  const serial = `emulator-${port}`;
  let stopTask: Promise<void> | null = null;
  // Until the AVD on this port is confirmed to be ours, `emu kill` could reach
  // someone else's emulator; signalling our own child is always safe.
  let confirmed = false;

  const stop = (): Promise<void> => {
    stopTask ??= (async () => {
      if (confirmed) await adb(serial, ["emu", "kill"], runExec).catch(() => {});
      signalChild(proc, "SIGTERM");
      if (await exited(proc, STOP_GRACE_MS, dependencies)) return;
      signalChild(proc, "SIGKILL");
      await exited(proc, KILL_REAP_MS, dependencies);
    })();
    return stopTask;
  };

  const aborted = new Promise<never>((_, reject) => {
    if (!opts.signal) return;
    const onAbort = () =>
      reject(
        opts.signal!.reason instanceof Error
          ? opts.signal!.reason
          : new Error("emulator launch aborted"),
      );
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  });
  void aborted.catch(() => {});

  try {
    await Promise.race([
      waitForBoot(
        serial,
        name,
        proc,
        opts.bootTimeoutMs ?? 120_000,
        dependencies,
        opts.signal,
      ),
      spawnError,
      aborted,
    ]);
    confirmed = true;
    return { serial, proc, ownsProcess: true, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

function signalChild(proc: ChildProcess, signal: NodeJS.Signals): void {
  try {
    proc.kill(signal);
  } catch {}
}

/** Resolves true once `proc` has exited, or false after `timeoutMs`. */
async function exited(
  proc: ChildProcess,
  timeoutMs: number,
  dependencies: Pick<EmulatorRuntimeDependencies, "sleep">,
): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return true;
  let onExit!: () => void;
  const exit = new Promise<true>((resolve) => {
    onExit = () => resolve(true);
    proc.once("exit", onExit);
  });
  const pause = dependencies.sleep ?? sleep;
  const result = await Promise.race([
    exit,
    Promise.resolve(pause(timeoutMs)).then(() => false as const),
  ]);
  proc.off("exit", onExit);
  return result;
}
