import { describe, expect, test } from "bun:test";
import { ExecError, type ExecOpts, type ExecResult, type execText } from "../src/exec.ts";
import {
  PACKAGE_PID_LOOKUP_MAX_OUTPUT_BYTES,
  PACKAGE_PID_LOOKUP_TIMEOUT_MS,
  PackagePidLookupError,
  packagePids,
} from "../src/package-pids.ts";

function result(overrides: Partial<ExecResult<string>> = {}): ExecResult<string> {
  return {
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    error: null,
    ...overrides,
  };
}

function fakeExec(response: ExecResult<string>) {
  const calls: Array<{ cmd: string; args: string[]; opts: ExecOpts }> = [];
  const run = (async (cmd: string, args: string[], opts: ExecOpts = {}) => {
    calls.push({ cmd, args, opts });
    return response;
  }) as typeof execText;
  return { calls, run };
}

describe("packagePids", () => {
  test("runs a quoted pidof through the executor with its bounds", async () => {
    const controller = new AbortController();
    const exec = fakeExec(result({ stdout: "4321 987\n" }));
    await expect(
      packagePids("emulator-5554", "com.example.app:remote", {
        signal: controller.signal,
        lane: "background",
      }, exec.run),
    ).resolves.toEqual(["4321", "987"]);
    expect(exec.calls).toEqual([
      {
        cmd: "adb",
        args: ["-s", "emulator-5554", "shell", "pidof", "'com.example.app:remote'"],
        opts: {
          timeout: PACKAGE_PID_LOOKUP_TIMEOUT_MS,
          maxBuffer: PACKAGE_PID_LOOKUP_MAX_OUTPUT_BYTES,
          signal: controller.signal,
          lane: "background",
        },
      },
    ]);
    expect(PACKAGE_PID_LOOKUP_TIMEOUT_MS).toBe(2_000);
    expect(PACKAGE_PID_LOOKUP_MAX_OUTPUT_BYTES).toBe(64 * 1024);
  });

  test("reports a package that is not running as no PIDs", async () => {
    // pidof exits 1 with no output when nothing matches.
    const exec = fakeExec(result({ status: 1 }));
    await expect(packagePids("device-a", "com.example.app", {}, exec.run)).resolves.toEqual([]);
  });

  test("ignores non-numeric output", async () => {
    const exec = fakeExec(result({ stdout: "not-a-pid\n" }));
    await expect(packagePids("device-a", "com.example.app", {}, exec.run)).resolves.toEqual([]);
  });

  test("rejects names pidof should never see without running adb", async () => {
    const exec = fakeExec(result());
    await expect(packagePids("device-a", "com.example app", {}, exec.run)).resolves.toEqual([]);
    await expect(packagePids("device-a", "$(id)", {}, exec.run)).resolves.toEqual([]);
    expect(exec.calls).toHaveLength(0);
  });

  test.each([
    ["a timeout", new ExecError("deadline-exceeded", "command deadline exceeded after 2000ms")],
    ["a full queue", new ExecError("queue-full", "command queue has no capacity for background work")],
    ["an abort", new ExecError("aborted", "command aborted")],
    ["an output overflow", new ExecError("output-limit", "command output exceeded 65536 bytes")],
  ])("reports %s as a failed lookup, not as no PIDs", async (_name, error) => {
    const exec = fakeExec(result({ status: null, error }));
    const lookup = packagePids("device-a", "com.example.app", {}, exec.run);
    await expect(lookup).rejects.toBeInstanceOf(PackagePidLookupError);
    await expect(lookup).rejects.toMatchObject({ cause: error });
  });

  test("reports an adb failure with stderr as a failed lookup", async () => {
    const exec = fakeExec(result({ status: 1, stderr: "adb: device 'emulator-9999' not found\n" }));
    await expect(packagePids("emulator-9999", "com.example.app", {}, exec.run)).rejects.toThrow(
      "pidof com.example.app failed: adb: device 'emulator-9999' not found",
    );
  });
});
