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
  settings?: Pick<StartEmulatorOpts, "emulatorPath" | "gpu" | "window" | "hostCapture">;
  initialLaunch?: EmulatorLaunch;
}) {
  const {
    startEmulator: startEmulatorProcess,
    stopEmulator: stopEmulatorBySerial,
    settings = {},
  } = deps;
  const launchedEmulators = new Map<string, EmulatorLaunch>();
  const bootingEmulators = new Set<Promise<EmulatorLaunch>>();
  const stoppingEmulators = new Map<Promise<void>, string>();
  const emulatorShutdown = new AbortController();

  const stopForShutdown = (serial: string, stop: Promise<void>): Promise<void> =>
    stop.catch((err) => {
      console.error(`[emulator] could not stop ${serial}:`, err);
    });

  const registerLaunch = (launch: EmulatorLaunch): EmulatorLaunch => {
    let stopTask: Promise<void> | undefined;
    const forgetLaunch = () => {
      if (launchedEmulators.get(launch.serial) === owned) {
        launchedEmulators.delete(launch.serial);
      }
    };
    const owned: EmulatorLaunch = {
      ...launch,
      stop: () => {
        if (stopTask) return stopTask;
        const task = Promise.resolve()
          .then(() => launch.stop())
          .finally(() => {
            forgetLaunch();
            stoppingEmulators.delete(task);
          });
        stopTask = task;
        stoppingEmulators.set(task, launch.serial);
        return task;
      },
    };
    launchedEmulators.set(launch.serial, owned);
    // Once it exits on its own, its port may go to another AVD, which
    // /api/avds/stop and stop() must not treat as this launch.
    launch.proc?.once("exit", forgetLaunch);
    return owned;
  };

  const launchEmulator: typeof startEmulator = async (opts, runtime) => {
    emulatorShutdown.signal.throwIfAborted();
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, emulatorShutdown.signal])
      : emulatorShutdown.signal;
    const booting = startEmulatorProcess(
      { ...settings, ...opts, signal },
      runtime,
    ).then(async (launch) => {
      if (emulatorShutdown.signal.aborted) {
        if (launch.ownsProcess) {
          const stop = Promise.resolve().then(() => launch.stop());
          await stopForShutdown(launch.serial, stop);
        }
        throw emulatorShutdown.signal.reason;
      }
      return launch.ownsProcess ? registerLaunch(launch) : launch;
    });
    bootingEmulators.add(booting);
    try {
      return await booting;
    } finally {
      bootingEmulators.delete(booting);
    }
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
    for (const launch of launchedEmulators.values()) void launch.stop();
    launchedEmulators.clear();
    return Promise.all([
      ...Array.from(bootingEmulators, (launch) => launch.catch(() => {})),
      ...Array.from(stoppingEmulators, ([stop, serial]) =>
        stopForShutdown(serial, stop),
      ),
    ]).then(() => {});
  };

  const cameraImages = (serial: string) => {
    const launch = launchedEmulators.get(serial) ?? (deps.initialLaunch?.serial === serial && deps.initialLaunch.ownsProcess ? deps.initialLaunch : undefined);
    if (launch?.proc && (launch.proc.exitCode !== null || launch.proc.signalCode !== null)) return undefined;
    return launch?.cameras;
  };
  return { launchEmulator, killEmulator, shutdown, cameraImages };
}
