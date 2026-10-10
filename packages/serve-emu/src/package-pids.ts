import { runAdb, type AdbDeps } from "./adb-command.ts";
import type { ExecLane } from "./exec.ts";
import { shellQuote } from "./shell-quote.ts";

export const PACKAGE_PID_LOOKUP_TIMEOUT_MS = 2_000;
export const PACKAGE_PID_LOOKUP_MAX_OUTPUT_BYTES = 64 * 1024;

/** Package or process name accepted by `pidof` (`com.example:remote`). */
const PROCESS_NAME_RE = /^[A-Za-z0-9_.:-]+$/;

export class PackagePidLookupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PackagePidLookupError";
  }
}

/**
 * Runs `pidof <package>` on the device through the bounded executor.
 *
 * Resolves with the running PIDs, which is empty when the package is not
 * running. Rejects with PackagePidLookupError when the lookup itself failed
 * (timeout, abort, queue-full, output limit, adb error), so callers can keep
 * their previous answer instead of mistaking the failure for "not running".
 */
export async function packagePids(
  serial: string,
  packageName: string,
  deps: AdbDeps & { lane?: ExecLane } = {},
): Promise<string[]> {
  if (!PROCESS_NAME_RE.test(packageName)) return [];
  const result = await runAdb(serial, ["shell", "pidof", shellQuote(packageName)], {
    timeout: PACKAGE_PID_LOOKUP_TIMEOUT_MS,
    maxBuffer: PACKAGE_PID_LOOKUP_MAX_OUTPUT_BYTES,
    lane: deps.lane,
    signal: deps.signal,
    execText: deps.execText,
  });
  if (result.error) {
    throw new PackagePidLookupError(`pidof ${packageName} failed: ${result.error.message}`, {
      cause: result.error,
    });
  }
  const pids = result.stdout.trim().split(/\s+/).filter((pid) => /^\d+$/.test(pid));
  // pidof exits 1 with no output when nothing matches. Anything else that is
  // not a clean exit is a failed lookup (for example, adb reporting the
  // device offline on stderr).
  if (result.status === 0 || (result.status === 1 && !result.stdout.trim() && !result.stderr.trim())) {
    return pids;
  }
  throw new PackagePidLookupError(
    `pidof ${packageName} failed: ${(result.stderr || result.stdout || `status ${result.status}`).trim()}`,
  );
}
