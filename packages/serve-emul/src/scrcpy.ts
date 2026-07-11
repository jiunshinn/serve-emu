import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { SCRCPY_VERSION, ensureScrcpyServer } from "../scripts/fetch-scrcpy.ts";

const DEVICE_JAR_PATH = "/data/local/tmp/scrcpy-server.jar";

export type ScrcpyMeta = {
  deviceName: string;
  codecId: string;
  width: number;
  height: number;
};

type ScrcpyProtocol = 3 | 4;

export type ScrcpySession = {
  transport: "scrcpy";
  meta: ScrcpyMeta;
  protocol: ScrcpyProtocol;
  videoReader: FramedReader;
  controlSocket: Socket;
  proc: ChildProcess;
  scid: string;
  localPort: number;
  serial: string;
  readFrame: () => Promise<VideoPacket | null>;
  close: () => void;
};

export type ScrcpyErrorCode =
  | "clean-eof"
  | "truncated-header"
  | "truncated-payload"
  | "invalid-frame-size"
  | "reader-overflow"
  | "unsupported-codec"
  | "protocol-parse"
  | "socket-error";

export type StartOpts = {
  serial: string;
  maxFps?: number;
  bitRate?: number;
  maxSize?: number;
  keyFrameInterval?: number;
  repeatFrameMs?: number;
};

// Single source of truth for encoder defaults; the CLI reads these for its
// option defaults and --help text so the two can't drift.
export const SCRCPY_DEFAULTS = {
  maxFps: 60,
  bitRate: 8_000_000,
  // The emulator has no hardware video encoder; its software H.264 encoder
  // (c2.android.avc.encoder) only sustains 60fps below roughly a megapixel,
  // so cap the longest edge at 1280 unless the caller overrides it.
  maxSize: 1280,
  // Late joiners get keyframes on demand via reset-video, so a long interval
  // avoids periodic keyframe bursts.
  keyFrameInterval: 10,
  repeatFrameMs: 0,
} as const;

export type VideoFrame = {
  type: "frame";
  data: Buffer;
  pts: bigint;
  isConfig: boolean;
  isKey: boolean;
};

export type VideoSession = {
  type: "session";
  width: number;
  height: number;
  clientResized: boolean;
};

export type VideoPacket = VideoFrame | VideoSession;

