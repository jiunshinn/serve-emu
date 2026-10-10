import { describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import { SCRCPY_VERSION } from "../scripts/fetch-scrcpy.ts";
import { CommandFailureError } from "../src/command-failure.ts";
import {
  startScrcpy,
  type AdbCommandResult,
  type ScrcpyDependencies,
} from "../src/scrcpy.ts";

const SERIAL = "device-test-serial";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function ok(stdout = ""): AdbCommandResult {
  return { status: 0, stdout, stderr: "", timedOut: false, error: null };
}

function failed(stderr: string): AdbCommandResult {
  return { status: 1, stdout: "", stderr, timedOut: false, error: null };
}

function signalReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("operation aborted");
}

function waitForDeferred<T>(value: Deferred<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signalReason(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signalReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    value.promise.then(
      (result) => finish(() => resolve(result)),
      (reason) => finish(() => reject(reason)),
    );
    if (signal.aborted) onAbort();
  });
}

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly killSignals: NodeJS.Signals[] = [];
  exited = false;
  ignoreKill = false;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killSignals.push(signal);
    if (this.exited) return false;
    if (this.ignoreKill) return true;
    queueMicrotask(() => this.exit(null, signal));
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

class FakeSocket extends EventEmitter {
  readonly label: string;
  destroyCalls = 0;
  destroyed = false;
  #queuedData: Buffer[] = [];
  #flushScheduled = false;

  constructor(label: string, initialData?: Buffer) {
    super();
    this.label = label;
    if (initialData) this.#queuedData.push(initialData);
  }

  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    if (event === "data") this.#scheduleFlush();
    return this;
  }

  droppedBytes = 0;

  /** Bun's semantics: data that finds no `data` listener is lost. */
  arrive(data: Buffer): void {
    if (this.listenerCount("data") === 0) {
      this.droppedBytes += data.length;
      return;
    }
    this.emit("data", data);
  }

  destroy(): this {
    this.destroyCalls++;
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit("close");
    return this;
  }

  #scheduleFlush(): void {
    if (
      this.#flushScheduled ||
      this.#queuedData.length === 0 ||
      this.listenerCount("data") === 0
    ) {
      return;
    }
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      while (this.#queuedData.length > 0 && !this.destroyed) {
        this.emit("data", this.#queuedData.shift()!);
      }
    });
  }
}

function v4Stream(): Buffer {
  const preamble = Buffer.alloc(81);
  preamble[0] = 0;
  Buffer.from("Lifecycle Device", "utf8").copy(preamble, 1);
  preamble.writeUInt32BE(0x68323634, 65);
  preamble.writeUInt32BE(0x80000000, 69);
  preamble.writeUInt32BE(1080, 73);
  preamble.writeUInt32BE(1920, 77);

  const payload = Buffer.from([0, 0, 0, 1, 0x65]);
  const header = Buffer.alloc(12);
  header.writeBigUInt64BE((1n << 61n) | 123n, 0);
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([preamble, header, payload]);
}

type AdbCall = {
  serial: string;
  args: string[];
  timeoutMs: number;
  signal: AbortSignal;
  abortedAtCall: boolean;
};

type ConnectCall = {
  port: number;
  timeoutMs: number;
  signal: AbortSignal;
  abortedAtCall: boolean;
};

// What the fake serverFingerprint reports for the local jar.
const JAR_FINGERPRINT = "a".repeat(64);
// sha256 of an empty file.
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

type HarnessOptions = {
  /**
   * The video bytes arrive while the control socket connects, on a socket
   * that drops data without a listener (as Bun's node:net does).
   */
  videoDataDuringControlConnect?: boolean;
  cacheInitially?: boolean;
  /** The device cache's sha256sum; null when the file is missing. */
  cacheDigest?: string | null;
  /** The device has no sha256sum binary. */
  sha256Missing?: boolean;
  deferProbe?: boolean;
  deferSocketPoll?: boolean;
  /** Socket-poll results returned, in order, before the listing has the socket. */
  socketPollResults?: AdbCommandResult[];
  blockConnectIndex?: number;
  deferFirstRemove?: boolean;
  dynamicResult?: AdbCommandResult;
  ambiguousForwardPort?: number;
  fixedResults?: AdbCommandResult[];
  removeResult?: AdbCommandResult;
  rmResults?: AdbCommandResult[];
  childIgnoresKill?: boolean;
  /** Result of `adb push`; "hang" never settles until aborted. */
  pushResult?: AdbCommandResult | "hang";
  syncResult?: AdbCommandResult;
};

