import { describe, expect, test } from "bun:test";
import { listScrcpySockets, parseScrcpySocketNames } from "../src/adb.ts";
import type { DeviceService } from "../src/device-service.ts";
import type { execText } from "../src/exec.ts";
import type { RecoveryWatchdogClock } from "../src/session-recovery-watchdog.ts";
import { startServer } from "../src/server.ts";
import { parseHealthResponse } from "../src/shared/api-contracts.ts";
import { createHarness, fakeScrcpy, fakeWebSocket, response } from "./helpers/server-harness.ts";

const HEADER = "Num       RefCount Protocol Flags    Type St Inode Path";
const socket = (path: string, inode = 4242) =>
  `0000000000000000: 00000002 00000000 00010000 0001 01 ${inode} ${path}`;

describe("scrcpy sessions in /proc/net/unix (#76)", () => {
  test("finds zero, one, or several sessions", () => {
    expect(parseScrcpySocketNames([HEADER, socket("/dev/socket/zygote"), socket("@jdwp-control")].join("\n"))).toEqual([]);
    expect(parseScrcpySocketNames([HEADER, socket("@scrcpy_1a2b3c4d")].join("\n"))).toEqual(["scrcpy_1a2b3c4d"]);
    // A session's listening socket and accepted connections share one name.
    expect(
      parseScrcpySocketNames(
        [
          HEADER,
          socket("@scrcpy_1a2b3c4d", 1),
          socket("@scrcpy_1a2b3c4d", 2),
          socket("@scrcpy_1a2b3c4d", 3),
          socket("@scrcpy_00ff00ff", 4),
          socket("@scrcpy", 5),
          socket("@scrcpy_notahexid", 6),
          `0000000000000000: 00000003 00000000 00000000 0001 03 7`,
        ].join("\n") + "\n",
      ),
    ).toEqual(["scrcpy", "scrcpy_00ff00ff", "scrcpy_1a2b3c4d"]);
  });

  test("reads the table with one bounded adb call on the background lane", async () => {
    const calls: Array<{ args: readonly string[]; options: unknown }> = [];
    const runExec = (async (_command, args, options) => {
      calls.push({ args, options });
      return { status: 0, signal: null, stdout: `${HEADER}\n${socket("@scrcpy_1a2b3c4d")}\n`, stderr: "", timedOut: false, error: null };
    }) as typeof execText;
    expect(await listScrcpySockets("emulator-5554", { execText: runExec })).toEqual(["scrcpy_1a2b3c4d"]);
    expect(calls).toEqual([
      {
        args: ["-s", "emulator-5554", "shell", "cat", "/proc/net/unix"],
        options: expect.objectContaining({ timeout: 2_000, maxBuffer: 1024 * 1024, lane: "background" }),
      },
    ]);
  });
});

/** A clock whose interval callbacks run only when a test ticks them. */
function manualClock() {
  let now = 1_000;
  const intervals = new Map<number, { callback: () => void; intervalMs: number }>();
  let nextId = 1;
  const clock: RecoveryWatchdogClock = {
    now: () => now,
    setInterval(callback, intervalMs) {
      const id = nextId++;
      intervals.set(id, { callback, intervalMs });
      return id;
    },
    clearInterval(timer) {
      intervals.delete(timer as number);
    },
  };
  /** Advances by `ms` and fires the 2 s probe interval once per elapsed tick. */
  const advance = (ms: number) => {
    now += ms;
    for (const { callback, intervalMs } of [...intervals.values()]) {
      if (intervalMs === 2_000) callback();
    }
  };
  return { clock, advance };
}

function deviceService(scrcpySockets: DeviceService["scrcpySockets"]): DeviceService {
  return new Proxy({ scrcpySockets } as DeviceService, {
    get: (target, key) =>
      key in target
        ? target[key as keyof DeviceService]
        : () => {
            throw new Error(`unexpected device call ${String(key)}`);
          },
  });
}

/** A real server on a free port whose contention probe the test drives. */
async function probingServer(
  clock: RecoveryWatchdogClock,
  scrcpySockets: DeviceService["scrcpySockets"],
  probeDeviceContention = true,
) {
  const started = await startServer(
    { serial: "emulator-5554", host: "127.0.0.1", port: 0, probeDeviceContention },
    {
      log: () => {},
      recoveryClock: clock,
      openScrcpy: async (serial) => Object.assign(fakeScrcpy(serial), { scid: "0000abcd" }),
      deviceService: deviceService(scrcpySockets),
    },
  );
  const health = async () =>
    parseHealthResponse(await (await fetch(`http://127.0.0.1:${started.server.port}/health`)).json());
  return { started, health };
}

