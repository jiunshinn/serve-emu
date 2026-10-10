import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
} from "node:child_process";
import type { Readable } from "node:stream";
import {
  CommandFailureError,
  type CommandFailureCode,
} from "./command-failure.ts";
import {
  ExecError,
  execText,
  type ExecOpts,
  type ExecResult,
} from "./exec.ts";

// Shared building blocks for running adb: short-lived commands through the
// bounded executor, long-running ones as child processes, one classifier for
// "the device is gone", and one way to stop a child process.

export type RunAdbOptions = Pick<ExecOpts, "timeout" | "maxBuffer" | "signal" | "lane"> & {
  execText?: typeof execText;
};

/**
 * A short-lived adb command through the bounded executor. `serial: null` runs
 * a host command such as `adb devices`.
 */
export function runAdb(
  serial: string | null,
  args: readonly string[],
  { execText: run = execText, ...opts }: RunAdbOptions = {},
): Promise<ExecResult<string>> {
  return run("adb", serial === null ? [...args] : ["-s", serial, ...args], opts);
}

export type AdbChild = ChildProcessByStdio<null, Readable, Readable>;

/** A long-running adb command (the scrcpy server, logcat) with piped output. */
export function spawnAdb(
  serial: string,
  args: readonly string[],
  run: typeof spawn = spawn,
): AdbChild {
  return run("adb", ["-s", serial, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  }) as AdbChild;
}

// adb's own client messages for a device it cannot reach, printed on stderr
// behind an "adb: " or "error: " prefix. Matched as whole phrases so a device
// command's output ("sh: pidof: not found", "package com.foo not found") never
// reads as a lost device.
const DEVICE_UNAVAILABLE_RE =
  /\bdevice offline\b|\bdevice unauthorized\b|\bdevice (?:'[^'\n]*' )?not found\b|\bno (?:devices\/emulators|devices|emulators) found\b/i;
// adb's "error: closed": the server dropped the connection to the device.
const CONNECTION_CLOSED_RE = /^(?:adb: )?error: closed\s*$/im;

type AdbStderr = { stderr?: string } | string;

function stderrOf(result: AdbStderr): string {
  return typeof result === "string" ? result : (result.stderr ?? "");
}

/**
 * Whether adb's stderr says its connection to the device closed
 * (`error: closed`). Right after another channel exits this can be a brief
 * transport race, so callers may retry it once before treating it as
 * {@link isDeviceUnavailable}.
 */
export function isConnectionClosed(result: AdbStderr): boolean {
  return CONNECTION_CLOSED_RE.test(stderrOf(result));
}

/**
 * Whether adb's stderr says the device itself is unavailable (offline,
 * unauthorized, not found, none attached, or its connection closed), as
 * opposed to the command failing on a reachable device. Only adb's own
 * messages count, and stdout is never read: it carries the command's data.
 */
export function isDeviceUnavailable(result: AdbStderr): boolean {
  const stderr = stderrOf(result);
  return DEVICE_UNAVAILABLE_RE.test(stderr) || CONNECTION_CLOSED_RE.test(stderr);
}

/** The parts of an adb command's result that say whether and how it failed. */
export type AdbOutcome = {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string;
  timedOut?: boolean;
  error?: Error | null;
};

export function adbSucceeded(result: AdbOutcome): boolean {
  return result.status === 0 && !result.error;
}

/**
 * Names an adb invocation by its subcommand (`adb push`, `adb shell mv`) so
 * paths and other arguments stay out of public messages. `args` must be
 * code-supplied: `args[1]` of a shell call is the command name.
 */
export function adbOperation(args: readonly string[]): string {
  return args[0] === "shell" ? `adb shell ${args[1]}` : `adb ${args[0]}`;
}

function execErrorCode(result: AdbOutcome): ExecError["code"] | null {
  return result.error instanceof ExecError ? result.error.code : null;
}

/**
 * Why an adb command failed: it ran out of time, was cancelled, printed more
 * than its output limit, could not reach the device, or failed on a device it
 * reached. The executor's own errors decide the first three; adb's stderr
 * decides whether the device was unavailable.
 */
export function adbFailureCode(result: AdbOutcome): CommandFailureCode {
  const execCode = execErrorCode(result);
  if (result.timedOut || execCode === "deadline-exceeded") return "adb-timeout";
  if (execCode === "aborted") return "adb-aborted";
  if (execCode === "output-limit") return "adb-output-limit";
  if (isDeviceUnavailable(result)) return "adb-device-unavailable";
  return "adb-failed";
}

const FAILURE_OUTCOMES: Record<CommandFailureCode, string> = {
  "adb-timeout": "timed out",
  "adb-aborted": "was cancelled",
  "adb-output-limit": "printed more output than allowed",
  "adb-device-unavailable": "failed: the device is unavailable",
  "adb-failed": "failed",
  "adb-cleanup-failed": "cleanup failed",
  "emulator-failed": "failed",
};

function failureDetail(result: AdbOutcome): string {
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  return (
    result.stderr?.trim() ||
    result.error?.message ||
    stdout ||
    `status ${result.status}`
  );
}

/**
 * Wraps a failed adb command. The public message names only `operation`,
 * which must not contain user input; adb's output and, when given, the full
 * code-supplied `command` stay in `message` for the server log.
 */
export function adbCommandFailure(
  operation: string,
  result: AdbOutcome,
  command?: string,
): CommandFailureError {
  const code = adbFailureCode(result);
  const detail = failureDetail(result);
  return new CommandFailureError(
    code,
    `${operation} ${FAILURE_OUTCOMES[code]}`,
    command ? `${command}: ${detail}` : detail,
    { cause: result.error ?? undefined },
  );
}

export type TerminateChildOptions = {
  /** Settles once the child has exited. */
  exited: Promise<unknown>;
  /** How long to wait after SIGTERM, and again after SIGKILL. */
  graceMs: number;
  /** For the error message, for example "scrcpy process". */
  label: string;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

/**
 * Stops a child process: SIGTERM, wait up to `graceMs` for it to exit, then
 * SIGKILL and wait up to `graceMs` again. Rejects if it still has not exited.
 * SIGTERM is sent synchronously, before the returned promise first awaits.
 */
export async function terminateChild(
  child: Pick<ChildProcess, "kill">,
  {
    exited,
    graceMs,
    label,
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = (timer) => clearTimeout(timer),
  }: TerminateChildOptions,
): Promise<void> {
  const exitedWithin = (ms: number) =>
    new Promise<boolean>((resolve) => {
      const timer = setTimer(() => resolve(false), ms);
      const done = () => {
        clearTimer(timer);
        resolve(true);
      };
      exited.then(done, done);
    });
  const errors: unknown[] = [];
  const signal = (name: NodeJS.Signals) => {
    try {
      child.kill(name);
    } catch (error) {
      errors.push(error);
    }
  };

  signal("SIGTERM");
  if (await exitedWithin(graceMs)) return;
  signal("SIGKILL");
  if (await exitedWithin(graceMs)) return;
  throw new AggregateError(errors, `${label} did not exit after SIGTERM and SIGKILL`);
}
