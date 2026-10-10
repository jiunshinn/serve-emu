import { expect, test } from "bun:test";
import { createDeviceService } from "../src/device-service.ts";
import type { ExecOpts, ExecResult } from "../src/exec.ts";

type Call = { args: string[]; opts: ExecOpts };

function result<T extends string | Buffer>(stdout: T): ExecResult<T> {
  return { status: 0, signal: null, stdout, stderr: "", timedOut: false, error: null };
}

test("every device command runs its adb processes with the caller's signal", async () => {
  const calls: Call[] = [];
  const execText = (async (_cmd: string, args: string[], opts: ExecOpts = {}) => {
    calls.push({ args, opts });
    const shell = args.slice(3).join(" ");
    if (shell.includes("user-rotation")) return result("lock 1\n");
    if (shell.includes("font_scale")) return result("1.0\n");
    if (shell.includes("uimode night")) return result("Night mode: yes\n");
    if (shell.includes("settings get global")) return result("1\n");
    if (shell.startsWith("dumpsys window")) return result("mCurrentFocus=Window{1 u0 com.example/.Main}");
    return result("Success\n");
  }) as never;
  const execBuffer = (async (_cmd: string, args: string[], opts: ExecOpts = {}) => {
    calls.push({ args, opts });
    return result(Buffer.from([0x89, 0x50]));
  }) as never;
  const device = createDeviceService({ execText, execBuffer });
  const signal = new AbortController().signal;
  const serial = "emulator-5554";

  await device.screenshot(serial, signal);
  await device.foregroundApp(serial, signal);
  await device.orientation(serial, signal);
  await device.setOrientation(serial, "portrait", signal);
  await device.nightMode(serial, signal);
  await device.setNightMode(serial, "dark", signal);
  await device.fontScale(serial, signal);
  await device.setFontScale(serial, 1.15, signal);
  await device.network(serial, signal);
  await device.setNetwork(serial, true, signal);
  await device.launchApp(serial, "com.example.app", undefined, signal);
  await device.clearAppData(serial, "com.example.app", signal);
  await device.forceStopApp(serial, "com.example.app", signal);
  await device.grantPermission(serial, "com.example.app", "android.permission.CAMERA", signal);

  expect(calls.length).toBeGreaterThanOrEqual(14);
  expect(calls.every((call) => call.args[1] === serial)).toBe(true);
  // The point of the service: no adb process runs without the session signal.
  expect(calls.filter((call) => call.opts.signal !== signal)).toEqual([]);
  // Each helper keeps its own bounds.
  expect(calls[0]!.args.slice(2)).toEqual(["exec-out", "screencap", "-p"]);
  expect(calls.every((call) => typeof call.opts.timeout === "number")).toBe(true);
});
