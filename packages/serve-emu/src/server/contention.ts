import type { DeviceService } from "../device-service.ts";
import type { RecoveryWatchdogClock } from "../session-recovery-watchdog.ts";
import type { DeviceContext } from "./types.ts";

/** Another scrcpy session already encodes the device's screen. */
export class DeviceInUseError extends Error {
  constructor(serial: string, readonly otherSessions: number) {
    super(
      `${serial} is already streamed by another scrcpy session (another serve-emu or scrcpy). ` +
        "Stop it, or start serve-emu with --allow-shared-device.",
    );
    this.name = "DeviceInUseError";
  }
}

/**
 * Refuses to open a stream on a device that another scrcpy session already
 * encodes. `ownSockets` holds the socket names of every session this server
 * opened, so its own sessions, including ones still closing, never count.
 * A failed probe lets the open go ahead: starting scrcpy reports a device
 * that adb cannot reach.
 */
export async function assertDeviceNotShared(
  serial: string,
  device: Pick<DeviceService, "scrcpySockets">,
  ownSockets: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<void> {
  let sockets: string[];
  try {
    sockets = await device.scrcpySockets(serial, signal);
  } catch {
    signal.throwIfAborted();
    return;
  }
  const others = sockets.filter((name) => !ownSockets.has(name)).length;
  if (others > 0) throw new DeviceInUseError(serial, others);
}

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
