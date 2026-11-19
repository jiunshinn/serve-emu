import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { readEncoderPackets, startHostEncoder } from "../src/host-encoder.ts";

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

test("injects build and spawn, sends commands and closes the process", async () => {
  const calls: string[] = [];
  const encoder = await startHostEncoder(
    { mmapPath: "pixels", width: 64, height: 64, bitRate: 1000, maxFps: 60 },
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
  expect(calls).toEqual(["build", "encoder", "pixels", "64", "64", "1000", "60"]);
  expect(() => encoder.pushFrame()).toThrow("closed");
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
