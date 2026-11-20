import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { readEncoderPackets, startHostEncoder } from "../src/host-encoder.ts";
import { scanAU, buildCodecString } from "../src/ui/lib/h264.ts";

function wire(data = Buffer.from([0, 0, 0, 1, 0x65])) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(data.length);
  header[4] = 1;
  header.writeBigUInt64BE(123n, 5);
  return Buffer.concat([header, data]);
}

async function* chunks(...values: Uint8Array[]) { yield* values; }

test("parses fragmented and coalesced packets", async () => {
  const data = Buffer.concat([wire(), wire()]);
  const packets = await Array.fromAsync(readEncoderPackets(chunks(...Array.from(data, (byte) => Buffer.from([byte])))));
  expect(packets).toEqual(Array(2).fill({ data: Buffer.from([0, 0, 0, 1, 0x65]), pts: 123n, isKey: true, isConfig: false }));
});

test("accepts an empty stream", async () => {
  expect(await Array.fromAsync(readEncoderPackets(chunks()))).toEqual([]);
});

test.each([0, 32 * 1024 * 1024 + 1, 0xffffffff])("rejects invalid length %s before reading payload", async (size) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  expect(Array.fromAsync(readEncoderPackets(chunks(header)))).rejects.toThrow("packet size");
});

test.each([1, 12, 14])("rejects truncated packet of %s bytes", async (length) => {
  expect(Array.fromAsync(readEncoderPackets(chunks(wire().subarray(0, length))))).rejects.toThrow("Truncated");
});

test("rejects unknown flags", async () => {
  const data = wire(); data[4] = 4;
  expect(Array.fromAsync(readEncoderPackets(chunks(data)))).rejects.toThrow("flags");
});

function nals(data: Buffer): number[] {
  const types: number[] = [];
  for (let i = 0; i + 4 < data.length; i++) {
    if (data.readUInt32BE(i) === 1) types.push(data[i + 4]! & 31);
  }
  return types;
}

function ppsUsesCabac(config: Buffer): boolean {
  let start = 0;
  while (start + 5 < config.length && !(config.readUInt32BE(start) === 1 && (config[start + 4]! & 31) === 8)) start++;
  if (start + 5 >= config.length) throw new Error("Missing PPS");
  const rbsp = config.subarray(start + 5).filter((byte, index, bytes) => !(byte === 3 && index >= 2 && bytes[index - 1] === 0 && bytes[index - 2] === 0));
  const bits = [...rbsp].map((byte) => byte.toString(2).padStart(8, "0")).join("");
  let offset = 0;
  for (let id = 0; id < 2; id++) {
    let zeros = 0;
    while (bits[offset] === "0") { zeros++; offset++; }
    offset += zeros + 1;
  }
  if (offset >= bits.length) throw new Error("Truncated PPS");
  return bits[offset] === "1";
}

test.each([undefined, 0, 3])("injects build and spawn with keyframe interval %s, sends commands and closes the process", async (keyFrameInterval) => {
  const calls: string[] = [];
  const encoder = await startHostEncoder(
    { mmapPath: "pixels", width: 64, height: 64, bitRate: 1000, maxFps: 60, keyFrameInterval },
    {
      build: async () => { calls.push("build"); return "encoder"; },
      spawn: ((command, args) => {
        calls.push(String(command), ...(args as string[]));
        return spawn("node", ["-e", "process.stdin.on('data', d => process.stdout.write(d))"], { stdio: ["pipe", "pipe", "pipe"] });
      }) as typeof spawn,
    },
  );
  encoder.pushFrame();
  encoder.requestKeyFrame();
  await encoder.close();
  expect(calls).toEqual(["build", "encoder", "pixels", "64", "64", "1000", "60", `${keyFrameInterval || 10}`]);
  expect(() => encoder.pushFrame()).toThrow("closed");
});

test.each([-1, NaN, Infinity])("rejects invalid keyframe interval %s before building", async (keyFrameInterval) => {
  await expect(startHostEncoder({ mmapPath: "pixels", width: 64, height: 64, bitRate: 1000, maxFps: 60, keyFrameInterval }, {
    build: async () => { throw new Error("unexpected build"); },
  })).rejects.toThrow("Invalid host encoder options");
});

test.each([0, -1, NaN, Infinity, 1.5])("rejects invalid frame-rate cap %s before building", async (maxFps) => {
  await expect(startHostEncoder({ mmapPath: "pixels", width: 64, height: 64, bitRate: 1000, maxFps }, {
    build: async () => { throw new Error("unexpected build"); },
  })).rejects.toThrow("Invalid host encoder options");
});

test("propagates build errors", async () => {
  expect(startHostEncoder(
    { mmapPath: "pixels", width: 64, height: 64, bitRate: 1000, maxFps: 60 },
    { build: async () => { throw new Error("build failed"); } },
  )).rejects.toThrow("build failed");
});

