import { describe, expect, mock, test } from "bun:test";
import { parseBackendRequest, selectBackend } from "./backend-selection.ts";

describe("backend option", () => {
  test("defaults to auto and accepts the three explicit choices", () => {
    expect(parseBackendRequest(undefined)).toBe("auto");
    for (const value of ["auto", "scrcpy", "native"] as const) {
      expect(parseBackendRequest(value)).toBe(value);
    }
  });

  test("rejects invalid flags without repeating their values", () => {
    for (const value of ["", "Native", "h264", "auto ", "Bearer private-test-token"]) {
      expect(() => parseBackendRequest(value)).toThrow("--backend must be auto, scrcpy, or native.");
    }
  });
});

describe("backend selection", () => {
  test("auto prepares native on macOS emulators and permits comparison", async () => {
    const prepareNative = mock(async () => {});
    const selected = await selectBackend({ requested: "auto", platform: "darwin", serial: "emulator-5556", prepareNative });
    expect(prepareNative).toHaveBeenCalledTimes(1);
    expect(selected).toEqual({
      requestedBackend: "auto", defaultBackend: "native", availableBackends: ["scrcpy", "native"],
      platform: "darwin", reason: "Native capture is ready on macOS.",
    });
  });

  test.each(["linux", "win32"])("auto on %s uses scrcpy without probing native", async (platform) => {
    const prepareNative = mock(async () => { throw new Error("must not run"); });
    const selected = await selectBackend({ requested: "auto", platform, serial: "emulator-5556", prepareNative });
    expect(prepareNative).not.toHaveBeenCalled();
    expect(selected.defaultBackend).toBe("scrcpy");
    expect(selected.availableBackends).toEqual(["scrcpy"]);
    expect(selected.platform).toBe(platform);
  });

  test.each(["darwin", "linux", "win32"])("forced scrcpy on %s never initializes native", async (platform) => {
    const prepareNative = mock(async () => { throw new Error("must not run"); });
    const selected = await selectBackend({ requested: "scrcpy", platform, serial: "emulator-5556", prepareNative });
    expect(prepareNative).not.toHaveBeenCalled();
    expect(selected.requestedBackend).toBe("scrcpy");
    expect(selected.defaultBackend).toBe("scrcpy");
    expect(selected.availableBackends).toEqual(["scrcpy"]);
  });

  test.each(["physical-device-serial", "192.168.1.10:5555", "emulator-", "emulator-5556-extra"])("auto skips native for serial %s", async (serial) => {
    const prepareNative = mock(async () => {});
    const selected = await selectBackend({ requested: "auto", platform: "darwin", serial, prepareNative });
    expect(prepareNative).not.toHaveBeenCalled();
    expect(selected.defaultBackend).toBe("scrcpy");
    expect(selected.availableBackends).toEqual(["scrcpy"]);
  });

  test("auto falls back if preparation fails and never publishes the underlying error", async () => {
    const secret = "Bearer private-test-token";
    const prepareNative = mock(async () => { throw new Error(`Missing FFmpeg; grpc.token=${secret}`); });
    const selected = await selectBackend({ requested: "auto", platform: "darwin", serial: "emulator-5556", prepareNative });
    expect(prepareNative).toHaveBeenCalledTimes(1);
    expect(selected.defaultBackend).toBe("scrcpy");
    expect(selected.availableBackends).toEqual(["scrcpy"]);
    expect(selected.reason).toBe("Native capture preparation failed; using scrcpy.");
    expect(JSON.stringify(selected)).not.toContain(secret);
  });

  test("forced native prepares and locks the available backend", async () => {
    const prepareNative = mock(async () => {});
    const selected = await selectBackend({ requested: "native", platform: "darwin", serial: "emulator-5556", prepareNative });
    expect(prepareNative).toHaveBeenCalledTimes(1);
    expect(selected.requestedBackend).toBe("native");
    expect(selected.defaultBackend).toBe("native");
    expect(selected.availableBackends).toEqual(["native"]);
  });

  test.each(["linux", "win32"])("forced native on %s fails before preparation", async (platform) => {
    const prepareNative = mock(async () => {});
    await expect(selectBackend({ requested: "native", platform, serial: "emulator-5556", prepareNative }))
      .rejects.toThrow("Use --backend scrcpy on this platform.");
    expect(prepareNative).not.toHaveBeenCalled();
  });

  test("forced native on a physical device fails before preparation", async () => {
    const prepareNative = mock(async () => {});
    await expect(selectBackend({ requested: "native", platform: "darwin", serial: "physical-device-serial", prepareNative }))
      .rejects.toThrow("Use --backend scrcpy for this device.");
    expect(prepareNative).not.toHaveBeenCalled();
  });

  test("forced native preparation failure throws an actionable error without falling back or leaking cause", async () => {
    const secret = "Bearer private-test-token";
    const prepareNative = mock(async () => { throw new Error(`Discovery failed: ${secret}`); });
    let failure: unknown;
    try {
      await selectBackend({ requested: "native", platform: "darwin", serial: "emulator-5556", prepareNative });
    } catch (error) {
      failure = error;
    }
    expect(prepareNative).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("Check emulator gRPC discovery and authentication");
    expect((failure as Error).message).toContain("FFmpeg with h264_videotoolbox");
    expect((failure as Error).message).not.toContain(secret);
    expect((failure as Error).cause).toBeUndefined();
  });
});
