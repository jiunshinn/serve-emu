import { describe, expect, test } from "bun:test";
import { getAccessibilitySnapshot } from "../src/accessibility.ts";
import { execText } from "../src/exec.ts";
import { setEmulatorLocationAsync } from "../src/location.ts";
import { startScrcpy } from "../src/scrcpy.ts";

describe("generation cancellation", () => {
  test("kills an active command and releases the executor slot", async () => {
    const controller = new AbortController();
    const reason = new Error("generation changed");
    const startedMs = Date.now();
    const running = execText(
      process.execPath,
      ["-e", "await Bun.sleep(5000)"],
      { signal: controller.signal, timeout: 10_000 },
    );
    setTimeout(() => controller.abort(reason), 20);

    const result = await running;
    expect(result.error?.cause).toBe(reason);
    expect(Date.now() - startedMs).toBeLessThan(1_500);
    const probe = await execText(
      process.execPath,
      ["-e", "console.log('released')"],
      { timeout: 2_000 },
    );
    expect(probe.status).toBe(0);
    expect(probe.stdout.trim()).toBe("released");
  });

  test("does not start scrcpy or location work for an aborted generation", async () => {
    const controller = new AbortController();
    const reason = new Error("server stopping");
    controller.abort(reason);
    // Every runner records instead of reaching a real adb.
    const commands: string[] = [];
    const record = (name: string) => () => {
      commands.push(name);
      throw new Error(`${name} must not run for an aborted generation`);
    };

    await expect(
      startScrcpy(
        { serial: "not-a-device", signal: controller.signal },
        {
          ensureServer: record("ensureServer"),
          runAdb: record("runAdb"),
          spawnAdb: record("spawnAdb"),
          connect: record("connect"),
        },
      ),
    ).rejects.toBe(reason);
    await expect(
      setEmulatorLocationAsync(
        "emulator-5554",
        { latitude: 51.5, longitude: -0.1 },
        controller.signal,
        record("execText") as never,
      ),
    ).rejects.toBe(reason);
    expect(commands).toEqual([]);
    await expect(
      getAccessibilitySnapshot("not-a-device", controller.signal),
    ).rejects.toBe(reason);
  });
});
