import { describe, expect, test } from "bun:test";
import type { Sender } from "../src/ui/lib/use-stream.ts";
import {
  parseWorkerCommand,
  type StreamWorkerEvent,
  type WorkerCommand,
} from "../src/shared/worker-contracts.ts";

type FakeCanvas = { kind: "canvas" };
const canvas: FakeCanvas = { kind: "canvas" };
const isCanvas = (value: unknown): value is FakeCanvas =>
  typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "canvas";
const parse = (value: unknown) => parseWorkerCommand(value, isCanvas);

function commandName(command: WorkerCommand<FakeCanvas>): string {
  switch (command.type) {
    case "init":
    case "connect":
    case "send":
    case "stop":
      return command.type;
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

function eventName(event: StreamWorkerEvent): string {
  switch (event.type) {
    case "control-error":
    case "lifecycle":
    case "status":
    case "session":
    case "rendered":
    case "stats":
    case "control-dropped":
      return event.type;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

describe("stream worker commands", () => {
  test("accepts every command the UI posts, each with its client epoch", () => {
    const commands = [
      parse({ type: "init", clientEpoch: 1, canvas, url: "ws://127.0.0.1:3300/ws?frame-meta=1" }),
      parse({ type: "connect", clientEpoch: 1 }),
      parse({ type: "send", clientEpoch: 1, text: '{"type":"home"}' }),
      parse({ type: "stop", clientEpoch: 1 }),
    ];
    expect(commands.map((command) => (command ? commandName(command) : null))).toEqual([
      "init",
      "connect",
      "send",
      "stop",
    ]);
    expect(commands[0]).toEqual({
      type: "init",
      clientEpoch: 1,
      canvas,
      url: "ws://127.0.0.1:3300/ws?frame-meta=1",
    });
  });

  test("drops a command without a valid client epoch", () => {
    for (const clientEpoch of [undefined, 0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      expect(parse({ type: "connect", clientEpoch })).toBeNull();
    }
    expect(parse({ type: "connect", clientEpoch: Number.MAX_SAFE_INTEGER })).toEqual({
      type: "connect",
      clientEpoch: Number.MAX_SAFE_INTEGER,
    });
  });

  test("drops malformed commands", () => {
    expect(parse(null)).toBeNull();
    expect(parse([])).toBeNull();
    expect(parse({ type: "unknown", clientEpoch: 1 })).toBeNull();
    expect(parse({ type: "init", clientEpoch: 1, canvas: {}, url: "ws://x" })).toBeNull();
    expect(parse({ type: "init", clientEpoch: 1, canvas, url: "" })).toBeNull();
    expect(parse({ type: "send", clientEpoch: 1, text: 1 })).toBeNull();
  });
});

describe("stream worker events", () => {
  test("the contract names every event the worker posts", () => {
    const lifecycle = {
      generation: 2,
      phase: "rendered",
      reason: "connect",
      generationStartedAt: 1,
      socketOpenedAt: 2,
      lastPacketAt: 3,
      lastRenderedAt: 4,
      rendered: true,
      codec: "avc1.640028",
    } as const;
    const events: StreamWorkerEvent[] = [
      { type: "control-error", generation: 2, clientEpoch: 1, error: "injected", requestId: "1:3" },
      { type: "lifecycle", generation: 2, clientEpoch: 1, state: lifecycle },
      { type: "status", generation: 2, clientEpoch: 1, status: "streaming" },
      { type: "session", generation: 2, clientEpoch: 1, size: { width: 576, height: 1280 } },
      { type: "rendered", generation: 2, clientEpoch: 1, at: 5 },
      {
        type: "stats",
        generation: 2,
        clientEpoch: 1,
        stats: {
          fps: 30,
          decodeQueue: 0,
          transitMs: 3,
          e2eMs: 12,
          codec: "avc1.640028",
          rendered: true,
          decodeMsP95: 4,
          presentMsP95: 1,
          decodePendingMs: 0,
          recoveries: 0,
          clockUncertaintyMs: 2,
        },
      },
      { type: "control-dropped", generation: 2, clientEpoch: 1, reason: "socket-not-open" },
    ];
    expect(events.map(eventName)).toEqual([
      "control-error",
      "lifecycle",
      "status",
      "session",
      "rendered",
      "stats",
      "control-dropped",
    ]);
  });
});

describe("Sender", () => {
  test("accepts only shared control gestures", () => {
    const sent: unknown[] = [];
    const send: Sender = (msg, ack) => sent.push({ msg, ack });
    send({ type: "home" });
    send({ type: "touch", action: "down", x: 0.5, y: 0.5, pointerId: 1 }, true);
    send({ type: "text", text: "hi", record: false });
    // @ts-expect-error a misspelled gesture type does not compile
    send({ type: "tapp", x: 0.5, y: 0.5 });
    // @ts-expect-error a touch needs its coordinates
    send({ type: "touch", action: "down" });
    // @ts-expect-error the hook adds requestId itself
    send({ type: "home", requestId: "1:1" });
    expect(sent).toHaveLength(6);
  });
});
