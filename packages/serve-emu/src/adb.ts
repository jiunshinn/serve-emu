import { adbBuffer, adbText, type AdbDeps } from "./adb-command.ts";
import { CommandFailureError } from "./command-failure.ts";
import type {
  Device,
  FontScaleStatus,
  NetworkRadioStatus,
  NetworkStatus,
  NightMode,
  NightModeStatus,
  OrientationMode,
  OrientationStatus,
} from "./shared/api-contracts.ts";

const ADB_QUERY_TIMEOUT_MS = 2_000;
const ADB_MUTATION_TIMEOUT_MS = 5_000;
const ADB_SCREENSHOT_TIMEOUT_MS = 8_000;

function unexpectedOutput(operation: string, output: string): CommandFailureError {
  return new CommandFailureError(
    "adb-failed",
    `Could not parse ${operation} output`,
    output.trim(),
  );
}

const query = (operation: string) => ({ operation, timeout: ADB_QUERY_TIMEOUT_MS });
const mutation = (operation: string) => ({ operation, timeout: ADB_MUTATION_TIMEOUT_MS });

export async function listAllDevices(deps: AdbDeps = {}): Promise<Device[]> {
  const stdout = await adbText(null, ["devices"], query("adb devices"), deps);
  return stdout
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [serial, state] = l.split(/\s+/);
      return { serial, state };
    });
}

export async function listDevices(deps: AdbDeps = {}): Promise<Device[]> {
  return (await listAllDevices(deps)).filter((d) => d.state === "device");
}

export async function pickDevice(
  explicit?: string,
  deps: AdbDeps = {},
): Promise<string> {
  if (explicit) return explicit;
  const devices = await listDevices(deps);
  if (devices.length === 0) throw new Error("No booted Android device found. Start an emulator or attach a device.");
  if (devices.length > 1)
    throw new Error(
      `Multiple devices online (${devices.map((d) => d.serial).join(", ")}). Pass -s <serial>.`,
    );
  return devices[0].serial;
}

export function screencapPng(serial: string, deps: AdbDeps = {}): Promise<Buffer> {
  return adbBuffer(
    serial,
    ["exec-out", "screencap", "-p"],
    {
      operation: "screencap",
      maxBuffer: 64 * 1024 * 1024,
      timeout: ADB_SCREENSHOT_TIMEOUT_MS,
    },
    deps,
  );
}

function orientationFromRotation(mode: "free" | "lock" | "unknown", rotation: number | null): OrientationStatus["orientation"] {
  if (mode === "free") return "auto";
  if (rotation === 0 || rotation === 2) return "portrait";
  if (rotation === 1 || rotation === 3) return "landscape";
  return "unknown";
}

export async function getUserRotation(
  serial: string,
  deps: AdbDeps = {},
): Promise<OrientationStatus> {
  const stdout = await adbText(
    serial,
    ["shell", "cmd", "window", "user-rotation"],
    query("cmd window user-rotation"),
    deps,
  );
  const raw = stdout.trim();
  const match = raw.match(/^(free|lock)(?:\s+(\d+))?$/);
  if (!match) {
    return { mode: "unknown", rotation: null, orientation: "unknown", raw };
  }
  const mode = match[1] as "free" | "lock";
  const rotation = match[2] === undefined ? null : Number(match[2]);
  return { mode, rotation, orientation: orientationFromRotation(mode, rotation), raw };
}

export async function setUserRotation(
  serial: string,
  orientation: OrientationMode,
  deps: AdbDeps = {},
): Promise<OrientationStatus> {
  const args =
    orientation === "auto"
      ? ["cmd", "window", "user-rotation", "free"]
      : ["cmd", "window", "user-rotation", "lock", orientation === "portrait" ? "0" : "1"];
  await adbText(serial, ["shell", ...args], mutation("cmd window user-rotation"), deps);
  return getUserRotation(serial, deps);
}

export async function getFontScale(
  serial: string,
  deps: AdbDeps = {},
): Promise<FontScaleStatus> {
  const stdout = await adbText(
    serial,
    ["shell", "settings", "get", "system", "font_scale"],
    query("settings get system font_scale"),
    deps,
  );
  const raw = stdout.trim();
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw unexpectedOutput("font_scale", stdout);
  }
  return { scale, raw };
}

export async function setFontScale(
  serial: string,
  scale: number,
  deps: AdbDeps = {},
): Promise<FontScaleStatus> {
  if (!Number.isFinite(scale) || scale < 0.7 || scale > 2) {
    throw new Error("font scale must be between 0.7 and 2.0");
  }
  const normalized = scale.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  const args = ["settings", "put", "system", "font_scale", normalized];
  await adbText(serial, ["shell", ...args], mutation("settings put system font_scale"), deps);
  return getFontScale(serial, deps);
}

