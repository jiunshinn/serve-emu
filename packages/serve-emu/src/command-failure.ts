import type { ExecResult } from "./exec.ts";

export type CommandFailureCode =
  | "adb-failed"
  | "adb-timeout"
  | "adb-cleanup-failed"
  | "emulator-failed";

/**
 * A device or host command (adb, emulator) that failed, timed out, or printed
 * something unexpected. `message` keeps the command's output for server logs;
 * API responses use `publicMessage`, which names the operation and never
 * includes output.
 */
export class CommandFailureError extends Error {
  constructor(
    readonly code: CommandFailureCode,
    readonly publicMessage: string,
    detail?: string,
    options?: { cause?: unknown },
  ) {
    super(detail ? `${publicMessage}: ${detail}` : publicMessage, options);
    this.name = "CommandFailureError";
  }
}

function resultDetail(result: ExecResult<string | Buffer>): string {
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  return (
    result.stderr.trim() || result.error?.message || stdout || "unknown error"
  );
}

/** Wraps a failed adb invocation; `operation` must not contain user input. */
export function adbCommandFailure(
  operation: string,
  result: ExecResult<string | Buffer>,
): CommandFailureError {
  return result.timedOut
    ? new CommandFailureError(
        "adb-timeout",
        `${operation} timed out`,
        resultDetail(result),
        { cause: result.error ?? undefined },
      )
    : new CommandFailureError(
        "adb-failed",
        `${operation} failed`,
        resultDetail(result),
        { cause: result.error ?? undefined },
      );
}

/** The message an API response or shared status may carry for `err`. */
export function publicErrorMessage(err: unknown): string {
  if (err instanceof CommandFailureError) return err.publicMessage;
  return err instanceof Error ? err.message : String(err);
}
