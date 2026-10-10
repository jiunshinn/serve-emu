import { randomBytes } from "node:crypto";
import {
  adbCommandFailure,
  adbOperation,
  adbSucceeded,
  runAdb,
  throwIfAdbAborted,
  type AdbDeps,
} from "./adb-command.ts";
import {
  CommandFailureError,
  type CommandFailureCode,
} from "./command-failure.ts";
import { shellQuote } from "./shell-quote.ts";
import type {
  AppActionResponse,
  FileImportResponse,
} from "./shared/api-contracts.ts";

export type AppActionResult = AppActionResponse;
export type FileImportResult = FileImportResponse;

export type LocalUploadFile = {
  path: string;
  filename: string;
  mediaType: string;
  size: number;
};

export type AppManagementErrorCode = Exclude<CommandFailureCode, "emulator-failed">;

export type AppManagementDependencies = AdbDeps & {
  uploadId?: () => string;
};

const PUBLIC_MESSAGES: Record<AppManagementErrorCode, string> = {
  "adb-failed": "adb command failed",
  "adb-timeout": "adb command timed out",
  "adb-aborted": "adb command was cancelled",
  "adb-output-limit": "adb command printed more output than allowed",
  "adb-device-unavailable": "adb command failed: the device is unavailable",
  "adb-cleanup-failed": "adb cleanup failed",
};

/** `message` is adb's own output; `publicMessage` is what clients see. */
export class AppManagementError extends CommandFailureError {
  declare readonly code: AppManagementErrorCode;

  constructor(
    code: AppManagementErrorCode,
    message: string,
    options?: { cause?: unknown; publicMessage?: string },
  ) {
    super(code, options?.publicMessage ?? PUBLIC_MESSAGES[code], undefined, {
      cause: options?.cause,
    });
    this.message = message;
    this.name = "AppManagementError";
  }
}

const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const PERMISSION_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const ACTIVITY_RE = /^([A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+|\.?[A-Za-z][A-Za-z0-9_.$]*)(\/[A-Za-z0-9_.$]+)?$/;

function output(stdout: string, stderr: string): string {
  return `${stdout}${stderr}`.trim();
}

async function adb(
  serial: string,
  args: string[],
  timeout: number,
  deps: AdbDeps,
): Promise<AppActionResult> {
  throwIfAdbAborted(deps.signal, "The operation was aborted");
  const result = await runAdb(serial, args, {
    timeout,
    signal: deps.signal,
    lane: "background",
    execText: deps.execText,
  });
  throwIfAdbAborted(deps.signal, "The operation was aborted");
  const text = output(result.stdout, result.stderr);
  if (!adbSucceeded(result)) {
    const failure = adbCommandFailure(adbOperation(args), result);
    const fallback = result.timedOut
      ? `adb ${args.join(" ")} timed out`
      : result.error?.message || `adb ${args.join(" ")} failed`;
    throw new AppManagementError(
      failure.code as AppManagementErrorCode,
      text || fallback,
      { cause: result.error ?? undefined, publicMessage: failure.publicMessage },
    );
  }
  return { ok: true, output: text };
}

function validate(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value.trim())) {
    throw new Error(`${name} is invalid`);
  }
  return value.trim();
}

export function packageName(value: unknown): string {
  return validate(value, "packageName", PACKAGE_RE);
}

export function activityName(value: unknown): string {
  return validate(value, "activity", ACTIVITY_RE);
}

export function permissionName(value: unknown): string {
  return validate(value, "permission", PERMISSION_RE);
}

export async function installApk(
  serial: string,
  file: LocalUploadFile,
  dependencies: AppManagementDependencies = {},
): Promise<AppActionResult> {
  if (!file.filename.toLowerCase().endsWith(".apk")) {
    throw new Error("APK file must end with .apk");
  }
  return adb(serial, ["install", "-r", file.path], 120_000, dependencies);
}

function safeFileName(name: string, fallback: string): string {
  const clean = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean && clean !== "." && clean !== ".." ? clean : fallback;
}

