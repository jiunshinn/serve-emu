import type { EmulatorLaunch } from "./emulator.ts";

type StoppableServer = { stop(): Promise<void> };

export type EmulatorExit = {
  serial: string;
  code: number | null;
  signal: NodeJS.Signals | null;
};

/**
 * What the CLI cleans up on SIGINT/SIGTERM or a failed start, including work
 * still in flight when the signal arrives: an `--avd` emulator that is still
 * booting and a server that is still starting.
 */
export class CliLifecycle<Server extends StoppableServer> {
  readonly #controller = new AbortController();
  #emulatorBoot: Promise<EmulatorLaunch> | null = null;
  #serverStartup: Promise<Server> | null = null;
  #stopping: Promise<void> | null = null;

  /** Aborted by `stop()`; pass it to the emulator launch and the server. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** Records the `--avd` launch from the moment it starts booting. */
  trackEmulator(boot: Promise<EmulatorLaunch>): Promise<EmulatorLaunch> {
    this.#emulatorBoot = boot;
    return boot;
  }

  /**
   * Calls `onExit` if the emulator this process launched exits on its own
   * while `deviceSerial()` still names it: the server has nothing left to
   * stream (#73). An exit during `stop()`, after the server moved to another
   * device, or after a client stopped that device on purpose is ignored. A
   * launch that attached to a running emulator has no child to watch.
   */
  watchEmulator(
    launch: EmulatorLaunch,
    deviceSerial: () => string | null,
    onExit: (exit: EmulatorExit) => void,
  ): void {
    const proc = launch.ownsProcess ? launch.proc : null;
    if (!proc) return;
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.signal.aborted || deviceSerial() !== launch.serial) return;
      onExit({ serial: launch.serial, code, signal });
    };
    // It may already have exited while the server was starting.
    if (proc.exitCode !== null || proc.signalCode !== null) {
      exited(proc.exitCode, proc.signalCode);
    } else {
      proc.once("exit", exited);
    }
  }

  trackServer(startup: Promise<Server>): Promise<Server> {
    this.#serverStartup = startup;
    return startup;
  }

  /**
   * Aborts `signal`, stops the server, then stops the emulator this process
   * launched, and resolves once both are done. A launch that is still booting
   * reacts to the abort by stopping its own child (SIGTERM, then SIGKILL after
   * the grace period) before it settles, so waiting for the boot keeps the
   * process alive until that emulator has exited.
   */
  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#controller.abort(new Error("serve-emu stopping"));
    this.#stopping = (async () => {
      try {
        const server = await this.#serverStartup?.catch(() => null);
        await server?.stop();
      } finally {
        const launch = await this.#emulatorBoot?.catch(() => null);
        await launch?.stop();
      }
    })();
    return this.#stopping;
  }
}
