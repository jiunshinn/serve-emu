import { describe, expect, test } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ScrcpySession } from "../src/scrcpy.ts";
import { deferred } from "./helpers/deferred.ts";
import {
  createHarness,
  fakeScrcpy,
  response,
} from "./helpers/server-harness.ts";

const selectDevice = (serial: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ serial }),
});

describe("live device switching", () => {
  test("keeps timers and HTTP responsive while the next scrcpy session waits", async () => {
    const initial = fakeScrcpy("device-1");
    const next = fakeScrcpy("device-2");
    const nextStart = deferred<ScrcpySession>();
    const nextRequested = deferred<void>();

    const harness = await createHarness(
      { sessions: [initial, next] },
      {
        openScrcpy: async (serial) => {
          if (serial === "device-1") return initial;
          nextRequested.resolve();
          return nextStart.promise;
        },
      },
    );

    try {
      const switching = response(
        harness.request("/api/devices/select", selectDevice("device-2")),
      );
      await nextRequested.promise;

      let timerAdvanced = false;
      setTimeout(() => {
        timerAdvanced = true;
      }, 5);
      await Bun.sleep(20);

      const healthResponse = await Promise.race([
        response(harness.request("/health")),
        Bun.sleep(500).then(() => {
          throw new Error("health request stalled during device switch");
        }),
      ]);
      const health = (await healthResponse.json()) as {
        status: string;
        serial: string;
      };
      expect(timerAdvanced).toBe(true);
      expect(healthResponse.status).toBe(200);
      expect(health).toMatchObject({
        status: "streaming",
        serial: "device-1",
      });

      nextStart.resolve(next);
      const switchResponse = await switching;
      expect(switchResponse.status).toBe(200);
      expect(await switchResponse.json()).toMatchObject({
        ok: true,
        serial: "device-2",
      });
    } finally {
      // The harness stops the server after the test; release the gated open
      // so that stop cannot wait on it forever.
      nextStart.resolve(next);
    }
  });

  test("server stop aborts and awaits a pending session switch", async () => {
    const initial = fakeScrcpy("device-1");
    const candidate = fakeScrcpy("device-2");
    const candidateStart = deferred<ScrcpySession>();
    const candidateRequested = deferred<AbortSignal>();

    const harness = await createHarness(
      { sessions: [initial, candidate] },
      {
        openScrcpy: async (serial, signal) => {
          if (serial === "device-1") return initial;
          candidateRequested.resolve(signal!);
          return candidateStart.promise;
        },
      },
    );

    try {
      const switching = harness
        .request("/api/devices/select", selectDevice("device-2"))
        .catch((error) => error);
      const switchSignal = await candidateRequested.promise;

      let stopSettled = false;
      const stopping = harness.started.stop().then(() => {
        stopSettled = true;
      });
      expect(switchSignal.aborted).toBe(true);
      await Bun.sleep(10);
      expect(stopSettled).toBe(false);

      candidateStart.resolve(candidate);
      await stopping;
      await switching;
      expect(initial.closeCalls).toBe(1);
      expect(candidate.closeCalls).toBe(1);
    } finally {
      // A failed expectation must not leave the harness's stop waiting on the
      // gated open.
      candidateStart.resolve(candidate);
    }
  });

  test("closes the initial session when the HTTP port cannot bind", async () => {
    // A real Bun.serve: the bind failure needs an OS port that is already taken.
    const occupied = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("occupied"),
    });
    const initial = fakeScrcpy("device-1");

    try {
      await expect(
        startServer(
          {
            serial: "device-1",
            host: "127.0.0.1",
            port: occupied.port!,
          },
          {
            log: () => {},
            openScrcpy: async () => initial,
          },
        ),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(initial.closeCalls).toBe(1);
    } finally {
      occupied.stop(true);
    }
  });
});