test("reports helper setup failures", async () => {
  const encoder = await startHostEncoder(
    { mmapPath: "missing", width: 64, height: 64, bitRate: 1000, maxFps: 60 },
    { build: async () => "node", spawn: ((_command, _args) => spawn("node", ["-e", "console.error('setup failed'); process.exit(1)"], { stdio: ["pipe", "pipe", "pipe"] })) as typeof spawn },
  );
  try {
    await expect(Array.fromAsync(encoder.packets())).rejects.toThrow("setup failed");
  } finally { await encoder.close(); }
});

test.skipIf(process.platform !== "darwin")("real VideoToolbox encoder emits config, IDR, idle frames and requested keyframes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-encoder-"));
  const path = join(directory, "pixels");
  const pixels = Buffer.alloc(64 * 64 * 4);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 255; pixels[i + 3] = 255; }
  await writeFile(path, pixels);
  const encoder = await startHostEncoder({ mmapPath: path, width: 64, height: 64, bitRate: 500_000, maxFps: 60 });
  try {
    const packets = encoder.packets();
    encoder.pushFrame();
    const config = (await packets.next()).value!;
    expect(config.isConfig).toBe(true);
    expect(nals(config.data)).toEqual([7, 8]);
    expect(buildCodecString(scanAU(config.data).spsBytes!)).toStartWith("avc1.4d");
    expect(ppsUsesCabac(config.data)).toBe(false);
    const key = (await packets.next()).value!;
    expect(key.isKey).toBe(true);
    expect(nals(key.data)).toContain(5);
    const idle = (await packets.next()).value!;
    expect(idle.pts > key.pts).toBe(true);
    for (let frame = 0; frame < 2; frame++) {
      pixels[0] = frame * 100;
      await writeFile(path, pixels, { flag: "r+" });
      encoder.pushFrame();
      await packets.next();
    }
    encoder.requestKeyFrame();
    let next = (await packets.next()).value!;
    while (!next.isConfig) next = (await packets.next()).value!;
    expect(nals(next.data)).toEqual([7, 8]);
    expect(nals((await packets.next()).value!.data)).toContain(5);
  } finally { await encoder.close(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

const ffmpeg = Bun.which("ffmpeg");
test.skipIf(process.platform !== "darwin")("real VideoToolbox encoder honours the periodic keyframe interval during idle repeats", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-encoder-periodic-"));
  const path = join(directory, "pixels");
  await writeFile(path, Buffer.alloc(64 * 64 * 4, 255));
  const encoder = await startHostEncoder({ mmapPath: path, width: 64, height: 64, bitRate: 500_000, maxFps: 60, keyFrameInterval: 1 });
  try {
    const packets = encoder.packets();
    encoder.pushFrame();
    const config = (await packets.next()).value!;
    const first = (await packets.next()).value!;
    expect(config.isConfig).toBe(true);
    expect(first.isKey).toBe(true);
    let keyFrames = 1;
    for await (const packet of packets) {
      if (packet.isKey) { expect(nals(packet.data)).toContain(5); keyFrames++; }
      if (packet.pts - first.pts >= 1_600_000n) break;
    }
    expect(keyFrames).toBeGreaterThanOrEqual(2);
  } finally { await encoder.close(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

test.skipIf(process.platform !== "darwin" || !ffmpeg)("real VideoToolbox encoder preserves top-red bottom-blue MMAP orientation (requires ffmpeg)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-encoder-orientation-"));
  const path = join(directory, "pixels");
  const width = 64;
  const height = 64;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      pixels[offset + (y < height / 2 ? 0 : 2)] = 255;
      pixels[offset + 3] = 255;
    }
  }
  await writeFile(path, pixels);
  const encoder = await startHostEncoder({ mmapPath: path, width, height, bitRate: 500_000, maxFps: 60 });
  let draining: Promise<void> | undefined;
  try {
    const packets = encoder.packets();
    encoder.pushFrame();
    const config = (await packets.next()).value!;
    const key = (await packets.next()).value!;
    draining = (async () => { while (!(await packets.next()).done) {} })();
    expect(config.isConfig).toBe(true);
    expect(key.isKey).toBe(true);
    const decoder = Bun.spawn([ffmpeg!, "-hide_banner", "-loglevel", "error", "-f", "h264", "-i", "pipe:0", "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], {
      stdin: Buffer.concat([config.data, key.data]), stdout: "pipe", stderr: "pipe",
    });
    const [raw, diagnostics, code] = await Promise.all([new Response(decoder.stdout).arrayBuffer(), new Response(decoder.stderr).text(), decoder.exited]);
    expect(diagnostics).toBe("");
    expect(code).toBe(0);
    const decoded = new Uint8Array(raw);
    expect(decoded.length).toBe(width * height * 3);
    const top = (height / 4 * width + width / 2) * 3;
    const bottom = (height * 3 / 4 * width + width / 2) * 3;
    expect(decoded[top]!).toBeGreaterThan(200);
    expect(decoded[top + 1]!).toBeLessThan(50);
    expect(decoded[top + 2]!).toBeLessThan(50);
    expect(decoded[bottom]!).toBeLessThan(50);
    expect(decoded[bottom + 1]!).toBeLessThan(50);
    expect(decoded[bottom + 2]!).toBeGreaterThan(200);
  } finally { await encoder.close(); await draining; await rm(directory, { recursive: true, force: true }); }
}, 60_000);