function createHarness(options: HarnessOptions = {}) {
  const probeDeferred = deferred<AdbCommandResult>();
  const probeReached = deferred<AdbCall>();
  const socketPollDeferred = deferred<AdbCommandResult>();
  const socketPollReached = deferred<AdbCall>();
  const connectBlocked = deferred<ConnectCall>();
  const connectDeferred = deferred<Socket>();
  const removeDeferred = deferred<AdbCommandResult>();
  const removeReached = deferred<AdbCall>();

  const state = {
    adbCalls: [] as AdbCall[],
    connectCalls: [] as ConnectCall[],
    sockets: [] as FakeSocket[],
    children: [] as FakeChild[],
    spawnCalls: [] as { serial: string; args: string[]; child: FakeChild }[],
    timerDurations: [] as number[],
    sleepCalls: [] as { ms: number; signal: AbortSignal }[],
    activeForwards: new Map<number, string>(),
    events: [] as string[],
    cacheDigest:
      options.cacheDigest !== undefined
        ? options.cacheDigest
        : options.cacheInitially
          ? JAR_FINGERPRINT
          : null,
    pushCount: 0,
    fixedAttempt: 0,
    removeWasDeferred: false,
    rmAttempt: 0,
    socketPollAttempt: 0,
    scidIndex: 0,
  };

  const runAdb = async (
    serial: string,
    args: string[],
    commandOptions: { timeoutMs: number; signal: AbortSignal },
  ): Promise<AdbCommandResult> => {
    const call: AdbCall = {
      serial,
      args: [...args],
      timeoutMs: commandOptions.timeoutMs,
      signal: commandOptions.signal,
      abortedAtCall: commandOptions.signal.aborted,
    };
    state.adbCalls.push(call);
    state.events.push(`adb:${args.join(" ")}`);

    if (args[0] === "shell" && args[1] === "sha256sum") {
      if (options.deferProbe) {
        probeReached.resolve(call);
        return waitForDeferred(probeDeferred, commandOptions.signal);
      }
      if (options.sha256Missing) {
        return { ...failed("/system/bin/sh: sha256sum: inaccessible or not found"), status: 127 };
      }
      return state.cacheDigest === null
        ? failed(`sha256sum: ${args[2]}: No such file or directory`)
        : ok(`${state.cacheDigest}  ${args[2]}\n`);
    }
    if (args[0] === "shell" && args[1] === "sync") return options.syncResult ?? ok();
    if (args[0] === "push") {
      state.pushCount++;
      if (options.pushResult === "hang") {
        return waitForDeferred(deferred<AdbCommandResult>(), commandOptions.signal);
      }
      return options.pushResult ?? ok("pushed");
    }
    if (args[0] === "shell" && args[1] === "mv") {
      state.cacheDigest = JAR_FINGERPRINT;
      return ok();
    }
    if (args[0] === "shell" && args[1] === "cp") return ok();
    if (args[0] === "shell" && args[1] === "rm") {
      return options.rmResults?.[state.rmAttempt++] ?? ok();
    }

    if (args[0] === "forward" && args[1] === "tcp:0") {
      const target = args[2];
      if (options.ambiguousForwardPort !== undefined) {
        state.activeForwards.set(options.ambiguousForwardPort, target);
      }
      if (options.dynamicResult) return options.dynamicResult;
      state.activeForwards.set(27123, target);
      return ok("27123\n");
    }
    if (args[0] === "forward" && args[1] === "--no-rebind") {
      const result = options.fixedResults?.[state.fixedAttempt] ?? failed("port busy");
      state.fixedAttempt++;
      if (result.status === 0) {
        state.activeForwards.set(Number(args[2].slice("tcp:".length)), args[3]);
      }
      return result;
    }
    if (args[0] === "forward" && args[1] === "--list") {
      const stdout = Array.from(
        state.activeForwards,
        ([port, target]) => `${serial} tcp:${port} ${target}`,
      ).join("\n");
      return ok(stdout ? `${stdout}\n` : "");
    }
    if (args[0] === "forward" && args[1] === "--remove") {
      const port = Number(args[2].slice("tcp:".length));
      if (options.deferFirstRemove && !state.removeWasDeferred) {
        state.removeWasDeferred = true;
        removeReached.resolve(call);
        const result = await waitForDeferred(removeDeferred, commandOptions.signal);
        if (result.status === 0) state.activeForwards.delete(port);
        return result;
      }
      const result = options.removeResult ?? ok();
      if (result.status === 0) state.activeForwards.delete(port);
      return result;
    }
    if (
      args[0] === "shell" &&
      args[1] === "cat" &&
      args[2] === "/proc/net/unix"
    ) {
      if (options.deferSocketPoll) {
        socketPollReached.resolve(call);
        return waitForDeferred(socketPollDeferred, commandOptions.signal);
      }
      const scripted = options.socketPollResults?.[state.socketPollAttempt++];
      if (scripted) return scripted;
      const spawn = state.spawnCalls.at(-1);
      const scid = spawn?.args.find((arg) => arg.startsWith("scid="))?.slice(5);
      return ok(`00000000: @scrcpy_${scid}\n`);
    }

    throw new Error(`Unexpected fake adb command: adb -s ${serial} ${args.join(" ")}`);
  };

  const deps: ScrcpyDependencies = {
    ensureServer: async () => "/fake/scrcpy-server.jar",
    serverFingerprint: async () => JAR_FINGERPRINT,
    runAdb,
    spawnAdb: (serial, args) => {
      const child = new FakeChild();
      child.ignoreKill = options.childIgnoresKill ?? false;
      state.children.push(child);
      state.spawnCalls.push({ serial, args: [...args], child });
      state.events.push("spawn");
      return child as unknown as ChildProcess;
    },
    connect: async (port, timeoutMs, signal) => {
      const call: ConnectCall = {
        port,
        timeoutMs,
        signal,
        abortedAtCall: signal.aborted,
      };
      const index = state.connectCalls.length;
      state.connectCalls.push(call);
      state.events.push(`connect:${index}`);
      if (options.blockConnectIndex === index) {
        connectBlocked.resolve(call);
        return waitForDeferred(connectDeferred, signal);
      }
      if (options.videoDataDuringControlConnect && index % 2 === 1) {
        state.sockets[index - 1]!.arrive(v4Stream());
      }
      const socket = new FakeSocket(
        index % 2 === 0 ? `video-${index / 2}` : `control-${(index - 1) / 2}`,
        index % 2 === 0 && !options.videoDataDuringControlConnect
          ? v4Stream()
          : undefined,
      );
      state.sockets.push(socket);
      return socket as unknown as Socket;
    },
    sleep: async (ms, signal) => {
      state.sleepCalls.push({ ms, signal });
      if (signal.aborted) throw signalReason(signal);
    },
    randomScid: () => `0123456${state.scidIndex++}`,
    pickPort: () => 28000 + state.fixedAttempt,
    setTimer: (callback, ms) => {
      state.timerDurations.push(ms);
      return setTimeout(callback, ms);
    },
    clearTimer: (timer) => clearTimeout(timer),
    timeouts: {
      pushMs: 500,
      copyMs: 500,
      forwardMs: 500,
      socketPollMs: 500,
      socketReadyMs: 500,
      connectMs: 500,
      preambleMs: 500,
      processExitMs: 100,
      cleanupMs: 500,
    },
  };

  return {
    deps,
    state,
    probeDeferred,
    probeReached,
    socketPollDeferred,
    socketPollReached,
    connectBlocked,
    connectDeferred,
    removeDeferred,
    removeReached,
  };
}