function adb(serial: string, args: string[]) {
  const r = spawnSync("adb", ["-s", serial, ...args], { encoding: "utf8" });
  if (r.status !== 0)
    throw new Error(`adb -s ${serial} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function pickPort(): number {
  return 27200 + Math.floor(Math.random() * 2000);
}

function removeForward(serial: string, port: number): void {
  const r = spawnSync(
    "adb",
    ["-s", serial, "forward", "--remove", `tcp:${port}`],
    {
      encoding: "utf8",
    },
  );
  if (r.status !== 0 && !r.stderr.includes("cannot remove listener")) {
    throw new Error(
      `adb -s ${serial} forward --remove tcp:${port} failed: ${r.stderr}`,
    );
  }
}

function forwardedPort(serial: string, target: string): number | null {
  const r = spawnSync("adb", ["-s", serial, "forward", "--list"], {
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  for (const line of r.stdout.split("\n")) {
    const match = line.match(/^(\S+)\s+tcp:(\d+)\s+(.+)$/);
    if (!match) continue;
    if (match[1] === serial && match[3] === target) return Number(match[2]);
  }
  return null;
}

function forwardAbstractSocket(serial: string, scid: string): number {
  const target = `localabstract:scrcpy_${scid}`;
  const dynamic = spawnSync("adb", ["-s", serial, "forward", "tcp:0", target], {
    encoding: "utf8",
  });
  if (dynamic.status === 0) {
    const port = Number(dynamic.stdout.trim()) || forwardedPort(serial, target);
    if (port && Number.isInteger(port)) return port;
  }

  let lastError =
    dynamic.stderr.trim() || "adb did not return a forwarded port";
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = pickPort();
    const fixed = spawnSync(
      "adb",
      ["-s", serial, "forward", `tcp:${port}`, target],
      {
        encoding: "utf8",
      },
    );
    if (fixed.status === 0) return port;
    lastError = fixed.stderr.trim() || lastError;
  }
  throw new Error(`Failed to create adb forward for ${target}: ${lastError}`);
}

function randomScid(): string {
  // scrcpy parses scid with Integer.parseInt(radix=16), which is a *signed*
  // 32-bit value, so the high bit must stay clear (max 0x7FFFFFFF).
  return Math.floor(Math.random() * 0x7fffffff)
    .toString(16)
    .padStart(8, "0");
}

const MAX_READER_BUFFER_BYTES = 32 * 1024 * 1024;

type ReadKind = "header" | "payload";

export class ScrcpyStreamError extends Error {
  constructor(
    readonly code: ScrcpyErrorCode,
    message: string,
    readonly meta?: Record<string, string | number>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ScrcpyStreamError";
  }
}

export class FramedReader {
  private chunks: Buffer[] = [];
  private firstChunkOffset = 0;
  private total = 0;
  private waiters: {
    n: number;
    kind: ReadKind;
    resolve: (b: Buffer) => void;
    reject: (e: Error) => void;
  }[] = [];
  private err: ScrcpyStreamError | null = null;
  private ended = false;

  constructor(public readonly sock: Socket) {
    sock.on("data", (d: Buffer) => {
      if (this.total + d.length > MAX_READER_BUFFER_BYTES) {
        this.fail(
          new ScrcpyStreamError(
            "reader-overflow",
            `scrcpy video reader buffer overflow (> ${MAX_READER_BUFFER_BYTES} bytes)`,
            { limit: MAX_READER_BUFFER_BYTES },
          ),
        );
        return;
      }
      this.chunks.push(d);
      this.total += d.length;
      this.flush();
    });
    sock.on("error", (e: Error) =>
      this.fail(
        new ScrcpyStreamError(
          "socket-error",
          `scrcpy video socket error: ${e.message}`,
          undefined,
          { cause: e },
        ),
      ),
    );
    sock.on("end", () => this.endStream());
    sock.on("close", () => this.endStream());
  }

  // Terminal failure: record the first cause, reject pending reads, drop the
  // buffer, and destroy the socket so no further data can accumulate.
  private fail(e: ScrcpyStreamError) {
    if (this.err) return;
    this.err = e;
    this.chunks.length = 0;
    this.firstChunkOffset = 0;
    this.total = 0;
    while (this.waiters.length) this.waiters.shift()!.reject(e);
    try {
      this.sock.destroy();
    } catch {}
  }

  // Socket end/close. A pending header read with an empty buffer is a clean
  // frame-boundary EOF; anything else means the stream was cut mid-packet.
  private endStream() {
    if (this.err || this.ended) return;
    this.ended = true;
    while (this.waiters.length) {
      const w = this.waiters.shift()!;
      const clean = w.kind === "header" && this.total === 0;
      w.reject(
        clean
          ? new ScrcpyStreamError(
              "clean-eof",
              "scrcpy video stream ended cleanly",
            )
          : new ScrcpyStreamError(
              w.kind === "header" ? "truncated-header" : "truncated-payload",
              `scrcpy stream ended mid-${w.kind} (needed ${w.n}, had ${this.total})`,
              { needed: w.n, had: this.total },
            ),
      );
    }
  }

  read(n: number, kind: ReadKind): Promise<Buffer> {
    if (this.err) return Promise.reject(this.err);
    if (this.ended && this.total < n) {
      const clean = kind === "header" && this.total === 0;
      return Promise.reject(
        clean
          ? new ScrcpyStreamError(
              "clean-eof",
              "scrcpy video stream ended cleanly",
            )
          : new ScrcpyStreamError(
              kind === "header" ? "truncated-header" : "truncated-payload",
              `scrcpy stream ended mid-${kind} (needed ${n}, had ${this.total})`,
              { needed: n, had: this.total },
            ),
      );
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ n, kind, resolve, reject });
      this.flush();
    });
  }

  prepend(data: Buffer): void {
    if (data.length === 0) return;
    if (this.firstChunkOffset > 0 && this.chunks.length > 0) {
      this.chunks[0] = this.chunks[0].subarray(this.firstChunkOffset);
      this.firstChunkOffset = 0;
    }
    this.chunks.unshift(data);
    this.total += data.length;
    this.flush();
  }

  private consume(n: number): Buffer {
    const first = this.chunks[0];
    const firstAvailable = first.length - this.firstChunkOffset;
    if (firstAvailable >= n) {
      const out = first.subarray(
        this.firstChunkOffset,
        this.firstChunkOffset + n,
      );
      this.firstChunkOffset += n;
      this.total -= n;
      if (this.firstChunkOffset === first.length) {
        this.chunks.shift();
        this.firstChunkOffset = 0;
      }
      return out;
    }

    const out = Buffer.allocUnsafe(n);
    let written = 0;
    while (written < n) {
      const chunk = this.chunks[0];
      const available = chunk.length - this.firstChunkOffset;
      const take = Math.min(n - written, available);
      chunk.copy(
        out,
        written,
        this.firstChunkOffset,
        this.firstChunkOffset + take,
      );
      written += take;
      this.firstChunkOffset += take;
      this.total -= take;
      if (this.firstChunkOffset === chunk.length) {
        this.chunks.shift();
        this.firstChunkOffset = 0;
      }
    }
    return out;
  }

  private flush() {
    while (this.waiters.length && this.total >= this.waiters[0].n) {
      const w = this.waiters.shift()!;
      w.resolve(this.consume(w.n));
    }
  }
}

export function parseFrameHeader(
  header: Buffer,
  protocol: ScrcpyProtocol,
):
  | { kind: "session"; width: number; height: number; clientResized: boolean }
  | {
      kind: "frame";
      size: number;
      pts: bigint;
      isConfig: boolean;
      isKey: boolean;
    } {
  const ptsRaw = header.readBigUInt64BE(0);
  if (protocol === 4 && (ptsRaw & PACKET_V4_FLAG_SESSION) !== 0n) {
    return {
      kind: "session",
      clientResized: (header.readUInt32BE(0) & 1) !== 0,
      width: header.readUInt32BE(4),
      height: header.readUInt32BE(8),
    };
  }
  const size = header.readUInt32BE(8);
  if (size === 0 || size > 16 * 1024 * 1024) {
    throw new ScrcpyStreamError(
      "invalid-frame-size",
      `invalid scrcpy frame size: ${size}`,
      { size },
    );
  }
  const isConfig =
    protocol === 4
      ? (ptsRaw & PACKET_V4_FLAG_CONFIG) !== 0n
      : (ptsRaw & PACKET_FLAG_CONFIG) !== 0n;
  const isKey =
    protocol === 4
      ? (ptsRaw & PACKET_V4_FLAG_KEY_FRAME) !== 0n
      : (ptsRaw & PACKET_FLAG_KEY_FRAME) !== 0n;
  const pts = ptsRaw & ~(protocol === 4 ? PACKET_V4_FLAGS : PACKET_V3_FLAGS);
  return { kind: "frame", size, pts, isConfig, isKey };
}

async function waitForAbstractSocket(
  serial: string,
  name: string,
  timeoutMs = 30_000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = spawnSync(
      "adb",
      ["-s", serial, "shell", "cat", "/proc/net/unix"],
      {
        encoding: "utf8",
      },
    );
    if (r.stdout && r.stdout.includes(`@${name}`)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for scrcpy abstract socket @${name}`);
}

