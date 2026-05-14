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

export type ScrcpySession = {
  meta: ScrcpyMeta;
  videoReader: FramedReader;
  controlSocket: Socket;
  proc: ChildProcess;
  scid: string;
  localPort: number;
  serial: string;
  close: () => void;
};

export type StartOpts = {
  serial: string;
  maxFps?: number;
  bitRate?: number;
  maxSize?: number;
};

function adb(serial: string, args: string[]) {
  const r = spawnSync("adb", ["-s", serial, ...args], { encoding: "utf8" });
  if (r.status !== 0)
    throw new Error(`adb -s ${serial} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function pickPort(): number {
  return 27200 + Math.floor(Math.random() * 2000);
}

function randomScid(): string {
  // scrcpy parses scid with Integer.parseInt(radix=16), which is a *signed*
  // 32-bit value, so the high bit must stay clear (max 0x7FFFFFFF).
  return Math.floor(Math.random() * 0x7fffffff)
    .toString(16)
    .padStart(8, "0");
}

class FramedReader {
  private chunks: Buffer[] = [];
  private total = 0;
  private waiters: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void }[] = [];
  private err: Error | null = null;

  constructor(public readonly sock: Socket) {
    sock.on("data", (d: Buffer) => {
      this.chunks.push(d);
      this.total += d.length;
      this.flush();
    });
    const fail = (e: Error) => {
      this.err = e;
      while (this.waiters.length) this.waiters.shift()!.reject(e);
    };
    sock.on("error", fail);
    sock.on("end", () => fail(new Error("scrcpy video socket ended")));
    sock.on("close", () => fail(new Error("scrcpy video socket closed")));
  }

  read(n: number): Promise<Buffer> {
    if (this.err) return Promise.reject(this.err);
    return new Promise((resolve, reject) => {
      this.waiters.push({ n, resolve, reject });
      this.flush();
    });
  }

  private flush() {
    while (this.waiters.length && this.total >= this.waiters[0].n) {
      const w = this.waiters.shift()!;
      const merged = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
      const out = merged.subarray(0, w.n);
      const rest = merged.subarray(w.n);
      this.chunks = rest.length > 0 ? [rest] : [];
      this.total = rest.length;
      w.resolve(out);
    }
  }
}

async function waitForAbstractSocket(serial: string, name: string, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = spawnSync("adb", ["-s", serial, "shell", "cat", "/proc/net/unix"], {
      encoding: "utf8",
    });
    if (r.stdout && r.stdout.includes(`@${name}`)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for scrcpy abstract socket @${name}`);
}

async function connectOnce(port: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const s = createConnection({ host: "127.0.0.1", port });
    const onError = (e: Error) => {
      s.removeListener("connect", onConnect);
      reject(e);
    };
    const onConnect = () => {
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

export async function startScrcpy(opts: StartOpts): Promise<ScrcpySession> {
  const jar = await ensureScrcpyServer();
  const { serial } = opts;
  const maxFps = opts.maxFps ?? 60;
  const bitRate = opts.bitRate ?? 8_000_000;
  const maxSize = opts.maxSize ?? 0;
  const scid = randomScid();
  const localPort = pickPort();

  adb(serial, ["push", jar, DEVICE_JAR_PATH]);
  adb(serial, ["forward", `tcp:${localPort}`, `localabstract:scrcpy_${scid}`]);

  const proc = spawn(
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
      "send_codec_meta=true",
      "send_frame_meta=true",
      "send_device_meta=true",
      `max_size=${maxSize}`,
      `video_bit_rate=${bitRate}`,
      `max_fps=${maxFps}`,
      "cleanup=true",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  proc.stdout.on("data", (b: Buffer) => process.stdout.write(`[scrcpy] ${b}`));
  proc.stderr.on("data", (b: Buffer) => process.stderr.write(`[scrcpy] ${b}`));

  // Wait for the device-side abstract socket to appear before the host dials in;
  // otherwise adb accepts the local connection, then closes it the moment the
  // device-side connect fails, and the client sees a phantom EOF.
  await waitForAbstractSocket(serial, `scrcpy_${scid}`);

  // scrcpy in tunnel_forward mode waits for ALL configured sockets to be
  // connected before it begins streaming. Open both, then read the video
  // preamble.
  const videoSock = await connectOnce(localPort);
  const controlSock = await connectOnce(localPort);

  // After dummy byte, scrcpy may push clipboard events on the control socket;
  // drain them.
  controlSock.on("data", () => {});

  const reader = new FramedReader(videoSock);
  // send_dummy_byte=true → 0x00
  await reader.read(1);
  // send_device_meta=true → 64-byte null-padded UTF-8 name
  const nameBuf = await reader.read(64);
  const deviceName = nameBuf.toString("utf8").replace(/\0+$/, "");
  // send_codec_meta=true → codec_id (BE u32) + width (BE u32) + height (BE u32)
  const codecMeta = await reader.read(12);
  const codecId = codecMeta.readUInt32BE(0);
  const width = codecMeta.readUInt32BE(4);
  const height = codecMeta.readUInt32BE(8);
  const codecName = CODEC_NAMES[codecId] ?? `0x${codecId.toString(16)}`;

  const close = () => {
    try {
      videoSock.destroy();
    } catch {}
    try {
      controlSock.destroy();
    } catch {}
    try {
      proc.kill("SIGKILL");
    } catch {}
    try {
      adb(serial, ["forward", "--remove", `tcp:${localPort}`]);
    } catch {}
  };

  return {
    meta: { deviceName, codecId: codecName, width, height },
    videoReader: reader,
    controlSocket: controlSock,
    proc,
    scid,
    localPort,
    serial,
    close,
  };
}

/**
 * Read one frame from the scrcpy video stream.
 * Returns null when the stream ends. `isConfig` marks SPS/PPS bundles.
 */
const PACKET_FLAG_CONFIG = 1n << 63n;
const PACKET_FLAG_KEY_FRAME = 1n << 62n;
const PACKET_FLAGS = PACKET_FLAG_CONFIG | PACKET_FLAG_KEY_FRAME;

export async function readFrame(
  reader: FramedReader,
): Promise<{ data: Buffer; pts: bigint; isConfig: boolean; isKey: boolean } | null> {
  try {
    const header = await reader.read(12);
    const ptsRaw = header.readBigUInt64BE(0);
    const size = header.readUInt32BE(8);
    const isConfig = (ptsRaw & PACKET_FLAG_CONFIG) !== 0n;
    const isKey = (ptsRaw & PACKET_FLAG_KEY_FRAME) !== 0n;
    const pts = ptsRaw & ~PACKET_FLAGS;
    const data = await reader.read(size);
    return { data, pts, isConfig, isKey };
  } catch {
    return null;
  }
}
