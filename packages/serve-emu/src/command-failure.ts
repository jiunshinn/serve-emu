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

/**
 * Names an adb invocation by its subcommand (`adb push`, `adb shell mv`) so
 * paths and other arguments stay out of public messages. `args` must be
 * code-supplied: `args[1]` of a shell call is the command name.
 */
export function adbOperation(args: readonly string[]): string {
  return args[0] === "shell" ? `adb shell ${args[1]}` : `adb ${args[0]}`;
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

/** The command failure `err` is or wraps (through `cause`), if any. */
export function commandFailureOf(err: unknown): CommandFailureError | null {
  let current = err;
  for (let depth = 0; current instanceof Error && depth < 8; depth++) {
    if (current instanceof CommandFailureError) return current;
    current = current.cause;
  }
  return null;
}

/**
 * Logs a failed API request with its method, path, and the original error,
 * whose message and `cause` keep the detail the response leaves out. Only the
 * pathname is logged: the query string can carry the auth token.
 */
export function logApiFailure(
  request: Pick<Request, "method" | "url">,
  status: number,
  publicMessage: string,
  err: unknown,
): void {
  const path = new URL(request.url).pathname;
  console.error(
    `[api] ${request.method} ${path} -> ${status} ${publicMessage}:`,
    err,
  );
}
