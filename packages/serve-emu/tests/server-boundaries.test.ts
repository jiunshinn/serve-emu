import { describe, expect, test } from "bun:test";
import { DEFAULT_HOST } from "../src/server.ts";
import {
  frameDeliveryDecision,
  sendResultDecision,
} from "../src/server/backpressure.ts";

describe("server module", () => {
  test("server module remains importable without opening Android or a port", () => {
    // A child process with Bun.serve trapped and no adb on PATH: importing
    // must neither listen nor run any command.
    const serverModule = new URL("../src/server.ts", import.meta.url).pathname;
    const probe = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `Bun.serve = () => { throw new Error("Bun.serve called during import"); };
         const { DEFAULT_HOST } = await import(${JSON.stringify(serverModule)});
         console.log(DEFAULT_HOST);`,
      ],
      { env: { ...process.env, PATH: "/nonexistent" }, timeout: 10_000 },
    );
    expect(probe.stderr.toString()).toBe("");
    expect(probe.exitCode).toBe(0);
    expect(probe.stdout.toString().trim()).toBe(DEFAULT_HOST);
    expect(DEFAULT_HOST).toBe("127.0.0.1");
  });
});

describe("server backpressure policy", () => {
  const base = {
    awaitingKeyFrame: false,
    isKeyFrame: false,
    bufferedBytes: 0,
    dropThresholdBytes: 512,
    closeThresholdBytes: 16_384,
  };

  test("drops deltas until a keyframe and prioritizes the close threshold", () => {
    expect(
      frameDeliveryDecision({ ...base, awaitingKeyFrame: true }),
    ).toBe("drop-awaiting-keyframe");
    expect(
      frameDeliveryDecision({
        ...base,
        awaitingKeyFrame: true,
        isKeyFrame: true,
      }),
    ).toBe("send");
    expect(
      frameDeliveryDecision({ ...base, bufferedBytes: 513 }),
    ).toBe("drop-buffered");
    expect(
      frameDeliveryDecision({ ...base, bufferedBytes: 16_385 }),
    ).toBe("close-slow-client");
    expect(
      frameDeliveryDecision({
        ...base,
        awaitingKeyFrame: true,
        bufferedBytes: 16_385,
      }),
    ).toBe("close-slow-client");
  });

  test("classifies Bun WebSocket send results", () => {
    expect(sendResultDecision(-1)).toBe("backpressure");
    expect(sendResultDecision(0)).toBe("closed");
    expect(sendResultDecision(1)).toBe("sent");
  });
});
