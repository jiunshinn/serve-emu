import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import {
  avdLaunchOptions,
  emulatorLaunchSettings,
  parseCliArgs,
  serverOptions,
} from "../src/cli.ts";
import {
  emulatorWindowDefault,
  startEmulator,
  type StartEmulatorOpts,
} from "../src/emulator.ts";
import type { execText } from "../src/exec.ts";
import { createHarness, response } from "./helpers/server-harness.ts";

const ok = (stdout = "") => ({
  status: 0,
  signal: null,
  stdout,
  stderr: "",
  timedOut: false,
  error: null,
});

/**
 * Boots Pixel_8 and returns the emulator's arguments after `-port <n>`: the
 * port picker also skips console ports that are busy on the host.
 */
async function launchArgs(opts: Partial<StartEmulatorOpts>): Promise<unknown> {
  const runExec = (async (command, args) => {
    if (command === "/sdk/emulator") return ok("Pixel_8\n");
    const adbCommand = args.slice(2).join(" ");
    if (adbCommand === "get-state") return ok("device\n");
    if (adbCommand === "shell getprop sys.boot_completed") return ok("1\n");
    if (adbCommand === "emu avd name") return ok("Pixel_8\nOK\n");
    return ok();
  }) as typeof execText;
  let deviceReads = 0;
  const spawnCalls: unknown[][] = [];
  const proc = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    kill: () => true,
  }) as unknown as ChildProcess;
  await startEmulator(
    { avd: "Pixel_8", emulatorPath: "/sdk/emulator", ...opts },
    {
      execText: runExec,
      listAllDevices: async () =>
        // Any emulator-* serial that appears is the booted launch.
        deviceReads++ === 0
          ? []
          : Array.from({ length: 64 }, (_, i) => ({
              serial: `emulator-${5554 + i * 2}`,
              state: "device",
            })),
      spawn: ((...args: unknown[]) => {
        spawnCalls.push(args);
        return proc;
      }) as unknown as typeof spawn,
    },
  );
  const args = spawnCalls[0]?.[1] as string[];
  expect(args.slice(0, 2)).toEqual(["@Pixel_8", "-port"]);
  return args.slice(3);
}

