import { describe, expect, test } from "bun:test";
import type { execText } from "../src/exec.ts";
import { parseGeoFix, setEmulatorLocationAsync } from "../src/location.ts";

type ExecResult = Awaited<ReturnType<typeof execText>>;

/** A runner that answers every command with `result` (a clean exit by default). */
function answering(result: Partial<ExecResult>): typeof execText {
  return (async () => ({
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    error: null,
    ...result,
  })) as typeof execText;
}

describe("parseGeoFix", () => {
  test("accepts inclusive coordinate limits and nullable optional values", () => {
    expect(
      parseGeoFix({
        latitude: -90,
        longitude: 180,
        altitude: -1_000,
        satellites: 1,
        velocity: 0,
      }),
    ).toEqual({
      latitude: -90,
      longitude: 180,
      altitude: -1_000,
      satellites: 1,
      velocity: 0,
    });
    expect(
      parseGeoFix({ latitude: 90, longitude: -180, altitude: null, satellites: null }),
    ).toEqual({
      latitude: 90,
      longitude: -180,
      altitude: undefined,
      satellites: undefined,
      velocity: undefined,
    });
  });

  test("rejects malformed payloads and every bounded numeric field", () => {
    for (const value of [null, [], "location"] as const) {
      expect(() => parseGeoFix(value)).toThrow("location payload must be an object");
    }
    expect(() => parseGeoFix({ latitude: Number.NaN, longitude: 0 })).toThrow(
      "latitude must be a finite number",
    );
    expect(() => parseGeoFix({ latitude: 91, longitude: 0 })).toThrow(
      "latitude must be between -90 and 90",
    );
    expect(() => parseGeoFix({ latitude: 0, longitude: -181 })).toThrow(
      "longitude must be between -180 and 180",
    );
    expect(() => parseGeoFix({ latitude: 0, longitude: 0, altitude: 100_001 })).toThrow(
      "altitude must be between -1000 and 100000",
    );
    expect(() => parseGeoFix({ latitude: 0, longitude: 0, satellites: 1.5 })).toThrow(
      "satellites must be an integer",
    );
    expect(() => parseGeoFix({ latitude: 0, longitude: 0, satellites: 65 })).toThrow(
      "satellites must be between 1 and 64",
    );
    expect(() => parseGeoFix({ latitude: 0, longitude: 0, velocity: -1 })).toThrow(
      "velocity must be between 0 and 1000",
    );
  });
});

describe("setEmulatorLocationAsync", () => {
  test("uses the shared interactive executor lane", async () => {
    const calls: Array<{
      cmd: string;
      args: string[];
      options: Record<string, unknown>;
    }> = [];
    const runExec = (async (cmd, args, options) => {
      calls.push({ cmd, args, options: options ?? {} });
      return {
        status: 0,
        signal: null,
        stdout: "OK\n",
        stderr: "",
        timedOut: false,
        error: null,
      };
    }) as typeof execText;

    await setEmulatorLocationAsync(
      "emulator-5554",
      {
        latitude: 51.5007292,
        longitude: -0.1246254,
        altitude: 15,
        satellites: 8,
        velocity: 1.25,
      },
      { execText: runExec },
    );

    expect(calls).toEqual([
      {
        cmd: "adb",
        args: [
          "-s",
          "emulator-5554",
          "emu",
          "geo",
          "fix",
          "-0.1246254",
          "51.5007292",
          "15",
          "8",
          "1.25",
        ],
        options: {
          timeout: 5_000,
          maxBuffer: 64 * 1024,
          lane: "interactive",
        },
      },
    ]);
  });

  test("rejects physical-device serials before invoking adb", async () => {
    let calls = 0;
    const runExec = (async () => {
      calls += 1;
      throw new Error("must not run");
    }) as typeof execText;

    await expect(
      setEmulatorLocationAsync("device-123", { latitude: 0, longitude: 0 }, { execText: runExec }),
    ).rejects.toThrow("Android Emulator serials only");
    expect(calls).toBe(0);
  });

  test("preserves timeout and emulator KO failures", async () => {
    await expect(
      setEmulatorLocationAsync(
        "emulator-5554",
        { latitude: 0, longitude: 0 },
        {
          execText: answering({
            status: null,
            signal: "SIGKILL",
            timedOut: true,
            error: new Error("deadline"),
          }),
        },
      ),
    ).rejects.toThrow("adb emu geo fix timed out");

    await expect(
      setEmulatorLocationAsync(
        "emulator-5554",
        { latitude: 0, longitude: 0 },
        { execText: answering({ status: 1, stdout: "KO: bad coordinates\n" }) },
      ),
    ).rejects.toThrow("adb emu geo fix failed: KO: bad coordinates");
  });

  test("preserves executor failure output and cause", async () => {
    const failure = new Error("spawn failed");
    try {
      await setEmulatorLocationAsync(
        "emulator-5554",
        { latitude: 1, longitude: 2 },
        {
          execText: answering({
            status: null,
            stderr: "adb unavailable\n",
            error: failure,
          }),
        },
      );
      throw new Error("expected location update to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("adb emu geo fix failed: adb unavailable");
      expect((error as Error).cause).toBe(failure);
    }
  });

  test("rejects a pre-aborted location update before starting adb", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      setEmulatorLocationAsync(
        "emulator-5554",
        { latitude: 51.5, longitude: -0.12 },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  test("aborting an active update passes the signal to adb and rejects with its reason", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const update = setEmulatorLocationAsync(
      "emulator-5554",
      { latitude: 51.5, longitude: -0.12 },
      {
        signal: controller.signal,
        execText: (async (_cmd, _args, opts) => {
          observedSignal = opts?.signal;
          await new Promise<void>((resolve) =>
            opts?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
          return {
            status: null,
            signal: "SIGKILL",
            stdout: "",
            stderr: "",
            timedOut: false,
            error: new Error("command was aborted", {
              cause: opts?.signal?.reason,
            }),
          };
        }) as typeof execText,
      },
    );

    expect(observedSignal).toBe(controller.signal);
    controller.abort(new DOMException("test abort", "AbortError"));

    await expect(update).rejects.toMatchObject({
      name: "AbortError",
      message: "test abort",
    });
  });

  test("rejects a non-Error abort reason after adb settles", async () => {
    const controller = new AbortController();
    const runExec = (async () => {
      controller.abort("cancelled");
      return {
        status: 0,
        signal: null,
        stdout: "OK\n",
        stderr: "",
        timedOut: false,
        error: null,
      };
    }) as typeof execText;

    await expect(
      setEmulatorLocationAsync(
        "emulator-5554",
        { latitude: 1, longitude: 2 },
        { signal: controller.signal, execText: runExec },
      ),
    ).rejects.toThrow("location update aborted");
  });
});
