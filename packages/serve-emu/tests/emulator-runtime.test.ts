import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import {
  clearEmulatorResolutionCache,
  listAvds,
  listRunningAvds,
  listWebcams,
  resolveEmulator,
  resolveRunningAvds,
  startEmulator,
  stopEmulator,
  type EmulatorRuntimeDependencies,
} from "../src/emulator.ts";
import type { execText } from "../src/exec.ts";

type ResultOptions = {
  status?: number | null;
  stderr?: string;
  error?: Error | null;
};

function result(
  stdout = "",
  { status = 0, stderr = "", error = null }: ResultOptions = {},
) {
  return {
    status,
    signal: null,
    stdout,
    stderr,
    timedOut: false,
    error,
  };
}

function fakeProcess(options: {
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  throwOnKill?: boolean;
  /** Signals the fake exits on; an emulator that ignores SIGTERM uses ["SIGKILL"]. */
  exitOn?: NodeJS.Signals[];
} = {}) {
  const killSignals: Array<NodeJS.Signals | number | undefined> = [];
  const exitOn = options.exitOn ?? ["SIGTERM", "SIGKILL"];
  const proc = Object.assign(new EventEmitter(), {
    exitCode: options.exitCode ?? null,
    signalCode: options.signalCode ?? null,
    kill(this: EventEmitter & { signalCode: NodeJS.Signals | null }, signal?: NodeJS.Signals | number) {
      killSignals.push(signal);
      if (options.throwOnKill) throw new Error("kill failed");
      if (typeof signal === "string" && exitOn.includes(signal)) {
        queueMicrotask(() => {
          this.signalCode = signal;
          this.emit("exit", null, signal);
        });
      }
      return true;
    },
  }) as unknown as ChildProcess;
  /** The emulator exiting on its own, as when the user closes its window. */
  const exit = (code = 0) => {
    Object.assign(proc, { exitCode: code });
    proc.emit("exit", code, null);
  };
  return { proc, killSignals, exit };
}

function bootedExec(adbCalls: string[] = []) {
  return (async (command, args) => {
    if (command === "/sdk/emulator") return result("Pixel_8\n");
    const adbCommand = args.slice(2).join(" ");
    adbCalls.push(adbCommand);
    if (adbCommand === "get-state") return result("device\n");
    if (adbCommand === "shell getprop sys.boot_completed") return result("1\n");
    if (adbCommand === "emu avd name") return result("Pixel_8\nOK\n");
    return result("");
  }) as typeof execText;
}

function spawnWith(proc: ChildProcess, calls: unknown[][] = []) {
  return ((command: string, args: string[], options: unknown) => {
    calls.push([command, args, options]);
    return proc;
  }) as unknown as typeof spawn;
}

afterEach(() => clearEmulatorResolutionCache());

describe("emulator resolution and listing", () => {
  test("accepts an EPIPE PATH probe and searches unique SDK candidates in order", async () => {
    const epipe = (async () =>
      result("", { status: null, error: new Error("write EPIPE") })) as typeof execText;
    await expect(
      resolveEmulator(undefined, {
        execText: epipe,
        env: { PATH: "/bin" } as NodeJS.ProcessEnv,
      }),
    ).resolves.toBe("emulator");

    clearEmulatorResolutionCache();
    const checked: string[] = [];
    const missing = (async () =>
      result("", { status: null, error: new Error("ENOENT") })) as typeof execText;
    await expect(
      resolveEmulator(undefined, {
        execText: missing,
        env: {
          PATH: "/bin",
          ANDROID_HOME: "/sdk",
          ANDROID_SDK_ROOT: "/sdk",
          HOME: "/home/test",
        } as NodeJS.ProcessEnv,
        existsSync: (candidate) => {
          checked.push(candidate.toString());
          return candidate === "/sdk/tools/emulator";
        },
      }),
    ).resolves.toBe("/sdk/tools/emulator");
    expect(checked).toEqual([
      "/sdk/emulator/emulator",
      "/sdk/tools/emulator",
    ]);
  });

  test("lists trimmed AVD names and surfaces every useful failure detail", async () => {
    const calls: unknown[][] = [];
    const successful = (async (command, args, options) => {
      calls.push([command, args, options]);
      return result(" Pixel_8 \r\n\r\nTablet\n");
    }) as typeof execText;
    await expect(
      listAvds("/sdk/emulator", { execText: successful }),
    ).resolves.toEqual(["Pixel_8", "Tablet"]);
    expect(calls).toEqual([
      [
        "/sdk/emulator",
        ["-list-avds"],
        { timeout: 5_000, maxBuffer: 1024 * 1024 },
      ],
    ]);

    const processError = new Error("spawn failed");
    const failures = [
      [result("stdout", { status: 1, stderr: "stderr" }), "stderr"],
      [result("stdout", { status: null, error: processError }), "spawn failed"],
      [result(" stdout ", { status: 1 }), "stdout"],
      [result("", { status: 1 }), "unknown error"],
    ] as const;
    for (const [failedResult, detail] of failures) {
      const failed = (async () => failedResult) as typeof execText;
      await expect(
        listAvds("/sdk/emulator", { execText: failed }),
      ).rejects.toThrow(`emulator -list-avds failed: ${detail}`);
    }
  });

  test("omits emulators whose console and boot property expose no AVD name", async () => {
    const runExec = (async (_command, args) =>
      args.includes("emu")
        ? result("OK\nKO: unavailable\n")
        : result("   \n")) as typeof execText;
    const devices = [
      { serial: "physical-1", state: "device" },
      { serial: "emulator-5554", state: "offline" },
    ];
    await expect(resolveRunningAvds(devices, runExec)).resolves.toEqual([]);
    await expect(
      listRunningAvds(undefined, {
        execText: runExec,
        listAllDevices: async () => devices,
      }),
    ).resolves.toEqual([]);
  });
});

