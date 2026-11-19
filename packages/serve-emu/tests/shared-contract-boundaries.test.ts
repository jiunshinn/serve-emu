import { describe, expect, test } from "bun:test";
import { parseGesture } from "../src/shared/control-contracts.ts";
import {
  parseWsClientMessage,
  parseWsServerJson,
  parseWsServerMessage,
} from "../src/shared/websocket-contracts.ts";

describe("control contract numeric boundaries", () => {
  test("rejects non-finite coordinates and bounded optional integers", () => {
    expect(() => parseGesture({ type: "tap", x: Number.NaN, y: 0 })).toThrow(
      "x must be a finite number",
    );
    for (const pointerId of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        parseGesture({ type: "touch", action: "move", x: 0, y: 0, pointerId }),
      ).toThrow("pointerId must be a non-negative safe integer");
    }
    for (const metaState of [-1, 1.5, 0x80000000]) {
      expect(() => parseGesture({ type: "key", keycode: 1, metaState })).toThrow(
        "metaState must be a non-negative 32-bit integer",
      );
    }
  });
});

describe("WebSocket contract rejection boundaries", () => {
  test("rejects non-object messages and invalid recording flags", () => {
    for (const value of [null, [], "{}"] as const) {
      expect(() => parseWsClientMessage(value)).toThrow("must be an object");
    }
    expect(() => parseWsClientMessage({ type: "home", record: 1 })).toThrow(
      "record must be a boolean",
    );
  });

  test("validates server JSON and unsupported envelopes", () => {
    expect(parseWsServerJson('{"ok":true}')).toEqual({ ok: true });
    expect(() => parseWsServerJson("{")).toThrow(
      "WebSocket server message must be valid JSON",
    );
    expect(() => parseWsServerMessage({ ok: false, error: 1 })).toThrow(
      "unsupported WebSocket server message",
    );
    expect(parseWsServerMessage({ ok: false, error: "denied" })).toEqual({
      ok: false,
      error: "denied",
    });
    expect(() => parseWsServerMessage({ ok: "yes" })).toThrow(
      "unsupported WebSocket server message",
    );
  });
});
