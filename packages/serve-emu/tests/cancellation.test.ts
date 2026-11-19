import { describe, expect, test } from "bun:test";
import { getAccessibilitySnapshot } from "../src/accessibility.ts";
import { setEmulatorLocationAsync } from "../src/location.ts";
import { startScrcpy } from "../src/scrcpy.ts";

describe("generation cancellation", () => {
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
        { latitude: 51.5, longitude: -0.1 }, { signal: controller.signal, execText: record("execText") as never },
      ),
    ).rejects.toBe(reason);
    expect(commands).toEqual([]);
    await expect(
      getAccessibilitySnapshot("not-a-device", { signal: controller.signal }),
    ).rejects.toBe(reason);
  });
});