describe("/health contention and reset reasons (#76)", () => {
  test("counts other scrcpy sessions without waiting on the probe", async () => {
    const { clock, advance } = manualClock();
    const answers: Array<(names: string[]) => void> = [];
    const probes: Array<{ serial: string; signal: AbortSignal }> = [];
    const { started, health } = await probingServer(clock, (serial, signal) => {
      probes.push({ serial, signal });
      // Like adb under the session's signal: aborting kills the probe.
      return new Promise((resolve, reject) => {
        answers.push(resolve);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    try {
      expect((await health()).contention).toBeNull();
      advance(2_000);
      expect(probes).toHaveLength(1);
      expect(probes[0]!.serial).toBe("emulator-5554");
      // The probe is still running: /health answers from the last result.
      expect((await health()).contention).toBeNull();
      // Ticks while a probe is in flight do not start another.
      for (let tick = 0; tick < 5; tick++) advance(2_000);
      expect(probes).toHaveLength(1);

      answers[0]!(["scrcpy_0000abcd", "scrcpy_1a2b3c4d"]);
      await Bun.sleep(0);
      expect((await health()).contention).toEqual({
        otherScrcpySessions: 1,
        checkedAt: new Date(13_000).toISOString(),
      });

      // Then every fifth tick (10 s).
      for (let tick = 0; tick < 4; tick++) advance(2_000);
      expect(probes).toHaveLength(1);
      advance(2_000);
      expect(probes).toHaveLength(2);
      answers[1]!(["scrcpy_0000abcd"]);
      await Bun.sleep(0);
      expect((await health()).contention).toMatchObject({ otherScrcpySessions: 0 });

      // The session's end aborts a running probe.
      for (let tick = 0; tick < 5; tick++) advance(2_000);
      expect(probes).toHaveLength(3);
      await started.stop();
      expect(probes[2]!.signal.aborted).toBe(true);
    } finally {
      await started.stop();
    }
  });

  test("a failed probe keeps the last answer", async () => {
    const { clock, advance } = manualClock();
    let fail = false;
    let probes = 0;
    const { started, health } = await probingServer(clock, async () => {
      probes++;
      if (fail) throw new Error("device offline");
      return ["scrcpy_0000abcd", "scrcpy_1a2b3c4d", "scrcpy"];
    });
    try {
      advance(2_000);
      await Bun.sleep(0);
      fail = true;
      for (let tick = 0; tick < 5; tick++) advance(2_000);
      await Bun.sleep(0);
      expect(probes).toBe(2);
      expect((await health()).contention).toEqual({
        otherScrcpySessions: 2,
        checkedAt: new Date(3_000).toISOString(),
      });
    } finally {
      await started.stop();
    }
  });

  test("the probe is off unless the server asks for it", async () => {
    const { clock, advance } = manualClock();
    let probes = 0;
    const { started, health } = await probingServer(clock, async () => {
      probes++;
      return [];
    }, false);
    try {
      for (let tick = 0; tick < 10; tick++) advance(2_000);
      expect(probes).toBe(0);
      expect((await health()).contention).toBeNull();
    } finally {
      await started.stop();
    }
  });

  test("counts video resets by reason and over the last minute", async () => {
    const { clock, advance } = manualClock();
    const harness = await createHarness(
      { serial: "emulator-5554" },
      { recoveryClock: clock, deviceService: deviceService(async () => []) },
    );
    const health = async () =>
      parseHealthResponse(await (await response(harness.request("/health"))).json());
    expect(await health()).toMatchObject({ videoResetsByReason: {}, videoResetsLastMinute: 0 });

    // A client that opens asks for a key frame ("client opened"); then the
    // client asks again over its socket ("client requested keyframe").
    await harness.request("/ws");
    const ws = fakeWebSocket(harness.server.upgrades[0]!);
    harness.handlers.websocket.open(ws);
    // Each request waits out the previous reset's settle window: 2.5 s, then
    // 5 s, because no key frame answered the last one.
    for (const waitMs of [3_000, 6_000]) {
      advance(waitMs);
      harness.handlers.websocket.message(ws, JSON.stringify({ type: "reset-video", ack: false }));
      await Bun.sleep(0);
    }
    expect(await health()).toMatchObject({
      videoResetRequests: 3,
      lastVideoResetReason: "client requested keyframe",
      videoResetsByReason: { "client opened": 1, "client requested keyframe": 2 },
      videoResetsLastMinute: 3,
    });

    // The first reset (t = 1 s) leaves the one-minute window; the totals stay.
    advance(52_000);
    expect(await health()).toMatchObject({
      videoResetRequests: 3,
      videoResetsByReason: { "client opened": 1, "client requested keyframe": 2 },
      videoResetsLastMinute: 2,
    });
  });
});
