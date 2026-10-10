import { describe, expect, test } from "bun:test";
import { setEmulatorLocationAsync } from "../src/location.ts";

describe("setEmulatorLocationAsync", () => {
  test("rejects a pre-aborted location update before starting adb", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      setEmulatorLocationAsync(
        "emulator-5554",
        { latitude: 51.5, longitude: -0.12 },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  test("aborting an active update passes the signal to adb and rejects with its reason", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const update = setEmulatorLocationAsync(
      "emulator-5554",
      { latitude: 51.5, longitude: -0.12 },
      controller.signal,
      (async (_cmd, _args, opts) => {
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
      }) as typeof import("../src/exec.ts").execText,
    );

    expect(observedSignal).toBe(controller.signal);
    controller.abort(new DOMException("test abort", "AbortError"));

    await expect(update).rejects.toMatchObject({
      name: "AbortError",
      message: "test abort",
    });
  });
});
