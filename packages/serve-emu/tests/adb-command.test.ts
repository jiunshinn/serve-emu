import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import {
  isDeviceUnavailable,
  runAdb,
  spawnAdb,
  terminateChild,
} from "../src/adb-command.ts";
import type { ExecOpts, ExecResult, execText } from "../src/exec.ts";

const ok: ExecResult<string> = { status: 0, signal: null, stdout: "", stderr: "", timedOut: false, error: null };

describe("runAdb and spawnAdb", () => {
  test("run device and host commands through the given executor with its bounds", async () => {
    const calls: Array<[string, string[], ExecOpts]> = [];
    const run = (async (cmd: string, args: string[], opts: ExecOpts = {}) => {
      calls.push([cmd, args, opts]);
      return ok;
    }) as typeof execText;
    const signal = new AbortController().signal;
    await runAdb("emulator-5554", ["shell", "wm", "size"], { timeout: 2_000, signal, lane: "interactive", execText: run });
    await runAdb(null, ["devices"], { execText: run });
    expect(calls).toEqual([
      ["adb", ["-s", "emulator-5554", "shell", "wm", "size"], { timeout: 2_000, signal, lane: "interactive" }],
      ["adb", ["devices"], {}],
    ]);
  });

  test("spawn long-running commands with piped output", () => {
    const spawned: unknown[][] = [];
    const child = { pid: 1 };
    const run = ((cmd: string, args: string[], opts: unknown) => {
      spawned.push([cmd, args, opts]);
      return child;
    }) as unknown as typeof spawn;
    expect(spawnAdb("emulator-5554", ["logcat", "-T", "1"], run) as unknown).toBe(child);
    expect(spawned).toEqual([
      ["adb", ["-s", "emulator-5554", "logcat", "-T", "1"], { stdio: ["ignore", "pipe", "pipe"] }],
    ]);
  });
});

describe("isDeviceUnavailable", () => {
  test.each([
    ["adb: device offline", true],
    ["adb: device unauthorized.\nThis adb server's $ADB_VENDOR_KEYS is not set", true],
    ["adb: device 'emulator-5554' not found", true],
    ["adb: no devices/emulators found", true],
    ["error: closed", true],
    ["adb: error: listener 'tcp:27183' not found", true],
    ["rm: /data/local/tmp/x: Permission denied", false],
    ["Error: Activity class does not exist", false],
    ["", false],
  ])("%p → %p", (stderr, unavailable) => {
    expect(isDeviceUnavailable({ stdout: "", stderr })).toBe(unavailable);
    expect(isDeviceUnavailable(stderr)).toBe(unavailable);
  });

  test("reads stdout too", () => {
    expect(isDeviceUnavailable({ stdout: "error: device offline", stderr: "" })).toBe(true);
  });
});

class FakeChild extends EventEmitter {
  readonly signals: string[] = [];
  constructor(private readonly exitOn: string | null, private readonly throwOn: string | null = null) {
    super();
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal === this.throwOn) throw new Error(`kill ${signal} failed`);
    if (signal === this.exitOn) queueMicrotask(() => this.emit("exit"));
    return true;
  }
  exited = new Promise<void>((resolve) => this.once("exit", () => resolve()));
}

describe("terminateChild", () => {
  test("stops after SIGTERM when the child exits", async () => {
    const child = new FakeChild("SIGTERM");
    await terminateChild(child, { exited: child.exited, graceMs: 50, label: "test child" });
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  test("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const child = new FakeChild("SIGKILL");
    await terminateChild(child, { exited: child.exited, graceMs: 10, label: "test child" });
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("rejects when the child survives both signals", async () => {
    const child = new FakeChild(null, "SIGKILL");
    const stopping = terminateChild(child, { exited: child.exited, graceMs: 5, label: "test child" });
    await expect(stopping).rejects.toThrow("test child did not exit after SIGTERM and SIGKILL");
    await stopping.catch((error: AggregateError) => {
      expect(error.errors.map(String)).toEqual(["Error: kill SIGKILL failed"]);
    });
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("sends SIGTERM before the returned promise first waits", () => {
    const child = new FakeChild("SIGTERM");
    void terminateChild(child, { exited: child.exited, graceMs: 50, label: "test child" });
    expect(child.signals).toEqual(["SIGTERM"]);
  });
});
