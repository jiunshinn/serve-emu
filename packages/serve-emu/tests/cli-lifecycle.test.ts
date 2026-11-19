import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { CliLifecycle } from "../src/cli-lifecycle.ts";
import { startEmulator, type EmulatorLaunch } from "../src/emulator.ts";
import type { execText } from "../src/exec.ts";

type StoppableServer = { stop(): Promise<void> };

function result(stdout = "") {
  return { status: 0, signal: null, stdout, stderr: "", timedOut: false, error: null };
}

/** An emulator child that ignores SIGTERM and exits only on SIGKILL. */
function stubbornEmulator() {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const proc = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null as NodeJS.Signals | null,
    kill(signal?: NodeJS.Signals | number) {
      signals.push(signal);
      if (signal === "SIGKILL") {
        queueMicrotask(() => {
          proc.signalCode = "SIGKILL";
          proc.emit("exit", null, "SIGKILL");
        });
      }
      return true;
    },
  });
  return { proc: proc as unknown as ChildProcess, signals };
}

describe("CLI lifecycle", () => {
  test("a signal during the boot wait stops the emulator before stop() resolves", async () => {
    const { proc, signals } = stubbornEmulator();
    let markSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const lifecycle = new CliLifecycle<StoppableServer>();
    const boot = lifecycle.trackEmulator(
      startEmulator(
        { avd: "Pixel_8", emulatorPath: "/sdk/emulator", signal: lifecycle.signal },
        {
          // The emulator never finishes booting.
          execText: (async (command) =>
            result(command === "/sdk/emulator" ? "Pixel_8\n" : "offline\n")) as typeof execText,
          listAllDevices: async () => [],
          spawn: (() => {
            markSpawned();
            return proc;
          }) as unknown as typeof spawn,
          // Shortens the 1 s poll and the 10 s grace period.
          sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
        },
      ),
    );
    void boot.catch(() => {});
    await spawned;

    await lifecycle.stop();
    // The process may exit right after stop() resolves, so the escalation
    // must already have happened.
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(proc.signalCode).toBe("SIGKILL");
    await expect(boot).rejects.toThrow("serve-emu stopping");
  });

  test("stops a server that is still starting, then the booted emulator, once", async () => {
    const events: string[] = [];
    const lifecycle = new CliLifecycle<StoppableServer>();
    const launch: EmulatorLaunch = {
      serial: "emulator-5554",
      proc: null,
      ownsProcess: true,
      stop: async () => {
        events.push("emulator stopped");
      },
    };
    lifecycle.trackEmulator(Promise.resolve(launch));
    let serverStarted!: (server: StoppableServer) => void;
    lifecycle.trackServer(
      new Promise<StoppableServer>((resolve) => {
        serverStarted = resolve;
      }),
    );

    const stopping = lifecycle.stop();
    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.stop()).toBe(stopping);
    serverStarted({
      stop: async () => {
        events.push("server stopped");
      },
    });
    await stopping;
    expect(events).toEqual(["server stopped", "emulator stopped"]);
  });
});
