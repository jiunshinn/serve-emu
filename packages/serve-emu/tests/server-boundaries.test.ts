import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HOST } from "../src/server.ts";
import {
  frameDeliveryDecision,
  sendResultDecision,
} from "../src/server/backpressure.ts";

describe("server module", () => {
  test("server module remains importable without opening Android or a port", () => {
    // A child process with Bun.serve trapped and only a recording `adb` on
    // PATH: importing must neither listen nor run adb. An empty PATH would
    // only catch an adb call whose spawn failure goes unhandled; the fake
    // records every call, handled or not.
    const binDir = mkdtempSync(join(tmpdir(), "serve-emu-import-probe-"));
    const marker = join(binDir, "adb-calls");
    const adb = join(binDir, "adb");
    writeFileSync(
      adb,
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$SERVE_EMU_ADB_MARKER"\nexit 1\n',
    );
    chmodSync(adb, 0o755);
    try {
      const serverModule = new URL("../src/server.ts", import.meta.url).pathname;
      const probe = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `Bun.serve = () => { throw new Error("Bun.serve called during import"); };
           const { DEFAULT_HOST } = await import(${JSON.stringify(serverModule)});
           console.log(DEFAULT_HOST);`,
        ],
        {
          env: { ...process.env, PATH: binDir, SERVE_EMU_ADB_MARKER: marker },
          timeout: 10_000,
        },
      );
      expect(probe.stderr.toString()).toBe("");
      expect(probe.exitCode).toBe(0);
      expect(probe.stdout.toString().trim()).toBe(DEFAULT_HOST);
      // The recorded arguments, if any, name the adb call import made.
      expect(existsSync(marker) ? readFileSync(marker, "utf8") : null).toBeNull();
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
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