function startWith(
  harness: ReturnType<typeof createHarness>,
  options: { signal?: AbortSignal } = {},
) {
  return startScrcpy({ serial: SERIAL, signal: options.signal }, harness.deps);
}

describe("scrcpy async lifecycle", () => {
  test("preserves the two-socket protocol, reuses the cached jar, and closes once", async () => {
    const harness = createHarness({ deferFirstRemove: true });
    const first = await startWith(harness);

    expect(first.protocol).toBe(4);
    expect(first.meta).toEqual({
      deviceName: "Lifecycle Device",
      codecId: "h264",
      width: 1080,
      height: 1920,
    });
    expect(harness.state.connectCalls.map((call) => call.port)).toEqual([
      first.localPort,
      first.localPort,
    ]);
    expect(first.videoReader.sock as unknown).toBe(harness.state.sockets[0]);
    expect(first.controlSocket as unknown).toBe(harness.state.sockets[1]);

    const frame = await first.readFrame();
    expect(frame).toEqual({
      type: "frame",
      data: Buffer.from([0, 0, 0, 1, 0x65]),
      pts: 123n,
      isConfig: false,
      isKey: true,
    });

    expect(harness.state.spawnCalls[0].args).toEqual([
      "shell",
      "CLASSPATH=/data/local/tmp/serve-emu-scrcpy-01234560.jar",
      "app_process",
      "/",
      "com.genymobile.scrcpy.Server",
      SCRCPY_VERSION,
      "scid=01234560",
      "log_level=info",
      "audio=false",
      "tunnel_forward=true",
      "control=true",
      "send_dummy_byte=true",
      "send_stream_meta=true",
      "send_frame_meta=true",
      "send_device_meta=true",
      "max_size=1280",
      "video_bit_rate=8000000",
      "max_fps=60",
      "video_codec_options=i-frame-interval=10",
      "cleanup=true",
    ]);
    expect(harness.state.pushCount).toBe(1);

    const closeOne = first.close();
    const closeTwo = first.close();
    expect(closeTwo).toBe(closeOne);
    let closeSettled = false;
    void closeOne.then(() => {
      closeSettled = true;
    });
    await harness.removeReached.promise;
    expect(closeSettled).toBe(false);
    harness.removeDeferred.resolve(ok());
    await closeOne;

    expect(harness.state.sockets.slice(0, 2).map((socket) => socket.destroyCalls)).toEqual([
      1,
      1,
    ]);
    expect(harness.state.children[0].killSignals).toEqual(["SIGTERM"]);

    const second = await startWith(harness);
    expect(harness.state.pushCount).toBe(1);
    expect(
      harness.state.adbCalls.filter(
        (call) =>
          call.args[0] === "shell" && call.args[1] === "sha256sum",
      ),
    ).toHaveLength(2);
    await second.close();
  });

  test("keeps video bytes that arrive while the control socket connects (#162)", async () => {
    const harness = createHarness({ videoDataDuringControlConnect: true });
    const session = await startWith(harness);

    expect(harness.state.sockets[0]!.droppedBytes).toBe(0);
    expect(session.meta.deviceName).toBe("Lifecycle Device");
    expect(await session.readFrame()).toMatchObject({ isKey: true, pts: 123n });
    await session.close();
  });

  test("a deferred adb command does not block unrelated timers", async () => {
    const harness = createHarness({ deferProbe: true });
    let startupSettled = false;
    const startup = startWith(harness).finally(() => {
      startupSettled = true;
    });
    await harness.probeReached.promise;

    let timerRan = false;
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        timerRan = true;
        resolve();
      }, 0),
    );
    expect(timerRan).toBe(true);
    expect(startupSettled).toBe(false);

    harness.probeDeferred.resolve(failed("cache miss"));
    const session = await startup;
    await session.close();
  });

  test("a child exit aborts socket discovery immediately and cleans its forward", async () => {
    const harness = createHarness({ deferSocketPoll: true });
    const startup = startWith(harness);
    const outcome = startup.then(
      () => ({ error: null as Error | null }),
      (error) => ({ error: error as Error }),
    );
    const pollCall = await harness.socketPollReached.promise;

    const stderrWrite = spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );
    try {
      harness.state.children[0].stderr.emit(
        "data",
        Buffer.from("java.lang.RuntimeException at /home/me/SECRET-PATH\n"),
      );
    } finally {
      stderrWrite.mockRestore();
    }
    harness.state.children[0].exit(17, null);
    const { error } = await outcome;
    // The server's stderr stays in the message for logs, not the public one.
    expect(error).toBeInstanceOf(CommandFailureError);
    expect(error).toMatchObject({
      code: "adb-failed",
      publicMessage: "scrcpy process exited during startup (code=17, signal=none)",
    });
    expect(error?.message).toContain("/home/me/SECRET-PATH");

    expect(pollCall.signal.aborted).toBe(true);
    expect(harness.state.activeForwards.size).toBe(0);
    expect(
      harness.state.adbCalls.some(
        (call) =>
          call.args[0] === "forward" && call.args[1] === "--remove",
      ),
    ).toBe(true);
  });

  test("socket discovery retries a single transiently closed poll", async () => {
    const harness = createHarness({
      socketPollResults: [failed("error: closed")],
    });
    const session = await startWith(harness);

    expect(harness.state.socketPollAttempt).toBe(2);
    await session.close();
  });

  test("socket discovery keeps polling while a successful listing lacks the socket", async () => {
    const harness = createHarness({
      socketPollResults: [
        ok("00000000: 00000002 00000000 00010000 0001 01 1 @android.net.wifi.closed\n"),
        ok("00000000: 00000002 00000000 00010000 0001 01 2 @device.not found offline\n"),
      ],
    });
    const session = await startWith(harness);

    expect(harness.state.socketPollAttempt).toBe(3);
    await session.close();
  });

  test.each([
    ["the device goes offline", [failed("adb: device offline")]],
    ["adb closes the device connection twice", [failed("error: closed"), failed("error: closed")]],
  ])("socket discovery fails fast when %s", async (_, socketPollResults) => {
    const harness = createHarness({ socketPollResults });

    const error = await startWith(harness).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({
      code: "adb-device-unavailable",
      publicMessage: "adb shell cat failed: the device is unavailable",
    });
    expect((error as Error).message).toMatch(
      /^adb shell cat failed: the device is unavailable: adb -s device-test-serial shell cat \/proc\/net\/unix: (?:adb: device offline|error: closed)$/,
    );
    expect(harness.state.socketPollAttempt).toBe(socketPollResults.length);
    expect(harness.state.activeForwards.size).toBe(0);
  });

  test("external cancellation during the control connection tears down acquired resources", async () => {
    const harness = createHarness({ blockConnectIndex: 1 });
    const controller = new AbortController();
    const startup = startWith(harness, { signal: controller.signal });
    const outcome = startup.then(
      () => ({ error: null as Error | null }),
      (error) => ({ error: error as Error }),
    );
    const blockedCall = await harness.connectBlocked.promise;

    controller.abort(new Error("cancelled by lifecycle test"));
    expect((await outcome).error?.message).toContain("cancelled by lifecycle test");

    expect(blockedCall.signal.aborted).toBe(true);
    expect(harness.state.connectCalls).toHaveLength(2);
    expect(harness.state.sockets).toHaveLength(1);
    expect(harness.state.sockets[0].destroyCalls).toBe(1);
    expect(harness.state.children[0].killSignals).toContain("SIGTERM");
    expect(harness.state.activeForwards.size).toBe(0);
  });

  test("an ambiguous dynamic-forward timeout removes the target discovered during cleanup", async () => {
    const ambiguousPort = 29991;
    const harness = createHarness({
      dynamicResult: {
        status: null,
        stdout: "",
        stderr: "adb daemon timed out",
        timedOut: true,
        error: null,
      },
      ambiguousForwardPort: ambiguousPort,
      fixedResults: Array.from({ length: 5 }, () => failed("port busy")),
    });

    const error = await startWith(harness).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(CommandFailureError);
    expect(error).toMatchObject({
      code: "adb-failed",
      publicMessage: "adb forward failed",
      message: "adb forward failed: localabstract:scrcpy_01234560: port busy",
    });

    expect(harness.state.spawnCalls).toHaveLength(0);
    expect(harness.state.fixedAttempt).toBe(5);
    expect(harness.state.activeForwards.size).toBe(0);
    expect(
      harness.state.adbCalls.some(
        (call) =>
          call.args[0] === "forward" &&
          call.args[1] === "--remove" &&
          call.args[2] === `tcp:${ambiguousPort}`,
      ),
    ).toBe(true);
  });

  test("a failed adb step names only its subcommand in the public message", async () => {
    const harness = createHarness({
      pushResult: failed(
        "adb: error: failed to copy '/fake/scrcpy-server.jar': No space left on device",
      ),
    });

    const error = await startWith(harness).then(
      () => null,
      (reason: unknown) => reason,
    );

    // The host jar path and adb's output stay in `message` for the server log.
    expect(error).toBeInstanceOf(CommandFailureError);
    expect(error).toMatchObject({
      code: "adb-failed",
      publicMessage: "adb push failed",
    });
    expect((error as Error).message).toBe(
      `adb push failed: adb -s ${SERIAL} push /fake/scrcpy-server.jar ` +
        "/data/local/tmp/serve-emu-scrcpy-server-v" +
        `${SCRCPY_VERSION}.jar-${"a".repeat(24)}.01234560.tmp: ` +
        "adb: error: failed to copy '/fake/scrcpy-server.jar': No space left on device",
    );
    expect(harness.state.spawnCalls).toHaveLength(0);
  });

  test("an adb step past its deadline is a command timeout", async () => {
    const harness = createHarness({ pushResult: "hang" });

    const error = await startScrcpy(
      { serial: SERIAL },
      {
        ...harness.deps,
        timeouts: { ...harness.deps.timeouts, pushMs: 20 },
      },
    ).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(CommandFailureError);
    expect(error).toMatchObject({
      code: "adb-timeout",
      publicMessage: "adb push timed out",
    });
    expect((error as Error).message).toContain(
      `adb -s ${SERIAL} push /fake/scrcpy-server.jar`,
    );
    expect((error as Error).message).toEndWith("timed out after 20ms");
  });

  test("fixed-port fallback always uses --no-rebind", async () => {
    const harness = createHarness({
      dynamicResult: failed("dynamic forwards unsupported"),
      fixedResults: [ok()],
    });

    const session = await startWith(harness);
    const fixedCalls = harness.state.adbCalls.filter(
      (call) =>
        call.args[0] === "forward" && call.args[1] === "--no-rebind",
    );
    expect(fixedCalls).toHaveLength(1);
    expect(fixedCalls[0].args).toEqual([
      "forward",
      "--no-rebind",
      "tcp:28000",
      "localabstract:scrcpy_01234560",
    ]);
    expect(session.localPort).toBe(28000);
    await session.close();
  });

  test("close reports a forward cleanup failure", async () => {
    const harness = createHarness({
      removeResult: failed("remove denied"),
    });
    const session = await startWith(harness);

    await expect(session.close()).rejects.toThrow("scrcpy cleanup failed");
    expect(harness.state.activeForwards.size).toBe(1);
  });

  test("close treats an already-absent forward as cleaned", async () => {
    const harness = createHarness({
      removeResult: failed("adb: error: listener 'tcp:27123' not found"),
    });
    const session = await startWith(harness);
    harness.state.activeForwards.clear();

    await expect(session.close()).resolves.toBeUndefined();
  });

  test("close retries a transiently closed ADB cleanup channel", async () => {
    const harness = createHarness({
      rmResults: [failed("error: closed"), ok()],
    });
    const session = await startWith(harness);

    await expect(session.close()).resolves.toBeUndefined();
    expect(harness.state.rmAttempt).toBe(2);
  });

  test("close is best-effort once the device transport is unavailable", async () => {
    const harness = createHarness({
      rmResults: [failed("error: closed"), failed("adb: device offline")],
    });
    const session = await startWith(harness);

    await expect(session.close()).resolves.toBeUndefined();
    expect(harness.state.rmAttempt).toBe(2);
  });

  test("close is best-effort when the device becomes unauthorized during teardown", async () => {
    const harness = createHarness({
      rmResults: [failed("error: closed"), failed("adb: device unauthorized.")],
    });
    const session = await startWith(harness);

    await expect(session.close()).resolves.toBeUndefined();
    expect(harness.state.rmAttempt).toBe(2);
  });

  test("close reports a child that cannot be reaped after SIGKILL", async () => {
    const harness = createHarness({ childIgnoresKill: true });
    harness.deps.timeouts!.processExitMs = 5;
    const session = await startWith(harness);

    await expect(session.close()).rejects.toThrow("scrcpy cleanup failed");
    expect(harness.state.children[0].killSignals).toEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
    expect(harness.state.activeForwards.size).toBe(0);
  });

  test("every adb and socket operation receives a finite timeout and signal", async () => {
    const harness = createHarness();
    const session = await startWith(harness);
    await session.close();

    expect(harness.state.adbCalls.length).toBeGreaterThan(0);
    for (const call of harness.state.adbCalls) {
      expect(Number.isFinite(call.timeoutMs)).toBe(true);
      expect(call.timeoutMs).toBeGreaterThan(0);
      expect(call.signal).toBeInstanceOf(AbortSignal);
      expect(call.abortedAtCall).toBe(false);
    }
    expect(harness.state.connectCalls).toHaveLength(2);
    for (const call of harness.state.connectCalls) {
      expect(Number.isFinite(call.timeoutMs)).toBe(true);
      expect(call.timeoutMs).toBeGreaterThan(0);
      expect(call.signal).toBeInstanceOf(AbortSignal);
      expect(call.abortedAtCall).toBe(false);
    }
    expect(harness.state.timerDurations.length).toBeGreaterThan(0);
    expect(
      harness.state.timerDurations.every(
        (duration) => Number.isFinite(duration) && duration > 0,
      ),
    ).toBe(true);
  });

  test("the scrcpy runtime contains no synchronous process calls", async () => {
    const source = await readFile(
      new URL("../src/scrcpy.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/import\s*\{[^}]*\bspawnSync\b/s);
    expect(source).not.toMatch(/\bspawnSync\s*\(/);
  });
});

describe("device server jar cache", () => {
  const CACHE = `/data/local/tmp/serve-emu-scrcpy-server-v${SCRCPY_VERSION}.jar-${JAR_FINGERPRINT.slice(0, 24)}`;

  /** The jar-related adb commands, in order. */
  function jarCommands(harness: ReturnType<typeof createHarness>): string[] {
    return harness.state.adbCalls
      .map((call) => call.args)
      .filter(
        (args) =>
          args[0] === "push" ||
          (args[0] === "shell" && ["sha256sum", "sync", "mv", "cp"].includes(args[1]!)),
      )
      .map((args) => args.join(" ").replace(/\.0123456\d\.tmp\b/, ".tmp"));
  }

  test("reuses a cache whose sha256 matches the local jar without pushing", async () => {
    const harness = createHarness({ cacheInitially: true });
    const session = await startWith(harness);
    await session.close();

    expect(harness.state.pushCount).toBe(0);
    expect(jarCommands(harness)).toEqual([
      `shell sha256sum ${CACHE}`,
      `shell cp ${CACHE} /data/local/tmp/serve-emu-scrcpy-01234560.jar`,
    ]);
  });

  test("replaces an empty or corrupt cache, flushing before the rename", async () => {
    for (const digest of [EMPTY_SHA256, "b".repeat(64)]) {
      const harness = createHarness({ cacheDigest: digest });
      const session = await startWith(harness);
      await session.close();

      expect(harness.state.pushCount).toBe(1);
      expect(jarCommands(harness)).toEqual([
        `shell sha256sum ${CACHE}`,
        `push /fake/scrcpy-server.jar ${CACHE}.tmp`,
        "shell sync",
        `shell mv -f ${CACHE}.tmp ${CACHE}`,
        `shell cp ${CACHE} /data/local/tmp/serve-emu-scrcpy-01234560.jar`,
      ]);
      expect(harness.state.cacheDigest).toBe(JAR_FINGERPRINT);

      // The repaired cache is reused by the next start.
      await (await startWith(harness)).close();
      expect(harness.state.pushCount).toBe(1);
    }
  });

  test("a failed sync does not fail a start whose push succeeded", async () => {
    const harness = createHarness({
      cacheDigest: EMPTY_SHA256,
      syncResult: failed("sync: I/O error"),
    });
    await (await startWith(harness)).close();
    expect(harness.state.pushCount).toBe(1);
    expect(jarCommands(harness)).toContain(`shell mv -f ${CACHE}.tmp ${CACHE}`);
    expect(harness.state.cacheDigest).toBe(JAR_FINGERPRINT);
  });

  test("re-pushes on every start when the device has no sha256sum", async () => {
    const harness = createHarness({ sha256Missing: true });
    await (await startWith(harness)).close();
    await (await startWith(harness)).close();
    expect(harness.state.pushCount).toBe(2);
  });

  test("a cache probe that times out fails startup without pushing", async () => {
    const harness = createHarness({ deferProbe: true });
    harness.deps.timeouts!.copyMs = 20;
    const startup = startWith(harness);
    const probe = await harness.probeReached.promise;

    await expect(startup).rejects.toThrow(
      `shell sha256sum ${CACHE} timed out after 20ms`,
    );
    expect(probe.signal.aborted).toBe(true);
    expect(harness.state.pushCount).toBe(0);
    expect(harness.state.spawnCalls).toHaveLength(0);
  });

  test("aborting startup during the cache probe stops before pushing", async () => {
    const harness = createHarness({ deferProbe: true });
    const controller = new AbortController();
    const startup = startWith(harness, { signal: controller.signal });
    const probe = await harness.probeReached.promise;

    controller.abort(new Error("cancelled during the cache probe"));
    await expect(startup).rejects.toThrow("cancelled during the cache probe");
    expect(probe.signal.aborted).toBe(true);
    expect(harness.state.pushCount).toBe(0);
    expect(harness.state.spawnCalls).toHaveLength(0);
  });
});