describe("emulator window (#74)", () => {
  test.each([
    ["darwin", {}, true],
    ["win32", {}, true],
    ["linux", { DISPLAY: ":0" }, true],
    ["linux", { WAYLAND_DISPLAY: "wayland-0" }, true],
    ["linux", {}, false],
    ["linux", { DISPLAY: "" }, false],
  ] as const)("defaults on %s with %p to %p", (platform, env, expected) => {
    expect(emulatorWindowDefault(platform, env)).toBe(expected);
  });

  test("window: false launches with -no-window; otherwise the window opens", async () => {
    expect(await launchArgs({ gpu: "host", window: false })).toEqual([
      "-gpu",
      "host",
      "-no-window",
    ]);
    expect(await launchArgs({ window: true })).toEqual([]);
    expect(await launchArgs({})).toEqual([]);
  });

  test("--emulator-window and --no-emulator-window override the default", () => {
    expect(parseCliArgs([])["emulator-window"]).toBeUndefined();
    expect(parseCliArgs(["--emulator-window"])["emulator-window"]).toBe(true);
    expect(parseCliArgs(["--no-emulator-window"])["emulator-window"]).toBe(false);
    expect(() => parseCliArgs(["--no-such-flag"])).toThrow("Unknown option '--no-such-flag'");
    // allowNegative must not turn other boolean flags into silent no-ops.
    for (const flag of ["--no-help", "--no-unsafe-no-auth", "--no-restart-avd"]) {
      expect(() => parseCliArgs([flag])).toThrow(`Unknown option '${flag}'`);
    }
  });

  test("one set of emulator settings for --avd and the server", () => {
    // Without a display the host GPU cannot start its renderer, so the
    // default falls back to software rendering as well as no window.
    expect(emulatorLaunchSettings(parseCliArgs([]), "linux", {})).toEqual({
      emulatorPath: undefined,
      gpu: "swiftshader_indirect",
      window: false,
    });
    expect(emulatorLaunchSettings(parseCliArgs([]), "linux", { DISPLAY: ":0" })).toEqual({
      emulatorPath: undefined,
      gpu: "host",
      window: true,
    });
    expect(emulatorLaunchSettings(parseCliArgs([]), "darwin", {})).toMatchObject({
      gpu: "host",
      window: true,
    });
    // An explicit --gpu wins, and hiding the window keeps the host GPU where
    // a display exists.
    expect(
      emulatorLaunchSettings(parseCliArgs(["--gpu", "host"]), "linux", {}),
    ).toMatchObject({ gpu: "host", window: false });
    expect(
      emulatorLaunchSettings(parseCliArgs(["--no-emulator-window"]), "darwin", {}),
    ).toMatchObject({ gpu: "host", window: false });
    expect(
      emulatorLaunchSettings(
        parseCliArgs(["--emulator", "/sdk/emulator/emulator", "--gpu", "swiftshader_indirect", "--emulator-window"]),
        "linux",
        {},
      ),
    ).toEqual({ emulatorPath: "/sdk/emulator/emulator", gpu: "swiftshader_indirect", window: true });
    expect(
      emulatorLaunchSettings(parseCliArgs(["--no-emulator-window"]), "linux", { DISPLAY: ":0" }),
    ).toMatchObject({ window: false });
  });

  test("the --avd launch and the server both get the emulator settings", () => {
    const values = parseCliArgs([
      "--avd",
      "Pixel_8",
      "--emulator-port",
      "5560",
      "--restart-avd",
      "--camera-back",
      "webcam0",
      "--max-fps",
      "30",
    ]);
    const settings = emulatorLaunchSettings(values, "linux", {});
    const signal = new AbortController().signal;
    expect(avdLaunchOptions("Pixel_8", values, settings, signal)).toEqual({
      emulatorPath: undefined,
      gpu: "swiftshader_indirect",
      window: false,
      avd: "Pixel_8",
      port: 5560,
      restartAvd: true,
      cameraBack: "webcam0",
      cameraFront: undefined,
      signal,
    });
    expect(
      serverOptions(values, settings, { serial: "emulator-5560", host: "127.0.0.1", token: undefined, signal }),
    ).toMatchObject({
      serial: "emulator-5560",
      port: 3300,
      maxFps: 30,
      signal,
      emulator: { gpu: "swiftshader_indirect", window: false },
    });
  });

  test("/api/avds/start and the AVD list use the CLI's emulator settings", async () => {
    const launches: StartEmulatorOpts[] = [];
    const listedWith: Array<string | undefined> = [];
    const harness = await createHarness(
      {
        serials: ["emulator-5554"],
        emulator: {
          emulatorPath: "/sdk/emulator/emulator",
          gpu: "swiftshader_indirect",
          window: false,
        },
      },
      {
        startEmulator: async (opts) => {
          launches.push(opts);
          return { serial: "emulator-5556", proc: null, ownsProcess: false, stop: async () => {} };
        },
        listAvds: async (emulatorPath) => {
          listedWith.push(emulatorPath);
          return ["Pixel_8"];
        },
        listRunningAvds: async () => [],
      },
    );
    const started = await response(
      harness.request("/api/avds/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ avd: "Pixel_8", select: false }),
      }),
    );
    expect(started.status).toBe(200);
    expect(launches).toEqual([
      {
        avd: "Pixel_8",
        emulatorPath: "/sdk/emulator/emulator",
        gpu: "swiftshader_indirect",
        window: false,
        signal: expect.any(AbortSignal),
      },
    ]);

    // An emulator reachable only through --emulator still lists its AVDs.
    const grid = await response(harness.request("/api/device-grid"));
    expect(grid.status).toBe(200);
    expect(JSON.stringify(await grid.json())).toContain("Pixel_8");
    expect(listedWith).toEqual(["/sdk/emulator/emulator"]);
  });
});
