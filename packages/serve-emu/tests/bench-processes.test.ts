import { expect, test } from "bun:test";
import { readMacProcesses } from "../scripts/bench-processes.ts";

test("macOS ps rows preserve parents, commands with spaces, CPU ticks and MiB RSS", () => {
  const rows = readMacProcesses(`
  100 1 2048 0:14.53 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer
  101 100 1024 1:02:03.50 adb -L tcp:localhost:5037 fork-server server --reply-fd 4
  102 100 512 2-03:04:05.67 /sdk/qemu-system-aarch64 -avd pixel_fold
  `);
  expect([...rows]).toEqual([
    [100, { ppid: 1, cpuTicks: 1453, rssMb: 2, command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer" }],
    [101, { ppid: 100, cpuTicks: 372350, rssMb: 1, command: "adb -L tcp:localhost:5037 fork-server server --reply-fd 4" }],
    [102, { ppid: 100, cpuTicks: 18384567, rssMb: 0.5, command: "/sdk/qemu-system-aarch64 -avd pixel_fold" }],
  ]);
});

test.each(["", "\n  PID PPID RSS TIME COMMAND\ninvalid row\n 1 0 10 missing-time /bin/process"])("ignores empty or malformed ps output", (output) => {
  expect(readMacProcesses(output).size).toBe(0);
});

test.skipIf(process.platform !== "darwin")("samples the live macOS process table", () => {
  const process = readMacProcesses().get(globalThis.process.pid);
  expect(process).toBeDefined();
  expect(process!.rssMb).toBeGreaterThan(0);
  expect(process!.cpuTicks).toBeGreaterThanOrEqual(0);
  expect(process!.command).toContain("bun");
});

test("bench-server usage accepts the equals form of a flag-valued server argument", async () => {
  const child = Bun.spawn([process.execPath, new URL("../scripts/bench-server.ts", import.meta.url).pathname, "--server-args=--host-capture"], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited).toBe(2);
  expect(stderr).toContain("usage: bench-server");
  expect(stderr).toContain("--server-args=--host-capture");
  expect(stderr).not.toContain("ambiguous");
});
