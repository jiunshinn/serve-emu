import { setTimeout as sleep } from "node:timers/promises";
import type { DeviceContext } from "./types.ts";

const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 10_000;
const STABLE_STREAM_MS = 10_000;

/** Reopens the selected session after transport teardown, with one loop at a time. */
export function createDeviceRecovery(options: {
  current: () => DeviceContext;
  reopen: (failed: DeviceContext) => Promise<void>;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}) {
  const lifetime = new AbortController();
  const wait = options.wait ?? ((ms, signal) => sleep(ms, undefined, { signal }));
  const now = options.now ?? Date.now;
  let recovering: DeviceContext | null = null;
  let lastSerial: string | null = null;
  let delay = FIRST_RETRY_MS;

  const canRecover = (context: DeviceContext) =>
    !lifetime.signal.aborted && options.current() === context && !context.stoppedByClient;

  return {
    isRecovering(context: DeviceContext) {
      return recovering === context && canRecover(context);
    },
    start(context: DeviceContext, disposed: Promise<void>) {
      if (!canRecover(context) || recovering === context) return;
      if (context.serial !== lastSerial || now() - context.startedMs >= STABLE_STREAM_MS) {
        delay = FIRST_RETRY_MS;
      }
      lastSerial = context.serial;
      recovering = context;
      void (async () => {
        await disposed;
        while (canRecover(context)) {
          await wait(delay, lifetime.signal);
          if (!canRecover(context)) return;
          delay = Math.min(delay * 2, MAX_RETRY_MS);
          try {
            await options.reopen(context);
            return;
          } catch {
            // ADB may still be offline. Keep the terminal state and retry.
          }
        }
      })().catch(() => {
        // Shutdown aborts the pending wait.
      }).finally(() => {
        if (recovering === context) recovering = null;
      });
    },
    stop() {
      lifetime.abort();
    },
  };
}