describe("emulator lifecycle", () => {
  test("reuses an already-running matching AVD without spawning a process", async () => {
    const runExec = (async (command, args) => {
      if (command === "/sdk/emulator") return result("Pixel_8\n");
      if (args.includes("emu")) return result("Pixel_8\nOK\n");
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    }) as typeof execText;
    let spawns = 0;
    const dependencies: EmulatorRuntimeDependencies = {
      execText: runExec,
      listAllDevices: async () => [
        { serial: "emulator-5554", state: "device" },
      ],
      spawn: (() => {
        spawns++;
        throw new Error("should not spawn");
      }) as unknown as typeof spawn,
    };

    const launch = await startEmulator(
      { avd: "@Pixel_8", emulatorPath: "/sdk/emulator" },
      dependencies,
    );
    expect(launch.serial).toBe("emulator-5554");
    expect(launch.proc).toBeNull();
    expect(launch.ownsProcess).toBe(false);
    launch.stop();
    expect(spawns).toBe(0);
  });

  test("chooses a free even port, boots with GPU arguments, and stops idempotently", async () => {
    const adbCalls: string[] = [];
    const runExec = (async (command, args) => {
      if (command === "/sdk/emulator") return result("Pixel_8\n");
      const adbCommand = args.slice(2).join(" ");
      adbCalls.push(adbCommand);
      if (adbCommand === "get-state") return result("device\n");
      if (adbCommand === "shell getprop sys.boot_completed") return result("1\n");
      if (adbCommand === "emu avd name") return result("Pixel_8\nOK\n");
      if (adbCommand === "emu kill") return result("");
      throw new Error(`unexpected adb command: ${adbCommand}`);
    }) as typeof execText;
    let deviceReads = 0;
    const readDevices = async () => {
      deviceReads++;
      return deviceReads === 1
        ? [{ serial: "physical-1", state: "device" }]
        : [
            { serial: "emulator-5554", state: "device" },
            { serial: "emulator-5556", state: "offline" },
          ];
    };
    const { proc, killSignals } = fakeProcess();
    const spawnCalls: unknown[][] = [];
    const launch = await startEmulator(
      { avd: "Pixel_8", emulatorPath: "/sdk/emulator", gpu: "host" },
      {
        execText: runExec,
        listAllDevices: readDevices,
        spawn: spawnWith(proc, spawnCalls),
      },
    );

    expect(launch.serial).toBe("emulator-5558");
    expect(launch.proc).toBe(proc);
    expect(launch.ownsProcess).toBe(true);
    expect(spawnCalls).toEqual([
      [
        "/sdk/emulator",
        ["@Pixel_8", "-port", "5558", "-gpu", "host"],
        { stdio: ["ignore", "inherit", "inherit"] },
      ],
    ]);
    await Promise.all([launch.stop(), launch.stop()]);
    expect(adbCalls.filter((call) => call === "emu kill")).toHaveLength(1);
    expect(killSignals).toEqual(["SIGTERM"]);
  });

  test("restarts an existing AVD after it exits", async () => {
    const commands: string[] = [];
    const runExec = (async (command, args) => {
      if (command === "/sdk/emulator") return result("Pixel_8\n");
      const adbCommand = args.slice(2).join(" ");
      commands.push(`${args[1]} ${adbCommand}`);
      if (adbCommand === "emu avd name") return result("Pixel_8\nOK\n");
      if (adbCommand === "emu kill") return result("");
      if (adbCommand === "get-state") return result("device\n");
      if (adbCommand === "shell getprop sys.boot_completed") return result("1\n");
      throw new Error(`unexpected adb command: ${adbCommand}`);
    }) as typeof execText;
    let deviceReads = 0;
    const { proc } = fakeProcess();
    const launch = await startEmulator(
      {
        avd: "Pixel_8",
        emulatorPath: "/sdk/emulator",
        port: 5560,
        restartAvd: true,
      },
      {
        execText: runExec,
        listAllDevices: async () => {
          deviceReads++;
          return deviceReads === 1
            ? [{ serial: "emulator-5554", state: "device" }]
            : [];
        },
        spawn: spawnWith(proc),
      },
    );
    expect(launch.serial).toBe("emulator-5560");
    expect(commands).toContain("emulator-5554 emu kill");
    // Running-AVD lookup, wait for the old one to exit, explicit-port check.
    expect(deviceReads).toBe(3);
  });

  test("does not spawn a replacement while the old emulator is still registered", async () => {
    const runExec = (async (command, args) => {
      if (command === "/sdk/emulator") return result("Pixel_8\n");
      if (args.includes("name")) return result("Pixel_8\nOK\n");
      return result("");
    }) as typeof execText;
    let now = 0;
    let spawns = 0;

    await expect(
      startEmulator(
        {
          avd: "Pixel_8",
          emulatorPath: "/sdk/emulator",
          restartAvd: true,
        },
        {
          execText: runExec,
          listAllDevices: async () => [
            { serial: "emulator-5554", state: "device" },
          ],
          now: () => now,
          sleep: async (delay) => {
            now += delay;
          },
          spawn: (() => {
            spawns++;
            throw new Error("should not spawn");
          }) as unknown as typeof spawn,
        },
      ),
    ).rejects.toMatchObject({
      code: "emulator-failed",
      message: "Timed out waiting for emulator-5554 to stop.",
    });
    expect(spawns).toBe(0);
  });

  test("rejects unknown AVDs, invalid ports, and exhausted port ranges", async () => {
    const listOnly = (async (command) =>
      command === "/sdk/emulator" ? result("Pixel_8\n") : result("")) as typeof execText;
    await expect(
      startEmulator(
        { avd: "Missing", emulatorPath: "/sdk/emulator" },
        { execText: listOnly },
      ),
    ).rejects.toThrow('Unknown AVD "Missing". Available AVDs: Pixel_8');

    const emptyList = (async () => result("\n")) as typeof execText;
    await expect(
      startEmulator(
        { avd: "Missing", emulatorPath: "/sdk/emulator" },
        { execText: emptyList },
      ),
    ).rejects.toThrow('Available AVDs: (none)');

    for (const port of [5553, 5555, 5684, 5554.5]) {
      await expect(
        startEmulator(
          { avd: "Pixel_8", emulatorPath: "/sdk/emulator", port },
          {
            execText: listOnly,
            listAllDevices: async () => [],
          },
        ),
      ).rejects.toThrow(
        "--emulator-port must be an even integer from 5554 through 5682.",
      );
    }

    let deviceReads = 0;
    await expect(
      startEmulator(
        { avd: "Pixel_8", emulatorPath: "/sdk/emulator" },
        {
          execText: listOnly,
          listAllDevices: async () => {
            deviceReads++;
            return deviceReads === 1
              ? []
              : Array.from({ length: 65 }, (_, index) => ({
                  serial: `emulator-${5554 + index * 2}`,
                  state: "device",
                }));
          },
        },
      ),
    ).rejects.toThrow("No available emulator console ports");
  });

  test("cleans up when boot times out or the emulator exits early", async () => {
    const runFailure = async (proc: ChildProcess, runExec: typeof execText) => {
      let now = 0;
      return startEmulator(
        {
          avd: "Pixel_8",
          emulatorPath: "/sdk/emulator",
          port: 5554,
          bootTimeoutMs: 2,
        },
        {
          execText: runExec,
          listAllDevices: async () => [],
          spawn: spawnWith(proc),
          now: () => now,
          sleep: async (delay) => {
            now += delay;
          },
        },
      );
    };

    const timeoutProcess = fakeProcess();
    const timeoutAdbCalls: string[] = [];
    const timeoutExec = (async (command, args) => {
      if (command === "/sdk/emulator") return result("Pixel_8\n");
      timeoutAdbCalls.push(args.slice(2).join(" "));
      if (args.includes("get-state")) return result("offline\n");
      return result("", { status: 1 });
    }) as typeof execText;
    // Emulator failures are command failures, which the API reports as 502.
    await expect(runFailure(timeoutProcess.proc, timeoutExec)).rejects.toMatchObject({
      name: "CommandFailureError",
      code: "emulator-failed",
      message: "Timed out waiting for emulator-5554 to boot.",
    });
    expect(timeoutProcess.killSignals).toEqual(["SIGTERM"]);
    // The AVD on the port was never confirmed, so `emu kill` could reach
    // someone else's emulator.
    expect(timeoutAdbCalls).toContain("get-state");
    expect(timeoutAdbCalls).not.toContain("emu kill");

    const exitedProcess = fakeProcess({ exitCode: 9, throwOnKill: true });
    const exitExec = (async (command) =>
      command === "/sdk/emulator"
        ? result("Pixel_8\n")
        : result("", { status: 1 })) as typeof execText;
    await expect(runFailure(exitedProcess.proc, exitExec)).rejects.toMatchObject({
      name: "CommandFailureError",
      code: "emulator-failed",
      message: "emulator exited before boot completed (code 9)",
    });
  });

  test("reports a failed spawn as an emulator failure that names no host path", async () => {
    const { proc } = fakeProcess();
    const spawnFailure = new Error("spawn /home/me/sdk/emulator ENOENT");
    const failure = await startEmulator(
      {
        avd: "Pixel_8",
        emulatorPath: "/sdk/emulator",
        port: 5554,
        bootTimeoutMs: 1_000,
      },
      {
        execText: (async (command) =>
          command === "/sdk/emulator"
            ? result("Pixel_8\n")
            : result("offline\n")) as typeof execText,
        listAllDevices: async () => [],
        spawn: (() => {
          setTimeout(() => proc.emit("error", spawnFailure), 0);
          return proc;
        }) as unknown as typeof spawn,
        sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
      },
    ).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(failure).toMatchObject({
      name: "CommandFailureError",
      code: "emulator-failed",
      publicMessage: "emulator could not start",
      cause: spawnFailure,
    });
  });

  test("rejects an explicit port another emulator already uses, before spawning", async () => {
    const adbCalls: string[] = [];
    const runExec = (async (command, args) => {
      if (command === "/sdk/emulator") return result("Pixel_8\nTablet\n");
      const adbCommand = args.slice(2).join(" ");
      adbCalls.push(`${args[1]} ${adbCommand}`);
      if (adbCommand === "emu avd name") return result("Tablet\nOK\n");
      return result("");
    }) as typeof execText;
    let spawns = 0;
    await expect(
      startEmulator(
        { avd: "Pixel_8", emulatorPath: "/sdk/emulator", port: 5554 },
        {
          execText: runExec,
          listAllDevices: async () => [{ serial: "emulator-5554", state: "device" }],
          spawn: (() => {
            spawns++;
            throw new Error("should not spawn");
          }) as unknown as typeof spawn,
        },
      ),
    ).rejects.toThrow('--emulator-port 5554 is already in use by emulator-5554 (AVD "Tablet")');
    expect(spawns).toBe(0);
    expect(adbCalls.some((call) => call.endsWith("emu kill"))).toBe(false);
  });

  test("refuses another AVD that answers on the launch port and never kills it", async () => {
    const adbCalls: string[] = [];
    const runExec = (async (command, args) => {
      if (command === "/sdk/emulator") return result("Pixel_8\nTablet\n");
      const adbCommand = args.slice(2).join(" ");
      adbCalls.push(`${args[1]} ${adbCommand}`);
      if (adbCommand === "get-state") return result("device\n");
      if (adbCommand === "shell getprop sys.boot_completed") return result("1\n");
      if (adbCommand === "emu avd name") return result("Tablet\nOK\n");
      return result("");
    }) as typeof execText;
    const { proc, killSignals } = fakeProcess();
    let reads = 0;
    await expect(
      startEmulator(
        { avd: "Pixel_8", emulatorPath: "/sdk/emulator", port: 5556 },
        {
          execText: runExec,
          // The other emulator registers with adb only after the port check.
          listAllDevices: async () =>
            ++reads <= 2 ? [] : [{ serial: "emulator-5556", state: "device" }],
          spawn: spawnWith(proc),
        },
      ),
    ).rejects.toThrow(
      'emulator-5556 is running AVD "Tablet", not "Pixel_8"; AVD "Tablet" was left running.',
    );
    expect(adbCalls.some((call) => call.endsWith("emu kill"))).toBe(false);
    expect(killSignals).toEqual(["SIGTERM"]);
  });

  test("keeps polling while the booted device's AVD name cannot be read yet", async () => {
    let nameReads = 0;
    const runExec = (async (command, args) => {
      if (command === "/sdk/emulator") return result("Pixel_8\n");
      const adbCommand = args.slice(2).join(" ");
      if (adbCommand === "get-state") return result("device\n");
      if (adbCommand === "shell getprop sys.boot_completed") return result("1\n");
      if (adbCommand === "emu avd name") {
        // Both lookups fail on the first poll, as an adb timeout would.
        return ++nameReads === 1
          ? result("", { status: null, error: new Error("timed out") })
          : result("Pixel_8\nOK\n");
      }
      return result("", { status: null, error: new Error("timed out") });
    }) as typeof execText;
    const { proc, killSignals } = fakeProcess();
    let now = 0;
    const launch = await startEmulator(
      { avd: "Pixel_8", emulatorPath: "/sdk/emulator", port: 5554 },
      {
        execText: runExec,
        listAllDevices: async () => [],
        spawn: spawnWith(proc),
        now: () => now,
        sleep: async (delay) => {
          now += delay;
        },
      },
    );
    expect(launch.serial).toBe("emulator-5554");
    expect(launch.ownsProcess).toBe(true);
    expect(nameReads).toBe(2);
    expect(killSignals).toEqual([]);
  });

  test("times out without emu kill when the booted device never reports its AVD", async () => {
    const adbCalls: string[] = [];
    const runExec = (async (command, args) => {
      if (command === "/sdk/emulator") return result("Pixel_8\n");
      const adbCommand = args.slice(2).join(" ");
      adbCalls.push(adbCommand);
      if (adbCommand === "get-state") return result("device\n");
      if (adbCommand === "shell getprop sys.boot_completed") return result("1\n");
      return result("", { status: null, error: new Error("timed out") });
    }) as typeof execText;
    const { proc, killSignals } = fakeProcess();
    let now = 0;
    await expect(
      startEmulator(
        {
          avd: "Pixel_8",
          emulatorPath: "/sdk/emulator",
          port: 5554,
          bootTimeoutMs: 3_000,
        },
        {
          execText: runExec,
          listAllDevices: async () => [],
          spawn: spawnWith(proc),
          now: () => now,
          sleep: async (delay) => {
            now += delay;
          },
        },
      ),
    ).rejects.toThrow(
      'Timed out waiting for emulator-5554 to report AVD "Pixel_8": it booted, but its AVD name could not be read.',
    );
    expect(adbCalls.filter((call) => call === "emu avd name")).toHaveLength(3);
    expect(adbCalls).not.toContain("emu kill");
    expect(killSignals).toEqual(["SIGTERM"]);
  });

  test("concurrent launches pick different ports", async () => {
    let releaseBoot!: () => void;
    const booted = new Promise<void>((resolve) => {
      releaseBoot = resolve;
    });
    const runExec = (async (command, args) => {
      if (command === "/sdk/emulator") return result("Pixel_8\nTablet\n");
      const adbCommand = args.slice(2).join(" ");
      if (adbCommand === "get-state") {
        await booted;
        return result("device\n");
      }
      if (adbCommand === "shell getprop sys.boot_completed") return result("1\n");
      if (adbCommand === "emu avd name") {
        return result(args[1] === "emulator-5554" ? "Pixel_8\nOK\n" : "Tablet\nOK\n");
      }
      return result("");
    }) as typeof execText;
    const spawnCalls: unknown[][] = [];
    const dependencies = {
      execText: runExec,
      listAllDevices: async () => [],
      spawn: spawnWith(fakeProcess().proc, spawnCalls),
    };
    const first = startEmulator({ avd: "Pixel_8", emulatorPath: "/sdk/emulator" }, dependencies);
    const second = startEmulator({ avd: "Tablet", emulatorPath: "/sdk/emulator" }, dependencies);
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseBoot();
    const launches = await Promise.all([first, second]);
    expect(launches.map((launch) => launch.serial).sort()).toEqual([
      "emulator-5554",
      "emulator-5556",
    ]);
    expect(spawnCalls.map((call) => (call[1] as string[])[2]).sort()).toEqual([
      "5554",
      "5556",
    ]);
  });

  test("aborting during boot stops the spawned emulator without emu kill", async () => {
    const adbCalls: string[] = [];
    const runExec = (async (command, args) => {
      if (command === "/sdk/emulator") return result("Pixel_8\n");
      adbCalls.push(args.slice(2).join(" "));
      return result("offline\n");
    }) as typeof execText;
    const { proc, killSignals } = fakeProcess();
    const controller = new AbortController();
    const launching = startEmulator(
      { avd: "Pixel_8", emulatorPath: "/sdk/emulator", signal: controller.signal },
      {
        execText: runExec,
        listAllDevices: async () => [],
        spawn: spawnWith(proc),
        sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new Error("serve-emu stopping"));
    await expect(launching).rejects.toThrow("serve-emu stopping");
    expect(killSignals).toEqual(["SIGTERM"]);
    expect(adbCalls).not.toContain("emu kill");
  });

  test("escalates to SIGKILL when the emulator ignores SIGTERM", async () => {
    const runExec = (async (command, args) => {
      if (command === "/sdk/emulator") return result("Pixel_8\n");
      const adbCommand = args.slice(2).join(" ");
      if (adbCommand === "get-state") return result("device\n");
      if (adbCommand === "shell getprop sys.boot_completed") return result("1\n");
      if (adbCommand === "emu avd name") return result("Pixel_8\nOK\n");
      return result("");
    }) as typeof execText;
    const { proc, killSignals } = fakeProcess({ exitOn: ["SIGKILL"] });
    const pauses: number[] = [];
    const launch = await startEmulator(
      { avd: "Pixel_8", emulatorPath: "/sdk/emulator" },
      {
        execText: runExec,
        listAllDevices: async () => [],
        spawn: spawnWith(proc),
        sleep: async (delay) => {
          pauses.push(delay);
        },
      },
    );
    await launch.stop();
    expect(killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(pauses).toContain(10_000);
  });

  test("does not emu kill a launched emulator that already exited", async () => {
    const adbCalls: string[] = [];
    const { proc, killSignals, exit } = fakeProcess();
    const launch = await startEmulator(
      { avd: "Pixel_8", emulatorPath: "/sdk/emulator", port: 5556 },
      {
        execText: bootedExec(adbCalls),
        listAllDevices: async () => [],
        spawn: spawnWith(proc),
      },
    );
    // The user closed it; another AVD may own emulator-5556 by now.
    exit(0);
    await launch.stop();
    expect(adbCalls).not.toContain("emu kill");
    expect(killSignals).toEqual([]);
  });

  test("cancels the grace-period timer once the emulator exits", async () => {
    const { proc, killSignals } = fakeProcess();
    const waits: Array<{ delay: number; signal?: AbortSignal }> = [];
    const launch = await startEmulator(
      { avd: "Pixel_8", emulatorPath: "/sdk/emulator" },
      {
        execText: bootedExec(),
        listAllDevices: async () => [],
        spawn: spawnWith(proc),
        // Like a real timer, it settles only when the delay ends or is aborted.
        sleep: (delay, _value, options) => {
          waits.push({ delay, signal: options?.signal });
          return new Promise(() => {});
        },
      },
    );
    await launch.stop();
    expect(killSignals).toEqual(["SIGTERM"]);
    const grace = waits.find((wait) => wait.delay === 10_000);
    expect(grace?.signal?.aborted).toBe(true);
  });

  test("aborting while the old emulator shuts down stops waiting, without spawning", async () => {
    const runExec = (async (command, args) => {
      if (command === "/sdk/emulator") return result("Pixel_8\n");
      if (args.includes("name")) return result("Pixel_8\nOK\n");
      return result("");
    }) as typeof execText;
    const controller = new AbortController();
    let now = 0;
    let spawns = 0;
    await expect(
      startEmulator(
        {
          avd: "Pixel_8",
          emulatorPath: "/sdk/emulator",
          restartAvd: true,
          signal: controller.signal,
        },
        {
          execText: runExec,
          // The old emulator never leaves adb's list.
          listAllDevices: async () => [{ serial: "emulator-5554", state: "device" }],
          now: () => now,
          sleep: async (delay) => {
            now += delay;
            controller.abort(new Error("serve-emu stopping"));
          },
          spawn: (() => {
            spawns++;
            throw new Error("should not spawn");
          }) as unknown as typeof spawn,
        },
      ),
    ).rejects.toThrow("serve-emu stopping");
    expect(now).toBe(500);
    expect(spawns).toBe(0);
  });

  test("reports stop failures", async () => {
    const successful = (async () => result("")) as typeof execText;
    await expect(stopEmulator("emulator-5554", successful)).resolves.toBeUndefined();

    const failed = (async () =>
      result("", { status: 1, stderr: "console unavailable" })) as typeof execText;
    await expect(stopEmulator("emulator-5554", failed)).rejects.toThrow(
      "adb emu kill failed: console unavailable",
    );
  });
});

const WEBCAM_LIST = [
  "List of web cameras connected to the computer:",
  " Camera 'webcam0' is connected to device 'FaceTime HD Camera' on channel 0 using pixel format 'YV12'",
  " Camera 'webcam1' is connected to device 'Team's USB Camera' on channel 0 using pixel format 'YV12'",
  "",
].join("\n");

/** Fake emulator binary and an adb that boots or reports Pixel_8 as running. */
function cameraExec(webcamList = WEBCAM_LIST) {
  const emulatorCalls: string[][] = [];
  const adbCalls: string[] = [];
  const runExec = (async (command, args) => {
    if (command === "/sdk/emulator") {
      emulatorCalls.push(args);
      return result(args[0] === "-webcam-list" ? webcamList : "Pixel_8\n");
    }
    const adbCommand = args.slice(2).join(" ");
    adbCalls.push(adbCommand);
    if (adbCommand === "emu avd name") return result("Pixel_8\nOK\n");
    if (adbCommand === "get-state") return result("device\n");
    if (adbCommand === "shell getprop sys.boot_completed") return result("1\n");
    return result("");
  }) as typeof execText;
  return { runExec, emulatorCalls, adbCalls };
}

const refuseSpawn = (() => {
  throw new Error("should not spawn");
}) as unknown as typeof spawn;

describe("emulator cameras", () => {
  test("lists host webcams, including device names with quotes", async () => {
    const calls: unknown[][] = [];
    const runExec = (async (command, args, options) => {
      calls.push([command, args, options]);
      return result(WEBCAM_LIST);
    }) as typeof execText;
    await expect(
      listWebcams("/sdk/emulator", { execText: runExec }),
    ).resolves.toEqual([
      { name: "webcam0", device: "FaceTime HD Camera" },
      { name: "webcam1", device: "Team's USB Camera" },
    ]);
    expect(calls).toEqual([
      [
        "/sdk/emulator",
        ["-webcam-list"],
        { timeout: 10_000, maxBuffer: 64 * 1024 },
      ],
    ]);

    const none = (async () =>
      result("No web cameras are connected to the host.\n")) as typeof execText;
    await expect(
      listWebcams("/sdk/emulator", { execText: none }),
    ).resolves.toEqual([]);

    const failed = (async () =>
      result("", { status: 1, stderr: "no display" })) as typeof execText;
    await expect(
      listWebcams("/sdk/emulator", { execText: failed }),
    ).rejects.toThrow("emulator -webcam-list failed: no display");
  });

  test("boots with camera arguments after checking the requested webcam", async () => {
    const { runExec, emulatorCalls } = cameraExec();
    const spawnCalls: unknown[][] = [];
    await startEmulator(
      {
        avd: "Pixel_8",
        emulatorPath: "/sdk/emulator",
        port: 5554,
        gpu: "host",
        cameraBack: "webcam1",
        cameraFront: "emulated",
      },
      {
        execText: runExec,
        listAllDevices: async () => [],
        spawn: spawnWith(fakeProcess().proc, spawnCalls),
      },
    );
    expect(emulatorCalls).toEqual([["-list-avds"], ["-webcam-list"]]);
    expect(spawnCalls[0]?.[1]).toEqual([
      "@Pixel_8",
      "-port",
      "5554",
      "-gpu",
      "host",
      "-camera-back",
      "webcam1",
      "-camera-front",
      "emulated",
    ]);
  });

  test("passes file and built-in camera modes through without listing webcams", async () => {
    const { runExec, emulatorCalls } = cameraExec();
    const spawnCalls: unknown[][] = [];
    await startEmulator(
      {
        avd: "Pixel_8",
        emulatorPath: "/sdk/emulator",
        port: 5554,
        cameraBack: "imagefile:/tmp/qr code.png",
        cameraFront: "none",
      },
      {
        execText: runExec,
        listAllDevices: async () => [],
        spawn: spawnWith(fakeProcess().proc, spawnCalls),
      },
    );
    expect(emulatorCalls).toEqual([["-list-avds"]]);
    expect(spawnCalls[0]?.[1]).toEqual([
      "@Pixel_8",
      "-port",
      "5554",
      "-camera-back",
      "imagefile:/tmp/qr code.png",
      "-camera-front",
      "none",
    ]);
  });

  test("rejects invalid camera modes before running anything", async () => {
    const runExec = (async () => {
      throw new Error("should not run");
    }) as typeof execText;
    const cases = [
      [
        { cameraFront: "virtualscene" },
        '--camera-front must be one of webcam<N>, emulated, environment, none, or videofile:/imagefile:/image360:<path> (got "virtualscene").',
      ],
      [
        { cameraBack: "webcam" },
        '--camera-back must be one of webcam<N>, emulated, virtualscene, environment, none, or videofile:/imagefile:/image360:<path> (got "webcam").',
      ],
      [{ cameraBack: "imagefile:" }, '(got "imagefile:")'],
      [{ cameraBack: "" }, '(got "")'],
      [{ cameraFront: "-gpu" }, '(got "-gpu")'],
      [
        { cameraBack: "webcam0", cameraFront: "webcam0" },
        "webcam0 can feed only one camera; use a different webcam for --camera-front.",
      ],
    ] as const;
    for (const [camera, message] of cases) {
      await expect(
        startEmulator(
          { avd: "Pixel_8", emulatorPath: "/sdk/emulator", ...camera },
          { execText: runExec, spawn: refuseSpawn },
        ),
      ).rejects.toThrow(message);
    }
  });

  test("rejects a missing webcam before stopping a running AVD", async () => {
    const running = async () => [{ serial: "emulator-5554", state: "device" }];
    const empty = cameraExec("List of web cameras connected to the computer:\n");
    await expect(
      startEmulator(
        {
          avd: "Pixel_8",
          emulatorPath: "/sdk/emulator",
          restartAvd: true,
          cameraBack: "webcam0",
        },
        { execText: empty.runExec, listAllDevices: running, spawn: refuseSpawn },
      ),
    ).rejects.toThrow('Unknown webcam "webcam0". Available webcams: (none)');
    expect(empty.adbCalls).toEqual([]);

    const two = cameraExec();
    await expect(
      startEmulator(
        {
          avd: "Pixel_8",
          emulatorPath: "/sdk/emulator",
          cameraBack: "webcam0",
          cameraFront: "webcam2",
        },
        { execText: two.runExec, listAllDevices: running, spawn: refuseSpawn },
      ),
    ).rejects.toThrow(
      `Unknown webcam "webcam2". Available webcams: webcam0 (FaceTime HD Camera), webcam1 (Team's USB Camera)`,
    );
    expect(two.adbCalls).toEqual([]);
  });

  test("requires a restart to change the camera of a running AVD", async () => {
    const attach = cameraExec();
    await expect(
      startEmulator(
        { avd: "Pixel_8", emulatorPath: "/sdk/emulator", cameraBack: "webcam0" },
        {
          execText: attach.runExec,
          listAllDevices: async () => [
            { serial: "emulator-5554", state: "device" },
          ],
          spawn: refuseSpawn,
        },
      ),
    ).rejects.toThrow(
      'AVD "Pixel_8" is already running as emulator-5554, and the emulator picks cameras at boot. Add --restart-avd to relaunch it with the requested camera.',
    );
    expect(attach.adbCalls).not.toContain("emu kill");

    const restart = cameraExec();
    let deviceReads = 0;
    const spawnCalls: unknown[][] = [];
    const launch = await startEmulator(
      {
        avd: "Pixel_8",
        emulatorPath: "/sdk/emulator",
        port: 5556,
        restartAvd: true,
        cameraBack: "webcam0",
      },
      {
        execText: restart.runExec,
        listAllDevices: async () => {
          deviceReads++;
          return deviceReads === 1
            ? [{ serial: "emulator-5554", state: "device" }]
            : [];
        },
        spawn: spawnWith(fakeProcess().proc, spawnCalls),
      },
    );
    expect(launch.serial).toBe("emulator-5556");
    expect(restart.adbCalls).toContain("emu kill");
    expect(spawnCalls[0]?.[1]).toEqual([
      "@Pixel_8",
      "-port",
      "5556",
      "-camera-back",
      "webcam0",
    ]);
  });
});
