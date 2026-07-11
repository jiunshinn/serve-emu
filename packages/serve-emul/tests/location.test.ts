import { describe, expect, test } from "bun:test";
import {
  setEmulatorLocationAsync,
  type LocationChildProcess,
} from "../src/location.ts";

class FakeLocationChild implements LocationChildProcess {
  stdout = {
    setEncoding: () => {},
    on: () => {},
  };
  stderr = {
    setEncoding: () => {},
    on: () => {},
  };
  killSignals: string[] = [];
  #errorListeners: Array<(error: Error) => void> = [];
  #exitListeners: Array<(status: number | null) => void> = [];

  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (status: number | null) => void): unknown;
  once(
    event: "error" | "exit",
    listener: ((error: Error) => void) | ((status: number | null) => void),
  ): unknown {
    if (event === "error") {
      this.#errorListeners.push(listener as (error: Error) => void);
    } else {
      this.#exitListeners.push(listener as (status: number | null) => void);
    }
    return this;
  }

  kill(signal: "SIGKILL"): boolean {
    this.killSignals.push(signal);
    return true;
  }

  emitExit(status: number | null): void {
    for (const listener of this.#exitListeners) listener(status);
  }
}

class TrackingAbortSignal {
  aborted = false;
  reason: unknown;
  listeners = new Set<EventListenerOrEventListenerObject>();

  addEventListener(
    _type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    this.listeners.delete(listener);
  }

  abort(): void {
    this.aborted = true;
    this.reason = new DOMException("test abort", "AbortError");
    const event = new Event("abort");
    for (const listener of [...this.listeners]) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  }
}

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

  test("aborting an active update kills adb and cleans timer and signal listeners", async () => {
    const child = new FakeLocationChild();
    const signal = new TrackingAbortSignal();
    const clearedTimers: unknown[] = [];
    let timeoutCallback: (() => void) | undefined;
    let spawnedArgs: string[] | undefined;
    const update = setEmulatorLocationAsync(
      "emulator-5554",
      { latitude: 51.5, longitude: -0.12 },
      signal as unknown as AbortSignal,
      {
        spawn: (args) => {
          spawnedArgs = args;
          return child;
        },
        setTimeout: (callback) => {
          timeoutCallback = callback;
          return 42;
        },
        clearTimeout: (handle) => clearedTimers.push(handle),
      },
    );

    expect(spawnedArgs?.slice(0, 4)).toEqual([
      "-s",
      "emulator-5554",
      "emu",
      "geo",
    ]);
    expect(signal.listeners.size).toBe(1);
    signal.abort();

    await expect(update).rejects.toMatchObject({
      name: "AbortError",
      message: "test abort",
    });
    expect(child.killSignals).toEqual(["SIGKILL"]);
    expect(clearedTimers).toEqual([42]);
    expect(signal.listeners.size).toBe(0);

    child.emitExit(0);
    timeoutCallback?.();
    expect(child.killSignals).toEqual(["SIGKILL"]);
    expect(clearedTimers).toEqual([42]);
  });
});