test.skipIf(process.platform !== "darwin").each([2, 20])("real VideoToolbox encoder caps burst, requested-keyframe and idle submissions at %s fps and flushes the latest pixels", async (maxFps) => {
  const directory = await mkdtemp(join(tmpdir(), "host-encoder-fps-"));
  const path = join(directory, "pixels");
  const pixels = Buffer.alloc(64 * 64 * 4, 255);
  await writeFile(path, pixels);
  const encoder = await startHostEncoder({ mmapPath: path, width: 64, height: 64, bitRate: 500_000, maxFps });
  try {
    const packets = encoder.packets();
    encoder.requestKeyFrame();
    encoder.pushFrame();
    const config = (await packets.next()).value!;
    const first = (await packets.next()).value!;
    expect(first.isKey).toBe(true);
    if (maxFps === 2) {
      for (let i = 0; i < pixels.length; i += 4) { pixels[i + 1] = 0; pixels[i + 2] = 0; }
      await writeFile(path, pixels, { flag: "r+" });
      encoder.pushFrame();
      await Bun.sleep(20);
    }
    for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 255; }
    await writeFile(path, pixels, { flag: "r+" });
    for (let i = 0; i < 20; i++) encoder.pushFrame();
    const frames = [first];
    const encoded = [config.data, first.data];
    const intervalUs = Math.ceil(1_000_000 / maxFps);
    for await (const packet of packets) {
      encoded.push(packet.data);
      if (packet.isConfig) continue;
      frames.push(packet);
      if (frames.length === 2) encoder.requestKeyFrame();
      if (packet.pts - first.pts >= BigInt(intervalUs + 2 * Math.max(200_000, intervalUs))) break;
    }
    expect(frames.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < frames.length; i++) {
      expect(Number(frames[i]!.pts - frames[i - 1]!.pts)).toBeGreaterThanOrEqual(intervalUs - 1);
    }
    expect(Number(frames[1]!.pts - first.pts)).toBeLessThan(intervalUs + 150_000);
    expect(frames.slice(2).some((frame) => frame.isKey)).toBe(true);
    if (ffmpeg) {
      const decoder = Bun.spawn([ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "h264", "-i", "pipe:0", "-frames:v", "2", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], {
        stdin: Buffer.concat(encoded), stdout: "pipe", stderr: "pipe",
      });
      const [raw, diagnostics, code] = await Promise.all([new Response(decoder.stdout).arrayBuffer(), new Response(decoder.stderr).text(), decoder.exited]);
      expect(diagnostics).toBe("");
      expect(code).toBe(0);
      const decoded = new Uint8Array(raw);
      expect(decoded.length).toBe(2 * 64 * 64 * 3);
      const latest = 64 * 64 * 3;
      expect(decoded[latest]!).toBeLessThan(50);
      expect(decoded[latest + 1]!).toBeLessThan(50);
      expect(decoded[latest + 2]!).toBeGreaterThan(200);
    }
  } finally { await encoder.close(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

test.skipIf(process.platform !== "darwin")("real VideoToolbox encoder survives native-resolution bursts and still honours keyframe requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-encoder-burst-"));
  const path = join(directory, "pixels");
  await writeFile(path, Buffer.alloc(2208 * 1840 * 4, 255));
  const encoder = await startHostEncoder({ mmapPath: path, width: 2208, height: 1840, bitRate: 8_000_000, maxFps: 60 });
  try {
    const packets = encoder.packets();
    encoder.pushFrame();
    const config = (await packets.next()).value!;
    expect(config.isConfig).toBe(true);
    expect(buildCodecString(scanAU(config.data).spsBytes!)).toStartWith("avc1.4d");
    expect(ppsUsesCabac(config.data)).toBe(false);
    expect(nals((await packets.next()).value!.data)).toContain(5);
    for (let frame = 0; frame < 120; frame++) encoder.pushFrame();
    encoder.requestKeyFrame();
    let next = (await packets.next()).value!;
    while (!next.isConfig) next = (await packets.next()).value!;
    expect(nals(next.data)).toEqual([7, 8]);
    expect(nals((await packets.next()).value!.data)).toContain(5);
  } finally {
    await encoder.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
