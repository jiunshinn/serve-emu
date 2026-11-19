import { connect } from "node:http2";
import { mkdtemp, open, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export class HostCaptureUnavailableError extends Error {
  constructor(public readonly reason: string) {
    super(`Host capture unavailable: ${reason}`);
    this.name = "HostCaptureUnavailableError";
  }
}

export class EmulatorGrpcError extends Error {
  constructor(public readonly status: number) {
    super(`Emulator gRPC status ${status}`);
    this.name = "EmulatorGrpcError";
  }
}

type Endpoint = { port: number; token: string };
export type ScreenshotFrame = { width: number; height: number; rotation: number; seq: bigint; timestampUs: bigint };
const MAX_FRAME_BYTES = 4096 * 4096 * 4;
const MAX_MESSAGE_BYTES = 1024 * 1024;

/** Finds a live emulator's token-authenticated, loopback gRPC endpoint. */
export async function discoverEmulatorGrpc(serial: string, options: {
  directory?: string;
  isAlive?: (pid: number) => boolean;
} = {}): Promise<Endpoint> {
  const directory = options.directory ?? (process.platform === "darwin"
    ? join(homedir(), "Library/Caches/TemporaryItems/avd/running")
    : process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, "avd/running") : undefined);
  if (!directory) throw new HostCaptureUnavailableError("emulator discovery directory missing");
  let files: string[];
  try { files = await readdir(directory); }
  catch { throw new HostCaptureUnavailableError("emulator discovery directory unavailable"); }
  const alive = options.isAlive ?? ((pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  });
  for (const file of files.sort()) {
    const match = /^pid_([1-9]\d*)\.ini$/.exec(file);
    if (!match || !alive(Number(match[1]))) continue;
    let contents: string;
    try { contents = await readFile(join(directory, file), "utf8"); } catch { continue; }
    const values = new Map(contents.split(/\r?\n/).flatMap((line) => {
      const index = line.indexOf("=");
      return index < 0 ? [] : [[line.slice(0, index).trim(), line.slice(index + 1).trim()] as const];
    }));
    if (`emulator-${values.get("port.serial")}` !== serial) continue;
    const port = Number(values.get("grpc.port"));
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const token = values.get("grpc.token");
    if (!token || /[\r\n\0]/.test(token)) continue;
    return { port, token };
  }
  throw new HostCaptureUnavailableError("no live token-authenticated emulator endpoint");
}

function varint(value: bigint): Buffer {
  const bytes: number[] = [];
  do { bytes.push(Number(value & 127n) | (value > 127n ? 128 : 0)); value >>= 7n; } while (value);
  return Buffer.from(bytes);
}

function message(field: number, data: Buffer): Buffer {
  return Buffer.concat([varint(BigInt(field * 8 + 2)), varint(BigInt(data.length)), data]);
}

/** ImageFormat: native RGBA8888 over a file-backed MMAP transport. */
export function encodeScreenshotRequest(path: string): Buffer {
  const transport = Buffer.concat([Buffer.from([8, 1]), message(2, Buffer.from(pathToFileURL(path).href))]);
  return Buffer.concat([Buffer.from([8, 1, 24, 0, 32, 0]), message(6, transport)]);
}

function fields(data: Buffer): Map<number, bigint | Buffer> {
  const result = new Map<number, bigint | Buffer>();
  let offset = 0;
  const readVarint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= data.length) throw new Error("Truncated emulator protobuf");
      const byte = data[offset++]!;
      if (shift === 63n && byte > 1) throw new Error("Invalid emulator protobuf integer");
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error("Invalid emulator protobuf integer");
  };
  while (offset < data.length) {
    const tag = readVarint();
    const field = Number(tag >> 3n);
    if (field < 1) throw new Error("Invalid emulator protobuf field");
    switch (Number(tag & 7n)) {
      case 0: result.set(field, readVarint()); break;
      case 2: {
        const size = readVarint();
        if (size > BigInt(data.length - offset)) throw new Error("Truncated emulator protobuf");
        result.set(field, data.subarray(offset, offset + Number(size)));
        offset += Number(size);
        break;
      }
      case 1: offset += 8; break;
      case 5: offset += 4; break;
      default: throw new Error("Unsupported emulator protobuf wire type");
    }
    if (offset > data.length) throw new Error("Truncated emulator protobuf");
  }
  return result;
}

