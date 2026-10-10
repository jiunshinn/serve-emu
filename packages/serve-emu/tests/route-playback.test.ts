import { describe, expect, spyOn, test } from "bun:test";
import { CommandFailureError } from "../src/command-failure.ts";
import { SessionChangedError } from "../src/device-session-context.ts";
import {
  RoutePlayback,
  RoutePlaybackConflictError,
  type RoutePlaybackClock,
  type RoutePlaybackRequest,
} from "../src/route-playback.ts";
import {
  routePlaybackErrorResponse,
  startRoutePlaybackResponse,
} from "../src/route-playback-api.ts";
import { deferred } from "./helpers/deferred.ts";
import { ManualClock } from "./helpers/manual-clock.ts";

const request: RoutePlaybackRequest = {
  waypoints: [
    { latitude: 51.5, longitude: -0.12 },
    { latitude: 51.51, longitude: -0.11 },
  ],
  speedKph: 30,
  multiplier: 1,
  intervalMs: 250,
};

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("RoutePlayback lifecycle", () => {
  test("close during the initial apply aborts the run without a callback or timer", async () => {
    const clock = new ManualClock(Date.UTC(2026, 0, 1));
    const applying = deferred<void>();
    const locations: unknown[] = [];
    let signal: AbortSignal | undefined;
    const playback = new RoutePlayback({
      clock,
      applyLocation: (_fix, runSignal) => {
        signal = runSignal;
        return applying.promise;
      },
      onLocation: (fix) => locations.push(fix),
    });

    const starting = playback.start(request);
    expect(signal?.aborted).toBe(false);
    expect(playback.close().status).toBe("closed");
    expect(playback.close().status).toBe("closed");
    expect(signal?.aborted).toBe(true);

    applying.resolve();
    await expect(starting).rejects.toBeInstanceOf(RoutePlaybackConflictError);
    expect(locations).toHaveLength(0);
    expect(clock.activeIntervals).toBe(0);
    expect(playback.snapshot()).toMatchObject({
      status: "closed",
      waypointCount: 0,
      speedKph: 30,
      multiplier: 1,
      intervalMs: 1000,
      loop: false,
      currentLocation: null,
    });
  });

  test("rejects a concurrent start and owns at most one timer", async () => {
    const clock = new ManualClock(Date.UTC(2026, 0, 1));
    const applying = deferred<void>();
    const playback = new RoutePlayback({
      clock,
      applyLocation: () => applying.promise,
      onLocation: () => {},
    });

    const first = playback.start(request);
    const second = playback.start(request);
    await expect(second).rejects.toBeInstanceOf(RoutePlaybackConflictError);
    await expect(second).rejects.toMatchObject({
      message: "route playback start is already in progress",
    });

    applying.resolve();
    expect((await first).status).toBe("running");
    expect(clock.activeIntervals).toBe(1);
    expect(clock.maxActiveIntervals).toBe(1);
    expect(playback.stop().status).toBe("idle");
    expect(playback.stop().status).toBe("idle");
    expect(clock.activeIntervals).toBe(0);
  });

  test("stop is reusable while close is terminal", async () => {
    const clock = new ManualClock(Date.UTC(2026, 0, 1));
    const playback = new RoutePlayback({
      clock,
      applyLocation: () => {},
      onLocation: () => {},
    });

    await playback.start(request);
    expect(clock.activeIntervals).toBe(1);
    expect(playback.pause().status).toBe("paused");
    expect(clock.activeIntervals).toBe(0);
    expect(playback.resume().status).toBe("running");
    expect(playback.resume().status).toBe("running");
    expect(clock.activeIntervals).toBe(1);
    playback.stop();
    playback.stop();
    expect(clock.activeIntervals).toBe(0);

    await playback.start(request);
    expect(clock.activeIntervals).toBe(1);
    playback.close();
    playback.resume();
    clock.fireCleared();
    expect(clock.activeIntervals).toBe(0);
    expect(playback.snapshot().status).toBe("closed");
    await expect(playback.start(request)).rejects.toBeInstanceOf(
      RoutePlaybackConflictError,
    );
  });

  test("stop during the initial apply invalidates the run and remains reusable", async () => {
    const clock = new ManualClock(Date.UTC(2026, 0, 1));
    const firstApply = deferred<void>();
    let calls = 0;
    let firstSignal: AbortSignal | undefined;
    const playback = new RoutePlayback({
      clock,
      applyLocation: (_fix, signal) => {
        calls++;
        if (calls === 1) {
          firstSignal = signal;
          return firstApply.promise;
        }
      },
      onLocation: () => {},
    });

    const firstStart = playback.start(request);
    expect(playback.stop().status).toBe("idle");
    expect(playback.stop().status).toBe("idle");
    expect(firstSignal?.aborted).toBe(true);
    const secondStart = playback.start(request);
    expect((await secondStart).status).toBe("running");
    expect(clock.activeIntervals).toBe(1);
    firstApply.resolve();
    await expect(firstStart).rejects.toBeInstanceOf(RoutePlaybackConflictError);
    expect(playback.snapshot().status).toBe("running");
    expect(clock.activeIntervals).toBe(1);
    playback.close();
  });

  test("pause and resume during startup defer timer ownership to start", async () => {
    const clock = new ManualClock(Date.UTC(2026, 0, 1));
    const applying = deferred<void>();
    const playback = new RoutePlayback({
      clock,
      applyLocation: () => applying.promise,
      onLocation: () => {},
    });

    const starting = playback.start(request);
    expect(playback.pause().status).toBe("paused");
    expect(playback.resume().status).toBe("running");
    expect(clock.activeIntervals).toBe(0);
    applying.resolve();
    expect((await starting).status).toBe("running");
    expect(clock.activeIntervals).toBe(1);
    expect(clock.maxActiveIntervals).toBe(1);
    playback.close();
  });

  test("initial apply failures reject and map to a non-success API status", async () => {
    const playback = new RoutePlayback({
      clock: new ManualClock(Date.UTC(2026, 0, 1)),
      applyLocation: () => {
        throw new Error("geo fix failed");
      },
      onLocation: () => {},
    });

    const response = await startRoutePlaybackResponse(playback, request);
    expect(response.ok).toBe(false);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "downstream_failure", message: "geo fix failed" },
    });
    expect(playback.snapshot()).toMatchObject({
      status: "error",
      lastError: "geo fix failed",
    });
  });

  test("successful starts return the running route API response", async () => {
    const playback = new RoutePlayback({
      clock: new ManualClock(Date.UTC(2026, 0, 1)),
      applyLocation: () => {},
      onLocation: () => {},
    });

    const response = await startRoutePlaybackResponse(playback, request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      route: { status: "running", waypointCount: 2 },
    });
    playback.close();
  });

  test("route request validation errors remain bad requests", async () => {
    const response = routePlaybackErrorResponse(
      new Error("route must include at least one waypoint"),
      "invalid_request",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "invalid_request", message: "route must include at least one waypoint" },
    });
  });

  test("concurrent and disposed starts map to conflict responses", async () => {
    const applying = deferred<void>();
    const playback = new RoutePlayback({
      clock: new ManualClock(Date.UTC(2026, 0, 1)),
      applyLocation: () => applying.promise,
      onLocation: () => {},
    });
    const first = playback.start(request);

    const response = await startRoutePlaybackResponse(playback, request);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "conflict", message: "route playback start is already in progress" },
    });

    playback.close();
    applying.resolve();
    await expect(first).rejects.toBeInstanceOf(RoutePlaybackConflictError);

    const disposedResponse = await startRoutePlaybackResponse(
      playback,
      request,
    );
    expect(disposedResponse.status).toBe(409);
    expect(await disposedResponse.json()).toEqual({
      ok: false,
      error: { code: "conflict", message: "route playback is closed" },
    });
  });

  test("a stale device session is rethrown before starting a route", async () => {
    let applies = 0;
    const playback = new RoutePlayback({
      clock: new ManualClock(Date.UTC(2026, 0, 1)),
      applyLocation: () => {
        applies++;
      },
      onLocation: () => {},
    });
    const stale = new SessionChangedError(1, 2);

    await expect(
      startRoutePlaybackResponse(playback, request, {
        assertCurrent: () => {
          throw stale;
        },
      }),
    ).rejects.toBe(stale);
    expect(applies).toBe(0);
    expect(playback.snapshot().status).toBe("idle");
  });

  test("a session change after the start resolves is rethrown, not answered as success", async () => {
    let current = true;
    let applies = 0;
    const playback = new RoutePlayback({
      clock: new ManualClock(Date.UTC(2026, 0, 1)),
      applyLocation: () => {
        applies++;
      },
      onLocation: () => {},
    });

    const starting = startRoutePlaybackResponse(playback, request, {
      assertCurrent: () => {
        if (!current) throw new SessionChangedError(1, 2);
      },
      track: (start) =>
        start.then((route) => {
          current = false;
          return route;
        }),
    });
    await expect(starting).rejects.toBeInstanceOf(SessionChangedError);
    expect(applies).toBe(1);
    playback.close();
  });

  test("unexpected start failures map to server errors", async () => {
    const response = await startRoutePlaybackResponse(
      {
        start: async () => {
          throw new Error("unexpected route failure");
        },
      },
      request,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "internal_error", message: "Internal server error" },
    });
  });

  test("command failures are downstream failures or timeouts without their output", async () => {
    const output = "KO: /home/me/.emulator_console_auth_token";
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const [failure, status, code] of [
        [
          new CommandFailureError("adb-failed", "adb emu geo fix failed", output),
          502,
          "downstream_failure",
        ],
        [
          new CommandFailureError("adb-timeout", "adb emu geo fix timed out"),
          504,
          "downstream_timeout",
        ],
      ] as const) {
        const playback = new RoutePlayback({
          clock: new ManualClock(Date.UTC(2026, 0, 1)),
          applyLocation: () => {
            throw failure;
          },
          onLocation: () => {},
        });
        const error = await playback.start(request).then(
          () => null,
          (reason: unknown) => reason,
        );
        expect(playback.snapshot().lastError).toBe(failure.publicMessage);

        const response = routePlaybackErrorResponse(
          error,
          undefined,
          new Request("http://127.0.0.1/api/route?token=secret-token", {
            method: "POST",
          }),
        );
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({
          ok: false,
          error: {
            code,
            message: failure.publicMessage,
            reason: failure.code,
          },
        });
        expect(errorLog).toHaveBeenLastCalledWith(
          `[api] POST /api/route -> ${status} ${failure.publicMessage}:`,
          error,
        );
        expect((error as Error).cause).toBe(failure);
      }
      expect(String(errorLog.mock.calls)).not.toContain("secret-token");
    } finally {
      errorLog.mockRestore();
    }
  });

  test("periodic apply failure stops the owned timer", async () => {
    const clock = new ManualClock(Date.UTC(2026, 0, 1));
    let applyCount = 0;
    const failure = new Error("periodic geo fix failed");
    const playback = new RoutePlayback({
      clock,
      applyLocation: () => {
        applyCount++;
        if (applyCount === 2) throw failure;
      },
      onLocation: () => {},
    });

    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    try {
      await playback.start(request);
      clock.advance(250);
      clock.fireActive();
      await flushMicrotasks();

      expect(playback.snapshot()).toMatchObject({
        status: "error",
        lastError: "periodic geo fix failed",
      });
      expect(clock.activeIntervals).toBe(0);
      // No API response reports a periodic failure, so it is logged here.
      expect(errorLog).toHaveBeenCalledWith(
        "[route] playback stopped: could not apply location:",
        failure,
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  test("close during a periodic apply suppresses the late location callback", async () => {
    const clock = new ManualClock(Date.UTC(2026, 0, 1));
    const periodicApply = deferred<void>();
    const published: unknown[] = [];
    let applyCount = 0;
    let periodicSignal: AbortSignal | undefined;
    const playback = new RoutePlayback({
      clock,
      applyLocation: (_fix, signal) => {
        applyCount++;
        if (applyCount === 2) {
          periodicSignal = signal;
          return periodicApply.promise;
        }
      },
      onLocation: (fix) => published.push(fix),
    });

    await playback.start(request);
    clock.advance(250);
    clock.fireActive();
    expect(applyCount).toBe(2);
    playback.close();
    expect(periodicSignal?.aborted).toBe(true);
    periodicApply.resolve();
    await flushMicrotasks();

    expect(published).toHaveLength(1);
    expect(playback.snapshot().status).toBe("closed");
    expect(clock.activeIntervals).toBe(0);
  });

  test("a disposed device player cannot publish a late location", async () => {
    const oldClock = new ManualClock(Date.UTC(2026, 0, 1));
    const oldApply = deferred<void>();
    const published: string[] = [];
    let oldSignal: AbortSignal | undefined;
    const oldPlayback = new RoutePlayback({
      clock: oldClock,
      applyLocation: (_fix, signal) => {
        oldSignal = signal;
        return oldApply.promise;
      },
      onLocation: () => published.push("old"),
    });
    const oldStart = oldPlayback.start(request);

    oldPlayback.close();
    const newPlayback = new RoutePlayback({
      clock: new ManualClock(Date.UTC(2026, 0, 1)),
      applyLocation: () => {},
      onLocation: () => published.push("new"),
    });
    await newPlayback.start(request);
    oldApply.resolve();
    await expect(oldStart).rejects.toBeInstanceOf(RoutePlaybackConflictError);

    expect(oldSignal?.aborted).toBe(true);
    expect(published).toEqual(["new"]);
    expect(oldClock.activeIntervals).toBe(0);
    oldPlayback.close();
    oldClock.fireCleared();
    expect(published).toEqual(["new"]);
    newPlayback.close();
  });
});
