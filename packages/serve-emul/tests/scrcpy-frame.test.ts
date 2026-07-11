import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import {
  FramedReader,
  ScrcpyStreamError,
  parseFrameHeader,
  parseVideoPreamble,
  readFrame,
} from "../src/scrcpy.ts";

function frameHeader(
  protocol: 3 | 4,
  o: { pts?: bigint; size: number; config?: boolean; key?: boolean },
) {
  const h = Buffer.alloc(12);
  let flags = 0n;
  if (protocol === 4) {
    if (o.config) flags |= 1n << 62n;
    if (o.key) flags |= 1n << 61n;
  } else {
    if (o.config) flags |= 1n << 63n;
    if (o.key) flags |= 1n << 62n;
  }
  h.writeBigUInt64BE((o.pts ?? 0n) | flags, 0);
  h.writeUInt32BE(o.size, 8);
  return h;
}

class MockSock extends EventEmitter {
  destroyed = false;
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

function makeReader() {
  const s = new MockSock();
  return { s, r: new FramedReader(s as unknown as Socket) };
}

test("v4 strips flag bits from pts", () => {
  const h = frameHeader(4, { pts: 12345n, size: 10, key: true, config: true });
  const p = parseFrameHeader(h, 4);
  expect(p.kind).toBe("frame");
  if (p.kind === "frame") {
    expect(p.pts).toBe(12345n);
    expect(p.isKey).toBe(true);
    expect(p.isConfig).toBe(true);
  }
});

test("clean EOF when stream ends before a header (read after end)", async () => {
  const { s, r } = makeReader();
  s.emit("end");
  const err = await r.read(12, "header").catch((e) => e);
  expect(err).toBeInstanceOf(ScrcpyStreamError);
  expect(err.code).toBe("clean-eof");
});

test("overflow destroys reader and cannot resume", async () => {
  const { s, r } = makeReader();
  s.emit("data", Buffer.allocUnsafe(33 * 1024 * 1024));
  const err = await r.read(4, "header").catch((e) => e);
  expect(err.code).toBe("reader-overflow");
  expect(s.destroyed).toBe(true);
  s.emit("data", Buffer.of(1, 2, 3, 4));
  const err2 = await r.read(4, "header").catch((e) => e);
  expect(err2.code).toBe("reader-overflow");
});

// The server maps readFrame's result to a terminal status: null → "stopped"
// (clean shutdown), thrown ScrcpyStreamError → "error" with code/meta.
describe("readFrame terminal mapping", () => {
  test("clean EOF at a frame boundary returns null (→ status 'stopped')", async () => {
    const { s, r } = makeReader();
    s.emit("end");
    expect(await readFrame(r, 4)).toBeNull();
  });

  test("truncated header throws truncated-header (→ status 'error')", async () => {
    const { s, r } = makeReader();
    s.emit("data", Buffer.alloc(6));
    s.emit("end");
    const err = await readFrame(r, 4).catch((e) => e);
    expect(err).toBeInstanceOf(ScrcpyStreamError);
    expect(err.code).toBe("truncated-header");
  });

  test("truncated payload throws truncated-payload (→ status 'error')", async () => {
    const { s, r } = makeReader();
    s.emit("data", frameHeader(4, { size: 100 }));
    s.emit("data", Buffer.alloc(40));
    s.emit("end");
    const err = await readFrame(r, 4).catch((e) => e);
    expect(err).toBeInstanceOf(ScrcpyStreamError);
    expect(err.code).toBe("truncated-payload");
    expect(err.meta).toEqual({ needed: 100, had: 40 });
  });

  test("zero-size frame header throws invalid-frame-size (→ status 'error')", async () => {
    const { s, r } = makeReader();
    s.emit("data", frameHeader(4, { size: 0 }));
    const err = await readFrame(r, 4).catch((e) => e);
    expect(err).toBeInstanceOf(ScrcpyStreamError);
    expect(err.code).toBe("invalid-frame-size");
  });

  test("a complete frame is parsed and returned", async () => {
    const { s, r } = makeReader();
    s.emit("data", frameHeader(4, { size: 4, key: true }));
    s.emit("data", Buffer.of(1, 2, 3, 4));
    const f = await readFrame(r, 4);
    expect(f?.type).toBe("frame");
    if (f?.type === "frame") {
      expect(f.isKey).toBe(true);
      expect(f.data).toEqual(Buffer.of(1, 2, 3, 4));
    }
  });
});
