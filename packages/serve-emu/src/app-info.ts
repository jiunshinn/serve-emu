import { adbText, type AdbDeps } from "./adb-command.ts";
import { packagePids } from "./package-pids.ts";
import type { ForegroundApp } from "./shared/api-contracts.ts";

export type { ForegroundApp } from "./shared/api-contracts.ts";

function adbShell(
  serial: string,
  args: string[],
  timeout: number,
  deps: AdbDeps,
): Promise<string> {
  // args[0] is the shell command (dumpsys); later args may be a
  // client-supplied package name and stay out of the public message.
  return adbText(
    serial,
    ["shell", ...args],
    { operation: `adb shell ${args[0]}`, timeout },
    deps,
  );
}

function firstMatch(text: string, patterns: RegExp[]): RegExpMatchArray | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match;
  }
  return null;
}

function parseComponent(value: string): { packageName: string; activity: string | null } | null {
  const clean = value.trim().replace(/^\{|\}$/g, "");
  const component = clean.split(/\s+/).find((part) => part.includes("/")) ?? clean;
  const [packageName, activityRaw] = component.split("/", 2);
  if (!packageName || !/^[A-Za-z0-9_.]+$/.test(packageName)) return null;
  const activity = activityRaw
    ? activityRaw.startsWith(".")
      ? `${packageName}${activityRaw}`
      : activityRaw
    : null;
  return { packageName, activity };
}

async function foregroundComponent(
  serial: string,
  deps: AdbDeps,
): Promise<{ packageName: string; activity: string | null } | null> {
  const windowDump = await adbShell(serial, ["dumpsys", "window"], 5_000, deps);
  const windowMatch = firstMatch(windowDump, [
    /mCurrentFocus=Window\{[^}]*\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)\}/,
    /mFocusedApp=ActivityRecord\{[^}]*\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)\s/,
    /mInputMethodTarget=Window\{[^}]*\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)\}/,
  ]);
  if (windowMatch?.[1]) {
    const parsed = parseComponent(windowMatch[1]);
    if (parsed) return parsed;
  }

  const activityDump = await adbShell(
    serial,
    ["dumpsys", "activity", "activities"],
    5_000,
    deps,
  );
  const activityMatch = firstMatch(activityDump, [
    /topResumedActivity=ActivityRecord\{[^}]*\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)\s/,
    /mResumedActivity: ActivityRecord\{[^}]*\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)\s/,
    /ResumedActivity: ActivityRecord\{[^}]*\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)\s/,
  ]);
  return activityMatch?.[1] ? parseComponent(activityMatch[1]) : null;
}

async function packagePid(
  serial: string,
  packageName: string,
  deps: AdbDeps,
): Promise<number | null> {
  try {
    const [first] = await packagePids(serial, packageName, deps);
    return first ? Number(first) : null;
  } catch {
    return null;
  }
}

async function packageDetails(
  serial: string,
  packageName: string,
  deps: AdbDeps,
) {
  try {
    const dump = await adbShell(
      serial,
      ["dumpsys", "package", packageName],
      5_000,
      deps,
    );
    const versionName = dump.match(/versionName=([^\s]+)/)?.[1] ?? null;
    const versionCode = dump.match(/versionCode=(\d+)/)?.[1] ?? null;
    const label =
      dump.match(/application-label(?:-[a-zA-Z]+)?:'([^']+)'/)?.[1] ??
      dump.match(/labelRes=0x[0-9a-fA-F]+ nonLocalizedLabel=([^\n]+)/)?.[1]?.trim() ??
      null;
    const debuggable = /pkgFlags=\[[^\]]*\bDEBUGGABLE\b/.test(dump) || /\bDEBUGGABLE\b/.test(dump);
    return { label, versionName, versionCode, debuggable };
  } catch {
    return { label: null, versionName: null, versionCode: null, debuggable: null };
  }
}

export async function getForegroundApp(
  serial: string,
  deps: AdbDeps = {},
): Promise<ForegroundApp> {
  const component = await foregroundComponent(serial, deps);
  if (!component) {
    return {
      packageName: null,
      activity: null,
      pid: null,
      label: null,
      versionName: null,
      versionCode: null,
      debuggable: null,
    };
  }
  const [details, pid] = await Promise.all([
    packageDetails(serial, component.packageName, deps),
    packagePid(serial, component.packageName, deps),
  ]);
  return {
    packageName: component.packageName,
    activity: component.activity,
    pid,
    ...details,
  };
}
