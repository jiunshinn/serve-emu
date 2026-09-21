import { describe, expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import {
  getDeviceSize,
  getFontScale,
  getNetworkStatus,
  getNightMode,
  getUserRotation,
  listAllDevices,
  listDevices,
  pickDevice,
  screencapPng,
  setFontScale,
  setNetworkEnabled,
  setNightMode,
  setUserRotation,
  shell,
  shellSpawn,
} from "../src/adb.ts";
import type { execBuffer, execText } from "../src/exec.ts";

type ResultOptions = {
  status?: number | null;
  stderr?: string;
  error?: Error | null;
};

function result<T extends string | Buffer>(
  stdout: T,
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

describe("ADB device discovery", () => {
  test("parses all states, filters online devices, and selects the only online device", async () => {
    const calls: Array<{ command: string; args: string[]; timeout?: number }> = [];
    const runExec = (async (command, args, options) => {
      calls.push({ command, args, timeout: options?.timeout });
      return result(`List of devices attached
emulator-5554\tdevice product:sdk_gphone
physical-1\toffline

unauthorized-1 unauthorized
`);
    }) as typeof execText;

    await expect(listAllDevices(runExec)).resolves.toEqual([
      { serial: "emulator-5554", state: "device" },
      { serial: "physical-1", state: "offline" },
      { serial: "unauthorized-1", state: "unauthorized" },
    ]);
    await expect(listDevices(runExec)).resolves.toEqual([
      { serial: "emulator-5554", state: "device" },
    ]);
    await expect(pickDevice(undefined, runExec)).resolves.toBe("emulator-5554");
    expect(calls).toEqual([
      { command: "adb", args: ["devices"], timeout: 2_000 },
      { command: "adb", args: ["devices"], timeout: 2_000 },
      { command: "adb", args: ["devices"], timeout: 2_000 },
    ]);
  });

  test("explicit selection bypasses discovery and ambiguous discovery is rejected", async () => {
    let calls = 0;
    const neverRun = (async () => {
      calls++;
      throw new Error("should not execute");
    }) as typeof execText;
    await expect(pickDevice("chosen-device", neverRun)).resolves.toBe(
      "chosen-device",
    );
    expect(calls).toBe(0);

    const noDevices = (async () =>
      result("List of devices attached\nemulator-5554\toffline\n")) as typeof execText;
    await expect(pickDevice(undefined, noDevices)).rejects.toThrow(
      "No booted Android device found",
    );

    const manyDevices = (async () =>
      result(
        "List of devices attached\nemulator-5554\tdevice\nphysical-1\tdevice\n",
      )) as typeof execText;
    await expect(pickDevice(undefined, manyDevices)).rejects.toThrow(
      "Multiple devices online (emulator-5554, physical-1). Pass -s <serial>.",
    );
  });

  test("uses stderr, process errors, stdout, then a fallback for discovery failures", async () => {
    const processError = new Error("spawn ENOENT");
    const cases = [
      { value: result("stdout", { status: 1, stderr: "stderr" }), detail: "stderr" },
      { value: result("stdout", { status: null, error: processError }), detail: "spawn ENOENT" },
      { value: result(" stdout detail ", { status: 1 }), detail: "stdout detail" },
      { value: result("", { status: 1 }), detail: "unknown error" },
    ];

    for (const { value, detail } of cases) {
      const runExec = (async () => value) as typeof execText;
      await expect(listAllDevices(runExec)).rejects.toThrow(
        `adb devices failed: ${detail}`,
      );
    }
  });
});

describe("ADB screenshot and shell commands", () => {
  test("captures PNG bytes with a bounded command", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const calls: unknown[][] = [];
    const runExec = (async (command, args, options) => {
      calls.push([command, args, options]);
      return result(png);
    }) as typeof execBuffer;

    await expect(screencapPng("device-1", runExec)).resolves.toEqual(png);
    expect(calls).toEqual([
      [
        "adb",
        ["-s", "device-1", "exec-out", "screencap", "-p"],
        { maxBuffer: 64 * 1024 * 1024, timeout: 8_000 },
      ],
    ]);
  });

  test("reports screenshot and shell failures", async () => {
    const failedBuffer = (async () =>
      result(Buffer.from("binary diagnostic"), { status: 1 })) as typeof execBuffer;
    await expect(screencapPng("device-1", failedBuffer)).rejects.toThrow(
      "screencap failed: unknown error",
    );

    const failedText = (async () =>
      result("", { status: 1, stderr: "permission denied" })) as typeof execText;
    await expect(
      shell("device-1", ["settings", "put", "global", "x", "1"], failedText),
    ).rejects.toThrow(
      "adb shell settings put global x 1 failed: permission denied",
    );
  });

  test("passes shell arguments to promise and streaming process executors", async () => {
    const textCalls: unknown[][] = [];
    const runExec = (async (command, args, options) => {
      textCalls.push([command, args, options]);
      return result("");
    }) as typeof execText;
    await shell("device-1", ["logcat", "-d"], runExec);
    expect(textCalls).toEqual([
      ["adb", ["-s", "device-1", "shell", "logcat", "-d"], { timeout: 5_000 }],
    ]);

    const child = { pid: 1234 };
    const spawnCalls: unknown[][] = [];
    const runSpawn = ((command: string, args: string[]) => {
      spawnCalls.push([command, args]);
      return child;
    }) as unknown as typeof spawn;
    expect(shellSpawn("device-1", ["logcat"], runSpawn) as unknown).toBe(child);
    expect(spawnCalls).toEqual([
      ["adb", ["-s", "device-1", "shell", "logcat"]],
    ]);
  });
});

describe("ADB display controls", () => {
  test("parses physical or override display sizes and rejects malformed output", async () => {
    const successful = (async () =>
      result("Physical size: 1440x2960\nOverride size: 1080x2220\n")) as typeof execText;
    await expect(getDeviceSize("device-1", successful)).resolves.toEqual({
      width: 1440,
      height: 2960,
    });

    const malformed = (async () => result("size unavailable")) as typeof execText;
    await expect(getDeviceSize("device-1", malformed)).rejects.toThrow(
      "Could not parse wm size output: size unavailable",
    );

    const failed = (async () =>
      result("", { status: 1, stderr: "wm failed" })) as typeof execText;
    await expect(getDeviceSize("device-1", failed)).rejects.toThrow(
      "wm size failed: wm failed",
    );
  });

  test("maps free and locked rotations to logical orientations", async () => {
    const cases = [
      { raw: "free\n", mode: "free", rotation: null, orientation: "auto" },
      { raw: "free 3\n", mode: "free", rotation: 3, orientation: "auto" },
      { raw: "lock 0\n", mode: "lock", rotation: 0, orientation: "portrait" },
      { raw: "lock 2\n", mode: "lock", rotation: 2, orientation: "portrait" },
      { raw: "lock 1\n", mode: "lock", rotation: 1, orientation: "landscape" },
      { raw: "lock 3\n", mode: "lock", rotation: 3, orientation: "landscape" },
      { raw: "lock\n", mode: "lock", rotation: null, orientation: "unknown" },
      { raw: "unexpected\n", mode: "unknown", rotation: null, orientation: "unknown" },
    ] as const;

    for (const entry of cases) {
      const runExec = (async () => result(entry.raw)) as typeof execText;
      await expect(getUserRotation("device-1", runExec)).resolves.toEqual({
        mode: entry.mode,
        rotation: entry.rotation,
        orientation: entry.orientation,
        raw: entry.raw.trim(),
      });
    }
  });

  test("encodes rotation mutations and returns the observed state", async () => {
    const cases = [
      { requested: "auto", command: "free", observed: "free" },
      { requested: "portrait", command: "lock 0", observed: "lock 0" },
      { requested: "landscape", command: "lock 1", observed: "lock 1" },
    ] as const;

    for (const entry of cases) {
      const calls: string[] = [];
      const runExec = (async (_command, args) => {
        calls.push(args.slice(3).join(" "));
        return result(calls.length === 1 ? "" : entry.observed);
      }) as typeof execText;
      const status = await setUserRotation("device-1", entry.requested, runExec);
      expect(calls).toEqual([
        `cmd window user-rotation ${entry.command}`,
        "cmd window user-rotation",
      ]);
      expect(status.raw).toBe(entry.observed);
    }
  });

  test("reports rotation command failures", async () => {
    const failed = (async () =>
      result("", { status: 1, stderr: "rotation denied" })) as typeof execText;
    await expect(getUserRotation("device-1", failed)).rejects.toThrow(
      "cmd window user-rotation failed: rotation denied",
    );
    await expect(
      setUserRotation("device-1", "landscape", failed),
    ).rejects.toThrow(
      "adb shell cmd window user-rotation lock 1 failed: rotation denied",
    );
  });
});

describe("ADB font controls", () => {
  test("reads positive finite font scales and rejects invalid settings", async () => {
    const valid = (async () => result(" 1.25\n")) as typeof execText;
    await expect(getFontScale("device-1", valid)).resolves.toEqual({
      scale: 1.25,
      raw: "1.25",
    });

    for (const raw of ["0", "-1", "not-a-number", "Infinity"]) {
      const invalid = (async () => result(raw)) as typeof execText;
      await expect(getFontScale("device-1", invalid)).rejects.toThrow(
        "Could not parse font_scale output",
      );
    }

    const failed = (async () =>
      result("", { status: 1, stderr: "settings unavailable" })) as typeof execText;
    await expect(getFontScale("device-1", failed)).rejects.toThrow(
      "settings get system font_scale failed: settings unavailable",
    );
  });

  test("validates, normalizes, writes, and re-reads font scale", async () => {
    for (const invalid of [Number.NaN, 0.69, 2.01]) {
      let calls = 0;
      const runExec = (async () => {
        calls++;
        return result("");
      }) as typeof execText;
      await expect(setFontScale("device-1", invalid, runExec)).rejects.toThrow(
        "font scale must be between 0.7 and 2.0",
      );
      expect(calls).toBe(0);
    }

    const calls: string[] = [];
    const runExec = (async (_command, args) => {
      calls.push(args.slice(3).join(" "));
      return result(calls.length === 1 ? "" : "1.2\n");
    }) as typeof execText;
    await expect(setFontScale("device-1", 1.2, runExec)).resolves.toEqual({
      scale: 1.2,
      raw: "1.2",
    });
    expect(calls).toEqual([
      "settings put system font_scale 1.2",
      "settings get system font_scale",
    ]);

    const failed = (async () =>
      result("", { status: 1, stderr: "write denied" })) as typeof execText;
    await expect(setFontScale("device-1", 1, failed)).rejects.toThrow(
      "adb shell settings put system font_scale 1 failed: write denied",
    );
  });
});

describe("ADB night mode controls", () => {
  test("parses formatted and raw night mode responses", async () => {
    const cases = [
      ["Night mode: yes\n", "dark"],
      ["NO\n", "light"],
      ["Night mode: auto\n", "auto"],
      ["Night mode: custom\n", "unknown"],
    ] as const;
    for (const [raw, mode] of cases) {
      const runExec = (async () => result(raw)) as typeof execText;
      await expect(getNightMode("device-1", runExec)).resolves.toEqual({
        mode,
        raw: raw.trim(),
      });
    }
  });

  test("maps mutations to uimode values and re-reads status", async () => {
    const cases = [
      ["dark", "yes"],
      ["light", "no"],
      ["auto", "auto"],
    ] as const;
    for (const [mode, value] of cases) {
      const calls: string[] = [];
      const runExec = (async (_command, args) => {
        calls.push(args.slice(3).join(" "));
        return result(calls.length === 1 ? "" : `Night mode: ${value}\n`);
      }) as typeof execText;
      await expect(setNightMode("device-1", mode, runExec)).resolves.toEqual({
        mode,
        raw: `Night mode: ${value}`,
      });
      expect(calls).toEqual([
        `cmd uimode night ${value}`,
        "cmd uimode night",
      ]);
    }
  });

  test("reports query and mutation failures", async () => {
    const failed = (async () =>
      result("", { status: 1, stderr: "uimode unavailable" })) as typeof execText;
    await expect(getNightMode("device-1", failed)).rejects.toThrow(
      "cmd uimode night failed: uimode unavailable",
    );
    await expect(setNightMode("device-1", "dark", failed)).rejects.toThrow(
      "adb shell cmd uimode night yes failed: uimode unavailable",
    );
  });
});

describe("ADB network controls", () => {
  test("distinguishes disabled, unknown, and indeterminate aggregate states", async () => {
    const values = new Map([
      ["wifi_on", "0\n"],
      ["mobile_data", "unavailable\n"],
    ]);
    const partiallyKnown = (async (_command, args) =>
      result(values.get(args.at(-1)!)!)) as typeof execText;
    await expect(getNetworkStatus("device-1", partiallyKnown)).resolves.toEqual({
      enabled: false,
      wifi: "disabled",
      mobileData: "unknown",
      raw: { wifi: "0", mobileData: "unavailable" },
    });

    const unknown = (async () => result("null\n")) as typeof execText;
    await expect(getNetworkStatus("device-1", unknown)).resolves.toEqual({
      enabled: null,
      wifi: "unknown",
      mobileData: "unknown",
      raw: { wifi: "null", mobileData: "null" },
    });
  });

  test("preserves the process error as the cause of a setting failure", async () => {
    const processError = new Error("adb disappeared");
    const failed = (async (_command, args) => {
      if (args.at(-1) === "wifi_on") {
        return result("", { status: null, error: processError });
      }
      return result("1");
    }) as typeof execText;

    try {
      await getNetworkStatus("device-1", failed);
      throw new Error("expected network query to reject");
    } catch (error) {
      expect((error as Error).message).toBe(
        "settings get global wifi_on failed: adb disappeared",
      );
      expect((error as Error).cause).toBe(processError);
    }
  });

  test("enables or disables both radios before returning observed settings", async () => {
    for (const enabled of [true, false]) {
      const calls: string[] = [];
      const action = enabled ? "enable" : "disable";
      const setting = enabled ? "1" : "0";
      const runExec = (async (_command, args) => {
        calls.push(args.slice(3).join(" "));
        return result(args.includes("settings") ? `${setting}\n` : "");
      }) as typeof execText;

      await expect(
        setNetworkEnabled("device-1", enabled, runExec),
      ).resolves.toEqual({
        enabled,
        wifi: enabled ? "enabled" : "disabled",
        mobileData: enabled ? "enabled" : "disabled",
        raw: { wifi: setting, mobileData: setting },
      });
      expect(calls).toEqual([
        `svc wifi ${action}`,
        `svc data ${action}`,
        "settings get global wifi_on",
        "settings get global mobile_data",
      ]);
    }
  });

  test("stops at the first radio mutation failure", async () => {
    const calls: string[] = [];
    const runExec = (async (_command, args) => {
      calls.push(args.slice(3).join(" "));
      return calls.length === 2
        ? result("", { status: 1, stderr: "data denied" })
        : result("");
    }) as typeof execText;

    await expect(
      setNetworkEnabled("device-1", true, runExec),
    ).rejects.toThrow("adb shell svc data enable failed: data denied");
    expect(calls).toEqual(["svc wifi enable", "svc data enable"]);
  });
});
