import type { DeviceService } from "../device-service.ts";
import type { RecoveryWatchdogClock } from "../session-recovery-watchdog.ts";
import type { DeviceContext } from "./types.ts";

// A streaming session checks its device for other scrcpy sessions (#76):
// first after one tick, so its own sockets exist, then every
// PROBE_EVERY_TICKS ticks (10 s). One bounded adb call per probe.
const PROBE_TICK_MS = 2_000;
const PROBE_EVERY_TICKS = 5;

/**
 * Counts the other scrcpy sessions on the session's device into
 * `context.contention`. `/health` only reads that field, so it never waits
 * on adb. The probe stops with the session and is aborted by its signal.
 */
export function startContentionProbe(
  context: DeviceContext,
  deps: {
    device: Pick<DeviceService, "scrcpySockets">;
    clock: RecoveryWatchdogClock;
  },
): void {
  const { device, clock } = deps;
  const ownSocket = `scrcpy_${context.scrcpy.scid}`;
  let ticks = 0;
  let inFlight = false;
  const tick = () => {
    if (ticks++ % PROBE_EVERY_TICKS !== 0) return;
    if (inFlight || context.signal.aborted || context.status !== "streaming") {
      return;
    }
    inFlight = true;
    const probe = device
      .scrcpySockets(context.serial, context.signal)
      .then((sockets) => {
        if (context.signal.aborted) return;
        context.contention = {
          otherScrcpySessions: sockets.filter((name) => name !== ownSocket)
            .length,
          checkedAt: new Date(clock.now()).toISOString(),
        };
      })
      // A failed probe keeps the last answer.
      .catch(() => {})
      .finally(() => {
        inFlight = false;
      });
    void context.trackDrain(probe).catch(() => {});
  };
  const timer = clock.setInterval(tick, PROBE_TICK_MS);
  context.registerCleanup(() => clock.clearInterval(timer));
}