function nightModeFromRaw(raw: string): NightMode | "unknown" {
  const match = raw.match(/Night mode:\s*(\S+)/i);
  const value = (match?.[1] ?? raw).trim().toLowerCase();
  if (value === "yes") return "dark";
  if (value === "no") return "light";
  if (value === "auto") return "auto";
  return "unknown";
}

export async function getNightMode(
  serial: string,
  deps: AdbDeps = {},
): Promise<NightModeStatus> {
  const stdout = await adbText(
    serial,
    ["shell", "cmd", "uimode", "night"],
    query("cmd uimode night"),
    deps,
  );
  const raw = stdout.trim();
  return { mode: nightModeFromRaw(raw), raw };
}

export async function setNightMode(
  serial: string,
  mode: NightMode,
  deps: AdbDeps = {},
): Promise<NightModeStatus> {
  const value = mode === "dark" ? "yes" : mode === "light" ? "no" : "auto";
  const args = ["cmd", "uimode", "night", value];
  await adbText(serial, ["shell", ...args], mutation("cmd uimode night"), deps);
  return getNightMode(serial, deps);
}

async function globalSetting(
  serial: string,
  name: string,
  deps: AdbDeps,
): Promise<string> {
  const stdout = await adbText(
    serial,
    ["shell", "settings", "get", "global", name],
    query(`settings get global ${name}`),
    deps,
  );
  return stdout.trim();
}

function radioStatusFromSetting(raw: string): NetworkRadioStatus {
  if (raw === "1") return "enabled";
  if (raw === "0") return "disabled";
  return "unknown";
}

export async function getNetworkStatus(
  serial: string,
  deps: AdbDeps = {},
): Promise<NetworkStatus> {
  const [wifiRaw, mobileDataRaw] = await Promise.all([
    globalSetting(serial, "wifi_on", deps),
    globalSetting(serial, "mobile_data", deps),
  ]);
  const wifi = radioStatusFromSetting(wifiRaw);
  const mobileData = radioStatusFromSetting(mobileDataRaw);
  const radios = [wifi, mobileData];
  const knownRadios = radios.filter((radio) => radio !== "unknown");
  const enabled = knownRadios.length === 0 ? null : knownRadios.some((radio) => radio === "enabled");
  return {
    enabled,
    wifi,
    mobileData,
    raw: {
      wifi: wifiRaw,
      mobileData: mobileDataRaw,
    },
  };
}

export async function setNetworkEnabled(
  serial: string,
  enabled: boolean,
  deps: AdbDeps = {},
): Promise<NetworkStatus> {
  const action = enabled ? "enable" : "disable";
  for (const service of ["wifi", "data"]) {
    const args = ["svc", service, action];
    await adbText(serial, ["shell", ...args], mutation(`svc ${service} ${action}`), deps);
  }
  return getNetworkStatus(serial, deps);
}

// One /proc/net/unix read per probe; a busy device lists a few hundred lines.
const SCRCPY_SOCKET_PROBE_MAX_BYTES = 1024 * 1024;

/**
 * The scrcpy sessions on a device, by abstract socket name (`scrcpy_<scid>`,
 * or `scrcpy` for a client without a scid), read from `/proc/net/unix`. Only
 * connected sockets count: a session's server closes its listening socket
 * once its clients connect, while a listener left behind by a desktop scrcpy
 * that crashed before removing its `adb reverse` serves no one. A session's
 * connections share its name, so each session counts once.
 */
export function parseScrcpySocketNames(procNetUnix: string): string[] {
  const names = new Set<string>();
  for (const line of procNetUnix.split("\n")) {
    // Num RefCount Protocol Flags Type St Inode Path; St 03 is connected.
    const match =
      /^\S+:\s+\S+\s+\S+\s+\S+\s+\S+\s+03\s+\d+\s+@(scrcpy(?:_[0-9a-f]{8})?)\s*$/.exec(line);
    if (match) names.add(match[1]!);
  }
  return [...names].sort();
}

export async function listScrcpySockets(
  serial: string,
  deps: AdbDeps = {},
): Promise<string[]> {
  const stdout = await adbText(
    serial,
    ["shell", "cat", "/proc/net/unix"],
    {
      operation: "cat /proc/net/unix",
      timeout: ADB_QUERY_TIMEOUT_MS,
      maxBuffer: SCRCPY_SOCKET_PROBE_MAX_BYTES,
      lane: "background",
    },
    deps,
  );
  return parseScrcpySocketNames(stdout);
}
