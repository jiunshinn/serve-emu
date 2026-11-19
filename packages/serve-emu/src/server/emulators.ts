import type {
  EmulatorLaunch,
  StartEmulatorOpts,
  startEmulator,
  stopEmulator,
} from "../emulator.ts";

/**
 * Emulators started through /api/avds/start belong to this server, like the
 * CLI's --avd launch belongs to the CLI: they stop when it stops.
 */
export function createEmulatorRegistry(deps: {
  startEmulator: typeof startEmulator;
  stopEmulator: typeof stopEmulator;
  /** The CLI's emulator binary, `-gpu`, and window, for every launch here. */
  settings?: Pick<StartEmulatorOpts, "emulatorPath" | "gpu" | "window">;
}) {
  const {
    startEmulator: startEmulatorProcess,
    stopEmulator: stopEmulatorBySerial,
    settings = {},
  } = deps;
  const launchedEmulators = new Map<string, EmulatorLaunch>();
  // Launches still booting; on stop they abort and stop their own child, and
  // stop() waits for that so the process cannot exit first.
  const bootingEmulators = new Set<Promise<unknown>>();
  const emulatorShutdown = new AbortController();

  const launchEmulator: typeof startEmulator = async (opts, runtime) => {
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, emulatorShutdown.signal])
      : emulatorShutdown.signal;
    const booting = startEmulatorProcess(
      { ...settings, ...opts, signal },
      runtime,
    );
    bootingEmulators.add(booting);
    let launch: EmulatorLaunch;
    try {
      launch = await booting;
    } finally {
      bootingEmulators.delete(booting);
    }
    if (!launch.ownsProcess) return launch;
    const owned: EmulatorLaunch = {
      ...launch,
      stop: async () => {
        if (launchedEmulators.get(launch.serial) === owned) {
          launchedEmulators.delete(launch.serial);
        }
        await launch.stop();
      },
    };
    launchedEmulators.set(launch.serial, owned);
    // Once it exits on its own, its port may go to another AVD, which
    // /api/avds/stop and stop() must not treat as this launch.
    launch.proc?.once("exit", () => {
      if (launchedEmulators.get(launch.serial) === owned) {
        launchedEmulators.delete(launch.serial);
      }
    });
    return owned;
  };

  const killEmulator: typeof stopEmulator = async (serial, adbDeps) => {
    const owned = launchedEmulators.get(serial);
    if (owned) return owned.stop();
    return stopEmulatorBySerial(serial, adbDeps);
  };

  /**
   * Aborts launches still booting and stops the emulators this server owns.
   * Resolves once every boot has settled and every owned emulator stopped;
   * a failed stop is logged, never thrown.
   */
  const shutdown = (): Promise<void> => {
    emulatorShutdown.abort(new Error("server is stopping"));
    const owned = Array.from(launchedEmulators.values());
    launchedEmulators.clear();
    const booting = Array.from(bootingEmulators, (launch) =>
      launch.catch(() => {}),
    );
    return Promise.all([
      ...booting,
      ...owned.map((launch) =>
        Promise.resolve()
          .then(() => launch.stop())
          .catch((err) => {
            console.error(`[emulator] could not stop ${launch.serial}:`, err);
          }),
      ),
    ]).then(() => {});
  };

  return { launchEmulator, killEmulator, shutdown };
}