export function decodeScreenshot(data: Buffer): ScreenshotFrame {
  const image = fields(data);
  const formatData = image.get(1);
  if (!Buffer.isBuffer(formatData)) throw new Error("Missing emulator image format");
  const format = fields(formatData);
  const width = Number(format.get(3) ?? 0n);
  const height = Number(format.get(4) ?? 0n);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height * 4 > MAX_FRAME_BYTES) {
    throw new Error("Emulator frame exceeds mmap bounds");
  }
  const rotationData = format.get(2);
  const rotation = Buffer.isBuffer(rotationData) ? Number(fields(rotationData).get(1) ?? 0n) : 0;
  const seq = image.get(5) ?? 0n;
  const timestampUs = image.get(6) ?? 0n;
  if (typeof seq !== "bigint" || typeof timestampUs !== "bigint" || ![0, 1, 2, 3].includes(rotation)) throw new Error("Invalid emulator image metadata");
  return { width, height, rotation, seq, timestampUs };
}

async function* grpcMessages(chunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const queue: Buffer[] = [];
  let head = 0;
  let headOffset = 0;
  let total = 0;
  let size: number | undefined;
  const take = (length: number) => {
    const result = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const chunk = queue[head]!;
      const count = Math.min(length - written, chunk.length - headOffset);
      chunk.copy(result, written, headOffset, headOffset + count);
      written += count;
      headOffset += count;
      if (headOffset === chunk.length) { head++; headOffset = 0; }
    }
    total -= length;
    if (head > 64 || head === queue.length) { queue.splice(0, head); head = 0; }
    return result;
  };
  for await (const chunk of chunks) {
    if (!chunk.length) continue;
    queue.push(chunk);
    total += chunk.length;
    while (true) {
      if (size === undefined) {
        if (total < 5) break;
        const header = take(5);
        size = header.readUInt32BE(1);
        if (header[0] !== 0 || size > MAX_MESSAGE_BYTES) throw new Error("Invalid emulator gRPC message");
      }
      if (total < size) break;
      yield take(size);
      size = undefined;
    }
    if (total > MAX_MESSAGE_BYTES) throw new Error("Emulator gRPC buffer limit exceeded");
  }
  if (total || size !== undefined) throw new Error("Truncated emulator gRPC message");
}

/** Owns the private MMAP file and the authenticated HTTP/2 screenshot stream. */
export async function startScreenshotStream(endpoint: Endpoint, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "serve-emu-capture-"));
  const mmapPath = join(directory, "pixels");
  let cleanup: (() => void) | undefined;
  try {
    const file = await open(mmapPath, "wx", 0o600);
    try { await file.truncate(MAX_FRAME_BYTES); } finally { await file.close(); }
    signal?.throwIfAborted();
    const client = connect(`http://127.0.0.1:${endpoint.port}`);
    cleanup = () => client.destroy();
    client.on("error", () => {});
    const request = client.request({
      ":method": "POST",
      ":path": "/android.emulation.control.EmulatorController/streamScreenshot",
      "content-type": "application/grpc",
      te: "trailers",
      authorization: `Bearer ${endpoint.token}`,
    });
    let status: number | undefined;
    let failure: Error | undefined;
    let closed = false;
    const abort = () => { failure = new Error("Emulator screenshot stream aborted"); request.destroy(failure); client.destroy(); };
    cleanup = () => { closed = true; signal?.removeEventListener("abort", abort); request.destroy(); client.destroy(); };
    // Never propagate transport error text or grpc-message: either may contain credentials.
    client.on("error", () => { failure ??= new Error("Emulator gRPC connection failed"); request.destroy(failure); });
    request.on("error", () => { failure ??= new Error("Emulator gRPC stream failed"); });
    const readStatus = (headers: Record<string, unknown>) => {
      if (headers["grpc-status"] !== undefined) {
        status = Number(headers["grpc-status"]);
        if (status !== 0) { failure = new EmulatorGrpcError(status); request.destroy(failure); }
      }
    };
    request.on("response", (headers) => {
      if (headers[":status"] !== 200) { failure = new Error("Emulator gRPC HTTP failure"); request.destroy(failure); }
      readStatus(headers);
    });
    request.on("trailers", readStatus);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const body = encodeScreenshotRequest(mmapPath);
    const prefix = Buffer.alloc(5);
    prefix.writeUInt32BE(body.length, 1);
    request.end(Buffer.concat([prefix, body]));
    return {
      mmapPath,
      async *frames() {
        try {
          for await (const data of grpcMessages(request)) yield decodeScreenshot(data);
          if (failure) throw failure;
          if (!closed && status !== 0) throw new Error("Emulator gRPC stream ended without status");
        } catch {
          if (!closed) throw failure ?? new Error("Invalid emulator screenshot stream");
        }
      },
      async close() { cleanup?.(); await rm(directory, { recursive: true, force: true }); },
    };
  } catch {
    cleanup?.();
    await rm(directory, { recursive: true, force: true });
    throw new HostCaptureUnavailableError("could not initialise screenshot stream");
  }
}
