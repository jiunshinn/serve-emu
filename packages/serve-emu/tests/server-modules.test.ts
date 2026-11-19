import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActiveDeviceSession } from "../src/device-session-context.ts";
import type { ScrcpySession } from "../src/scrcpy.ts";
import { buildHealthSnapshot, type HealthSources } from "../src/server/health.ts";
import { serveStaticFile } from "../src/server/static.ts";
import type { Client, DeviceContext } from "../src/server/types.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("serveStaticFile", () => {
  test("serves index.html for /, files by path, and 404 for anything else", async () => {
    const base = await mkdtemp(join(tmpdir(), "serve-emu-static-"));
    cleanups.push(() => rm(base, { recursive: true, force: true }));
    const root = join(base, "ui");
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "index.html"), "<!doctype html>ui");
    await writeFile(join(root, "assets", "app.js"), "console.log(1)");
    await writeFile(join(base, "secret.txt"), "outside");

    const index = await serveStaticFile(root, "/");
    expect(index.status).toBe(200);
    expect(await index.text()).toBe("<!doctype html>ui");
    expect(await (await serveStaticFile(root, "/assets/app.js")).text()).toBe("console.log(1)");

    for (const path of ["/missing.js", "/../secret.txt", "/assets/../../secret.txt"]) {
      const response = await serveStaticFile(root, path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toBe("not found");
    }
  });
});

describe("buildHealthSnapshot", () => {
  const scrcpy = {
    serial: "emulator-5554",
    meta: { deviceName: "Pixel", codecId: "h264", width: 576, height: 1280 },
    close: () => {},
  } as unknown as ScrcpySession;

  function session(nowMs: number): DeviceContext {
    const context = new ActiveDeviceSession<Client>({
      serial: "emulator-5554",
      generation: 3,
      scrcpy,
      applyLocation: async () => {},
      now: () => nowMs,
    });
    cleanups.push(() => context.dispose("test done"));
    return context;
  }

  const sources = (nowMs: number, overrides: Partial<HealthSources> = {}): HealthSources => ({
    nowMs,
    recovery: null,
    idleResetBackoffMs: 750,
    baseStallResetMs: 2_500,
    responseMetrics: { health: { count: 2, bytes: 10, maxBytes: 6, lastBytes: 4 } } as never,
    uploads: { active: 0, queued: 0 } as never,
    executor: { active: 1, queued: 0 } as never,
    ...overrides,
  });

  test("reports idle recovery defaults before a watchdog exists", () => {
    const context = session(1_000);
    const health = buildHealthSnapshot(context, sources(4_000));
    expect(health).toMatchObject({
      ok: true,
      status: "streaming",
      generation: 3,
      serial: "emulator-5554",
      device: "Pixel",
      codec: "h264",
      size: { width: 576, height: 1280 },
      clients: 0,
      sourceFps: 0,
      sourceFrameAgeMs: 3_000,
      sourceState: "starting",
      keyFrameRecovery: {
        awaitingClients: 0,
        oldestAwaitingAgeMs: null,
        lastResetAttemptAt: null,
        pendingResetAgeMs: null,
        resetBackoffMs: 750,
        stallResetAfterMs: 2_500,
      },
      lastFrameAt: null,
      responseMetrics: { health: { count: 2 } },
      uploads: { active: 0 },
      executor: { active: 1 },
      clientsDetail: [],
      startedAt: new Date(1_000).toISOString(),
    });
  });

  test("formats the watchdog snapshot and per-client key-frame state", () => {
    const context = session(1_000);
    context.clients.add({
      id: 7,
      frameMeta: true,
      sentFrames: 40,
      droppedFrames: 2,
      backpressureEvents: 1,
      ws: { getBufferedAmount: () => 4096 },
      awaitingKeyFrame: true,
      awaitingKeyFrameSinceMs: 9_000,
      lastKeyFrameRequestMs: 9_500,
    } as unknown as Client);
    const health = buildHealthSnapshot(
      context,
      sources(10_000, {
        recovery: {
          sourceState: "streaming",
          stallResetAfterMs: 10_000,
          sourceFps: 30,
          lastFrameMs: 9_900,
          sourceFrameAgeMs: 100,
          awaitingClients: 1,
          oldestAwaitingAgeMs: 1_000,
          lastResetAttemptMs: 9_500,
          pendingResetAgeMs: 500,
          resetBackoffMs: 1_000,
        },
      }),
    );
    expect(health).toMatchObject({
      clients: 1,
      sourceFps: 30,
      sourceState: "streaming",
      lastFrameAt: new Date(9_900).toISOString(),
      keyFrameRecovery: {
        stallResetAfterMs: 10_000,
        awaitingClients: 1,
        lastResetAttemptAt: new Date(9_500).toISOString(),
        pendingResetAgeMs: 500,
        resetBackoffMs: 1_000,
      },
      clientsDetail: [
        {
          id: 7,
          bufferedBytes: 4096,
          awaitingKeyFrame: true,
          awaitingKeyFrameSinceAt: new Date(9_000).toISOString(),
          awaitingKeyFrameAgeMs: 1_000,
          lastKeyFrameRequestAt: new Date(9_500).toISOString(),
        },
      ],
    });
  });

  test("a disposed session reports not ok with its error", async () => {
    const context = session(1_000);
    await context.dispose("scrcpy exited", { status: "error" });
    expect(buildHealthSnapshot(context, sources(2_000))).toMatchObject({
      ok: false,
      status: "error",
      lastError: "scrcpy exited",
    });
  });
});
