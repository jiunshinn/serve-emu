import { describe, expect, test } from "bun:test";
import {
  parseWsClientMessage,
  parseWsServerMessage,
  type WsServerMessage,
} from "../src/shared/websocket-contracts.ts";

function serverMessageName(message: WsServerMessage): string {
  if ("type" in message) return message.type;
  return message.ok ? "ack" : "failure";
}

describe("WebSocket contracts", () => {
  test("parses gesture metadata and reset requests", () => {
    expect(
      parseWsClientMessage({ type: "tap", x: 0.5, y: 0.25, ack: false, record: false }),
    ).toEqual({ type: "tap", x: 0.5, y: 0.25, ack: false, record: false });
    expect(parseWsClientMessage({ type: "reset-video", ack: false })).toEqual({
      type: "reset-video",
      ack: false,
    });
  });

  test("validates messages and option types", () => {
    expect(parseWsClientMessage({ type: "home" })).toEqual({ type: "home" });
    expect(() => parseWsClientMessage({ type: "home", ack: "no" })).toThrow("ack must be a boolean");
    expect(() => parseWsClientMessage({ type: "tap", x: 2, y: 0 })).toThrow("between 0 and 1");
  });

  test("parses every server text envelope", () => {
    const messages = [
      parseWsServerMessage({ ok: true }),
      parseWsServerMessage({ ok: false, error: "bad gesture" }),
      parseWsServerMessage({ type: "video-session", size: { width: 1080, height: 2400 } }),
    ];
    expect(messages.map(serverMessageName)).toEqual(["ack", "failure", "video-session"]);
    expect(() =>
      parseWsServerMessage({ type: "video-session", size: { width: 0, height: 2400 } }),
    ).toThrow("positive finite");
  });
});


test("correlates bounded request IDs in success and failure envelopes", () => {
  expect(parseWsClientMessage({ type: "home", requestId: "key-1" })).toMatchObject({ requestId: "key-1" });
  expect(parseWsServerMessage({ ok: true, requestId: "key-1" })).toEqual({ ok: true, requestId: "key-1" });
  expect(parseWsServerMessage({ ok: false, error: "queue full", requestId: "key-2" })).toEqual({ ok: false, error: "queue full", requestId: "key-2" });
  for (const requestId of ["", "a".repeat(129), 42, {}]) {
    expect(() => parseWsClientMessage({ type: "home", requestId })).toThrow("requestId");
  }
});

test("clock synchronization validates both wire directions", () => {
  expect(parseWsClientMessage({ type: "clock-sync", clientTsMs: 100, ack: false })).toEqual({ type: "clock-sync", clientTsMs: 100, ack: false });
  expect(parseWsServerMessage({ type: "clock-sync", clientTsMs: 100, serverTsMs: 200 })).toEqual({ type: "clock-sync", clientTsMs: 100, serverTsMs: 200 });
  for (const clientTsMs of [-1, Number.NaN, "100", Number.POSITIVE_INFINITY]) {
    expect(() => parseWsClientMessage({ type: "clock-sync", clientTsMs })).toThrow("clock timestamp");
  }
});
