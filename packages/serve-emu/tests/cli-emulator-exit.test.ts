import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { CliLifecycle, type EmulatorExit } from "../src/cli-lifecycle.ts";
import type { EmulatorLaunch } from "../src/emulator.ts";
import { describePortOwner } from "../src/port-owner.ts";
import { startServer } from "../src/server.ts";
import { createHarness, fakeScrcpy, response } from "./helpers/server-harness.ts";

type StoppableServer = { stop(): Promise<void> };

/** An `--avd` child that a test makes exit. */
function launchedEmulator(serial = "emulator-5554") {
  const proc = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  });
  const launch: EmulatorLaunch = {
    serial,
    proc: proc as unknown as ChildProcess,
    ownsProcess: true,
    stop: async () => {},
  };
  const exit = (code: number | null, signal: NodeJS.Signals | null = null) => {
    proc.exitCode = code;
    proc.signalCode = signal;
    proc.emit("exit", code, signal);
  };
  return { launch, exit };
}

function watch(launch: EmulatorLaunch, deviceSerial: () => string | null) {
  const lifecycle = new CliLifecycle<StoppableServer>();
  const exits: EmulatorExit[] = [];
  lifecycle.watchEmulator(launch, deviceSerial, (exit) => exits.push(exit));
  return { lifecycle, exits };
}

describe("an --avd emulator exiting (#73)", () => {
  test("ends the CLI while the server still streams it", () => {
    const { launch, exit } = launchedEmulator();
    const { exits } = watch(launch, () => "emulator-5554");
    exit(0);
    expect(exits).toEqual([{ serial: "emulator-5554", code: 0, signal: null }]);
  });

  test("reports an emulator that exited while the server was starting", () => {
    const { launch, exit } = launchedEmulator();
    exit(null, "SIGKILL");
    const { exits } = watch(launch, () => "emulator-5554");
    expect(exits).toEqual([{ serial: "emulator-5554", code: null, signal: "SIGKILL" }]);
  });

  test("is ignored after a switch to another device or a requested stop", () => {
    let current: string | null = "emulator-5556";
    const { launch, exit } = launchedEmulator();
    const { exits } = watch(launch, () => current);
    current = null;
    exit(0);
    expect(exits).toEqual([]);
  });

  test("is ignored while the CLI itself is stopping", async () => {
    const { launch, exit } = launchedEmulator();
    const { lifecycle, exits } = watch(launch, () => "emulator-5554");
    await lifecycle.stop();
    exit(0);
    expect(exits).toEqual([]);
  });

  test("has no child to watch when --avd attached to a running emulator", () => {
    const { launch, exit } = launchedEmulator();
    const { exits } = watch({ ...launch, ownsProcess: false, proc: null }, () => "emulator-5554");
    exit(0);
    expect(exits).toEqual([]);
  });
});

describe("the server's deviceSerial", () => {
  const post = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  test("follows device switches and clears when a client stops the device", async () => {
    const killed: string[] = [];
    const harness = await createHarness(
      { serial: "emulator-5554" },
      {
        openScrcpy: async (serial) => fakeScrcpy(serial),
        listDevices: async () => [
          { serial: "emulator-5554", state: "device" },
          { serial: "emulator-5556", state: "device" },
        ],
        stopEmulator: async (serial) => {
          killed.push(serial);
        },
      },
    );
    expect(harness.started.deviceSerial).toBe("emulator-5554");

    const switched = await response(
      harness.request("/api/devices/select", post({ serial: "emulator-5556" })),
    );
    expect(switched.status).toBe(200);
    expect(harness.started.deviceSerial).toBe("emulator-5556");

    // A failed session still counts: the server depends on that device.
    harness.started.session!.proc.emit("exit", 1, null);
    expect(harness.started.deviceSerial).toBe("emulator-5556");

    const stopped = await response(
      harness.request("/api/avds/stop", post({ serial: "emulator-5556" })),
    );
    expect(stopped.status).toBe(200);
    expect(killed).toEqual(["emulator-5556"]);
    expect(harness.started.deviceSerial).toBeNull();

    await harness.started.stop();
    expect(harness.started.deviceSerial).toBeNull();
  });
});

describe("a port another server already uses", () => {
  async function realServer(token?: string) {
    return startServer(
      { serial: "emulator-5554", host: "127.0.0.1", port: 0, token },
      { log: () => {}, openScrcpy: async () => fakeScrcpy("emulator-5554") },
    );
  }

  test("names the serve-emu on it, its device, and its status", async () => {
    const other = await realServer();
    try {
      const message = await describePortOwner("127.0.0.1", other.server.port!);
      expect(message).toMatch(
        new RegExp(
          `^Port ${other.server.port} is already used by another serve-emu \\(device emulator-5554, status streaming, session started \\d{4}-`,
        ),
      );
      // A wildcard bind asks over loopback.
      expect(await describePortOwner("0.0.0.0", other.server.port!)).toBe(message);
    } finally {
      await other.stop();
    }
  });

  test("says a token-protected serve-emu needs a token", async () => {
    const other = await realServer("secret-token");
    try {
      expect(await describePortOwner("127.0.0.1", other.server.port!)).toBe(
        `Port ${other.server.port} is already used by another serve-emu, which requires a token.`,
      );
    } finally {
      await other.stop();
    }
  });

  test("returns null for another program or a closed port", async () => {
    const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("hello") });
    const port = other.port!;
    try {
      expect(await describePortOwner("127.0.0.1", port)).toBeNull();
    } finally {
      other.stop(true);
    }
    expect(await describePortOwner("127.0.0.1", port)).toBeNull();
  });
});