async function connectOnce(port: number, timeoutMs = 3_000): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const s = createConnection({ host: "127.0.0.1", port });
    const timeout = setTimeout(() => {
      s.destroy();
      reject(new Error(`Timed out connecting to adb forward tcp:${port}`));
    }, timeoutMs);
    const onError = (e: Error) => {
      clearTimeout(timeout);
      s.removeListener("connect", onConnect);
      reject(e);
    };
    const onConnect = () => {
      clearTimeout(timeout);
      s.removeListener("error", onError);
      resolve(s);
    };
    s.once("error", onError);
    s.once("connect", onConnect);
  });
}

const CODEC_NAMES: Record<number, string> = {
  0x68323634: "h264",
  0x68323635: "h265",
  0x00617631: "av1",
};

export function parseVideoPreamble(buf: Buffer): {
  deviceName: string;
  codecName: string;
  width: number;
  height: number;
  protocol: ScrcpyProtocol;
  extra: Buffer;
} {
  for (const offset of [0, 1]) {
    const streamMetaOffset = offset + 64;

    if (streamMetaOffset + 16 <= buf.length) {
      const codecId = buf.readUInt32BE(streamMetaOffset);
      const sessionFlags = buf.readUInt32BE(streamMetaOffset + 4);
      const width = buf.readUInt32BE(streamMetaOffset + 8);
      const height = buf.readUInt32BE(streamMetaOffset + 12);
      const codecName = CODEC_NAMES[codecId];
      if (
        codecName &&
        (sessionFlags & 0x80000000) !== 0 &&
        width >= 1 &&
        height >= 1 &&
        width <= 16_384 &&
        height <= 16_384
      ) {
        const nameBuf = buf.subarray(offset, offset + 64);
        const deviceName = nameBuf.toString("utf8").replace(/\0+$/, "");
        return {
          deviceName,
          codecName,
          width,
          height,
          protocol: 4,
          extra: buf.subarray(streamMetaOffset + 16),
        };
      }
    }

    if (streamMetaOffset + 12 > buf.length) continue;
    const codecId = buf.readUInt32BE(streamMetaOffset);
    const width = buf.readUInt32BE(streamMetaOffset + 4);
    const height = buf.readUInt32BE(streamMetaOffset + 8);
    const codecName = CODEC_NAMES[codecId];
    if (
      !codecName ||
      width < 1 ||
      height < 1 ||
      width > 16_384 ||
      height > 16_384
    )
      continue;

    const nameBuf = buf.subarray(offset, offset + 64);
    const deviceName = nameBuf.toString("utf8").replace(/\0+$/, "");
    return {
      deviceName,
      codecName,
      width,
      height,
      protocol: 3,
      extra: buf.subarray(streamMetaOffset + 12),
    };
  }

  throw new ScrcpyStreamError(
    "protocol-parse",
    `Could not parse scrcpy video preamble: ${buf.toString("hex", 0, 24)}...`,
    { head: buf.toString("hex", 0, 24) },
  );
}

