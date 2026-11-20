import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRCPY_DEFAULTS } from "./scrcpy.ts";

type Packet = { data: Buffer; pts: bigint; isKey: boolean; isConfig: boolean };
const MAX_PACKET_BYTES = 32 * 1024 * 1024;

export async function* readEncoderPackets(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Packet> {
  let pending: Buffer = Buffer.alloc(13);
  let used = 0;
  for await (const chunk of chunks) {
    // Consume even very large chunks incrementally without retaining them in the parser.
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(pending.length - used, chunk.length - offset);
      pending.set(chunk.subarray(offset, offset + take), used);
      used += take;
      offset += take;
      if (used < 13) continue;
      const size = pending.readUInt32BE(0);
      if (size === 0 || size > MAX_PACKET_BYTES) throw new Error("Invalid host encoder packet size");
      if ((pending[4]! & ~3) !== 0) throw new Error("Invalid host encoder packet flags");
      if (pending.length === 13) {
        const packet = Buffer.allocUnsafe(13 + size);
        pending.copy(packet);
        pending = packet;
      }
      if (used === 13 + size) {
        yield { data: pending.subarray(13), pts: pending.readBigUInt64BE(5), isKey: !!(pending[4]! & 1), isConfig: !!(pending[4]! & 2) };
        pending = Buffer.alloc(13);
        used = 0;
      }
    }
  }
  if (used) throw new Error("Truncated host encoder packet");
}

async function buildEncoder(): Promise<string> {
  const source = fileURLToPath(new URL("../native/host-encoder.swift", import.meta.url));
  const hash = createHash("sha256").update(await readFile(source)).update(process.arch).digest("hex");
  const binary = join(homedir(), ".cache", "serve-emu", `host-encoder-${hash}`);
  try { await access(binary); return binary; } catch {}
  await mkdir(dirname(binary), { recursive: true });
  const temporary = `${binary}.${crypto.randomUUID()}.tmp`;
  try {
    const compiler = spawn("xcrun", ["swiftc", "-O", source, "-o", temporary], { stdio: ["ignore", "ignore", "pipe"] });
    let diagnostics = "";
    compiler.stderr.on("data", (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-8192); });
    await new Promise<void>((resolve, reject) => {
      compiler.once("error", reject);
      compiler.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Host encoder build failed: ${diagnostics}`)));
    });
    await rename(temporary, binary);
    return binary;
  } finally { await rm(temporary, { force: true }); }
}

export async function startHostEncoder(
  options: { mmapPath: string; width: number; height: number; bitRate: number; maxFps: number; keyFrameInterval?: number },
  dependencies: { build?: () => Promise<string>; spawn?: typeof spawn } = {},
) {
  const { width, height, bitRate, maxFps } = options;
  const keyFrameInterval = options.keyFrameInterval === 0 ? SCRCPY_DEFAULTS.keyFrameInterval : (options.keyFrameInterval ?? SCRCPY_DEFAULTS.keyFrameInterval);
  if (![width, height, bitRate, maxFps].every((value) => Number.isSafeInteger(value) && value > 0) || width > 16384 || height > 16384 || !Number.isFinite(keyFrameInterval) || keyFrameInterval <= 0) {
    throw new Error("Invalid host encoder options");
  }
  const child = (dependencies.spawn ?? spawn)(await (dependencies.build ?? buildEncoder)(), [options.mmapPath, `${width}`, `${height}`, `${bitRate}`, `${maxFps}`, `${keyFrameInterval}`], { stdio: ["pipe", "pipe", "pipe"] });
  if (!child.stdin || !child.stdout || !child.stderr) { child.kill(); throw new Error("Missing host encoder pipes"); }
  const input = child.stdin;
  const output = child.stdout;
  let failure: Error | undefined;
  let diagnostics = "";
  child.stderr.on("data", (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-8192); });
  child.on("error", (error) => { failure = error; output.destroy(error); });
  input.on("error", (error) => { failure = error; output.destroy(error); });
  const exited = new Promise<void>((resolve) => child.once("close", (code) => {
    if (code !== 0 && !closed) failure = new Error(`Host encoder exited (${code}): ${diagnostics.trim()}`);
    resolve();
  }));
  let closed = false;
  return {
    pushFrame() { if (closed) throw new Error("Host encoder closed"); if (failure) throw failure; input.write("f\n"); },
    requestKeyFrame() { if (closed) throw new Error("Host encoder closed"); if (failure) throw failure; input.write("k\n"); },
    async *packets() {
      yield* readEncoderPackets(output);
      await exited;
      if (failure) throw failure;
    },
    async close() { closed = true; child.kill("SIGKILL"); await exited; },
  };
}
