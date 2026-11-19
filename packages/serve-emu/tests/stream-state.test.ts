import { describe, expect, test } from "bun:test";
import { parseStreamHealth } from "../src/ui/lib/stream-state.ts";

describe("stream health parsing", () => {
  test("health parsing rejects malformed network data", () => {
    expect(parseStreamHealth({ size: { width: 1, height: 2 }, status: "streaming" }))
      .toEqual({ size: { width: 1, height: 2 }, status: "streaming" });
    expect(() => parseStreamHealth({ size: { width: "1", height: 2 } }))
      .toThrow("finite dimensions");
    expect(() => parseStreamHealth({ size: { width: 1, height: 2 }, status: "paused" }))
      .toThrow("health status is invalid");
  });
});