function mediaKind(file: LocalUploadFile): FileImportResult["kind"] {
  if (file.mediaType.startsWith("image/")) return "image";
  if (file.mediaType.startsWith("video/")) return "video";
  const lower = file.filename.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|heic|heif)$/.test(lower)) return "image";
  if (/\.(mp4|m4v|mov|webm|3gp|mkv)$/.test(lower)) return "video";
  return "file";
}

export async function importMediaFile(
  serial: string,
  file: LocalUploadFile,
  dependencies: AppManagementDependencies = {},
): Promise<FileImportResult> {
  const uploadId =
    dependencies.uploadId?.() ?? randomBytes(6).toString("hex");
  const filename = safeFileName(file.filename, `upload-${uploadId}`);
  const kind = mediaKind(file);
  const remoteDir =
    kind === "image" ? "/sdcard/Pictures" : kind === "video" ? "/sdcard/Movies" : "/sdcard/Download";
  const remotePath = `${remoteDir}/${filename}`;
  const partialPath = `${remoteDir}/.serve-emu-${uploadId}-${filename}.part`;
  let committed = false;
  let operationFailure: unknown;
  try {
    await adb(
      serial,
      ["shell", "mkdir", "-p", shellQuote(remoteDir)],
      30_000,
      dependencies,
    );
    await adb(serial, ["push", file.path, partialPath], 120_000, dependencies);
    await adb(
      serial,
      ["shell", "mv", "-f", shellQuote(partialPath), shellQuote(remotePath)],
      30_000,
      dependencies,
    );
    committed = true;
    await adb(serial, [
      "shell",
      "am",
      "broadcast",
      "-a",
      "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
      "-d",
      shellQuote(`file://${remotePath}`),
    ], 30_000, dependencies);
    return {
      ok: true,
      output: `Imported ${file.filename} to ${remotePath}`,
      path: remotePath,
      kind,
    };
  } catch (error) {
    operationFailure = error;
    throw error;
  } finally {
    if (!committed) {
      try {
        // Without the call's signal: an aborted import still removes its
        // partial file.
        await adb(
          serial,
          ["shell", "rm", "-f", shellQuote(partialPath)],
          5_000,
          { ...dependencies, signal: undefined },
        );
      } catch (cleanupError) {
        throw new AppManagementError(
          "adb-cleanup-failed",
          `failed to remove partial upload ${partialPath}`,
          {
            cause: new AggregateError(
              [operationFailure, cleanupError].filter(
                (error) => error !== undefined,
              ),
            ),
          },
        );
      }
    }
  }
}

export function launchApp(
  serial: string,
  packageNameValue: string,
  activity?: string,
  dependencies: AppManagementDependencies = {},
): Promise<AppActionResult> {
  const pkg = packageName(packageNameValue);
  if (activity) {
    const act = activityName(activity);
    const component = act.includes("/") ? act : `${pkg}/${act}`;
    return adb(
      serial,
      ["shell", "am", "start", "-n", shellQuote(component)],
      30_000,
      dependencies,
    );
  }
  return adb(
    serial,
    [
      "shell",
      "monkey",
      "-p",
      shellQuote(pkg),
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ],
    30_000,
    dependencies,
  );
}

export function clearAppData(
  serial: string,
  packageNameValue: string,
  dependencies: AppManagementDependencies = {},
): Promise<AppActionResult> {
  return adb(
    serial,
    ["shell", "pm", "clear", shellQuote(packageName(packageNameValue))],
    30_000,
    dependencies,
  );
}

export function forceStopApp(
  serial: string,
  packageNameValue: string,
  dependencies: AppManagementDependencies = {},
): Promise<AppActionResult> {
  return adb(
    serial,
    ["shell", "am", "force-stop", shellQuote(packageName(packageNameValue))],
    30_000,
    dependencies,
  );
}

export function grantPermission(
  serial: string,
  packageNameValue: string,
  permissionValue: string,
  dependencies: AppManagementDependencies = {},
): Promise<AppActionResult> {
  return adb(
    serial,
    [
      "shell",
      "pm",
      "grant",
      shellQuote(packageName(packageNameValue)),
      shellQuote(permissionName(permissionValue)),
    ],
    30_000,
    dependencies,
  );
}