export async function startScrcpy(opts: StartOpts): Promise<ScrcpySession> {
  const jar = await ensureScrcpyServer();
  const { serial } = opts;
  const maxFps = opts.maxFps ?? SCRCPY_DEFAULTS.maxFps;
  const bitRate = opts.bitRate ?? SCRCPY_DEFAULTS.bitRate;
  const maxSize = opts.maxSize ?? SCRCPY_DEFAULTS.maxSize;
  const keyFrameInterval =
    opts.keyFrameInterval ?? SCRCPY_DEFAULTS.keyFrameInterval;
  const repeatFrameMs = opts.repeatFrameMs ?? SCRCPY_DEFAULTS.repeatFrameMs;
  // MediaCodec option types matter: repeat-previous-frame-after is a long (µs).
  const codecOptions = [
    ...(keyFrameInterval > 0 ? [`i-frame-interval=${keyFrameInterval}`] : []),
    ...(repeatFrameMs > 0
      ? [`repeat-previous-frame-after:long=${Math.round(repeatFrameMs * 1000)}`]
      : []),
  ];
  const scid = randomScid();
  let localPort: number | null = null;
  let proc: ChildProcess | null = null;
  let videoSock: Socket | null = null;
  let controlSock: Socket | null = null;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    try {
      videoSock?.destroy();
    } catch {}
    try {
      controlSock?.destroy();
    } catch {}
    try {
      proc?.kill("SIGKILL");
    } catch {}
    if (localPort !== null) {
      try {
        removeForward(serial, localPort);
      } catch {}
    }
  };

  try {
    adb(serial, ["push", jar, DEVICE_JAR_PATH]);
    localPort = forwardAbstractSocket(serial, scid);

    proc = spawn(
      "adb",
      [
        "-s",
        serial,
        "shell",
        `CLASSPATH=${DEVICE_JAR_PATH}`,
        "app_process",
        "/",
        "com.genymobile.scrcpy.Server",
        SCRCPY_VERSION,
        `scid=${scid}`,
        "log_level=info",
        "audio=false",
        "tunnel_forward=true",
        "control=true",
        "send_dummy_byte=true",
        "send_stream_meta=true",
        "send_frame_meta=true",
        "send_device_meta=true",
        `max_size=${maxSize}`,
        `video_bit_rate=${bitRate}`,
        `max_fps=${maxFps}`,
        ...(codecOptions.length > 0
          ? [`video_codec_options=${codecOptions.join(",")}`]
          : []),
        "cleanup=true",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    proc.stdout?.on("data", (b: Buffer) =>
      process.stdout.write(`[scrcpy] ${b}`),
    );
    proc.stderr?.on("data", (b: Buffer) =>
      process.stderr.write(`[scrcpy] ${b}`),
    );

    // Wait for the device-side abstract socket to appear before the host dials in;
    // otherwise adb accepts the local connection, then closes it the moment the
    // device-side connect fails, and the client sees a phantom EOF.
    await waitForAbstractSocket(serial, `scrcpy_${scid}`);

    // scrcpy in tunnel_forward mode waits for ALL configured sockets to be
    // connected before it begins streaming. Open both, then read the video
    // preamble.
    videoSock = await connectOnce(localPort);
    controlSock = await connectOnce(localPort);

    // After dummy byte, scrcpy may push clipboard events on the control socket;
    // drain them.
    controlSock.on("data", () => {});

    const reader = new FramedReader(videoSock);
    // scrcpy variants disagree on whether the video socket includes the dummy
    // byte, so detect the codec metadata alignment instead of blindly skipping.
    const preamble = parseVideoPreamble(await reader.read(81, "header"));
    if (preamble.codecName !== "h264") {
      throw new ScrcpyStreamError(
        "unsupported-codec",
        `bundled UI decodes H.264 only; device negotiated ${preamble.codecName}`,
        { codec: preamble.codecName },
      );
    }
    reader.prepend(preamble.extra);

    return {
      transport: "scrcpy",
      meta: {
        deviceName: preamble.deviceName,
        codecId: preamble.codecName,
        width: preamble.width,
        height: preamble.height,
      },
      protocol: preamble.protocol,
      videoReader: reader,
      controlSocket: controlSock,
      proc,
      scid,
      localPort,
      serial,
      readFrame: () => readFrame(reader, preamble.protocol),
      close,
    };
  } catch (err) {
    close();
    throw err;
  }
}

/**
 * Read one frame from the scrcpy video stream.
 * Returns null when the stream ends. `isConfig` marks SPS/PPS bundles.
 */
const PACKET_FLAG_CONFIG = 1n << 63n;
const PACKET_FLAG_KEY_FRAME = 1n << 62n;
const PACKET_V4_FLAG_SESSION = 1n << 63n;
const PACKET_V4_FLAG_CONFIG = 1n << 62n;
const PACKET_V4_FLAG_KEY_FRAME = 1n << 61n;
const PACKET_V3_FLAGS = PACKET_FLAG_CONFIG | PACKET_FLAG_KEY_FRAME;
const PACKET_V4_FLAGS =
  PACKET_V4_FLAG_SESSION | PACKET_V4_FLAG_CONFIG | PACKET_V4_FLAG_KEY_FRAME;

export async function readFrame(
  reader: FramedReader,
  protocol: ScrcpyProtocol,
): Promise<VideoPacket | null> {
  let header: Buffer;
  try {
    header = await reader.read(12, "header");
  } catch (e) {
    // A clean EOF at a frame boundary is the only non-error stream end; every
    // other failure (truncation, overflow, socket error) propagates with its
    // original cause so callers can classify it.
    if (e instanceof ScrcpyStreamError && e.code === "clean-eof") return null;
    throw e;
  }

  const parsed = parseFrameHeader(header, protocol);
  if (parsed.kind === "session") {
    return {
      type: "session",
      clientResized: parsed.clientResized,
      width: parsed.width,
      height: parsed.height,
    };
  }

  const data = await reader.read(parsed.size, "payload");
  return {
    type: "frame",
    data,
    pts: parsed.pts,
    isConfig: parsed.isConfig,
    isKey: parsed.isKey,
  };
}
