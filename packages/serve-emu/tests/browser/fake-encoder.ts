// A stateful stand-in for the scrcpy encoder, for the browser suite. It plays
// a real H.264 GOP (tests/browser/gop-red-green.h264) as scrcpy v4 packets on
// a socket, which the server reads with the production FramedReader.
import { PassThrough } from "node:stream";

export type Gop = {
  /** SPS + PPS, sent as a codec-configuration packet. */
  config: Buffer;
  /** The IDR access unit, without inline parameter sets. */
  idr: Buffer;
  /** P-frame access units, in decode order after the IDR. */
  deltas: Buffer[];
};

const START_CODE = Buffer.from([0, 0, 0, 1]);

/** Splits an Annex-B GOP from x264 (SPS, PPS, SEI, IDR, P...) into packets. */
export function loadGop(bytes: Buffer): Gop {
  const nals: Buffer[] = [];
  let index = bytes.indexOf(Buffer.from([0, 0, 1]));
  while (index !== -1) {
    const start = index + 3;
    const next = bytes.indexOf(Buffer.from([0, 0, 1]), start);
    let end = next === -1 ? bytes.length : next;
    while (end > start && bytes[end - 1] === 0) end--;
    nals.push(bytes.subarray(start, end));
    index = next;
  }
  const withStart = (nal: Buffer) => Buffer.concat([START_CODE, nal]);
  const ofType = (type: number) => nals.filter((nal) => (nal[0]! & 0x1f) === type);
  return {
    config: Buffer.concat([...ofType(7), ...ofType(8)].map(withStart)),
    idr: Buffer.concat([...ofType(6), ...ofType(5)].map(withStart)),
    deltas: ofType(1).map(withStart),
  };
}

const V4_CONFIG = 1n << 62n;
const V4_KEY_FRAME = 1n << 61n;

export function v4SessionPacket(width: number, height: number): Buffer {
  const packet = Buffer.alloc(12);
  packet.writeUInt32BE(0x8000_0000, 0);
  packet.writeUInt32BE(width, 4);
  packet.writeUInt32BE(height, 8);
  return packet;
}

export function v4FramePacket(
  data: Buffer,
  pts: bigint,
  { config = false, key = false }: { config?: boolean; key?: boolean } = {},
): Buffer {
  const header = Buffer.alloc(12);
  header.writeBigUInt64BE(pts | (config ? V4_CONFIG : 0n) | (key ? V4_KEY_FRAME : 0n), 0);
  header.writeUInt32BE(data.length, 8);
  return Buffer.concat([header, data]);
}

export type EncoderOptions = {
  /** Frames between periodic IDRs (sent without config); 0 disables them. */
  keyframeIntervalFrames: number;
  /** Whether a reset-video control packet restarts the encoder. */
  answerResets: boolean;
};

export const DEFAULT_ENCODER_OPTIONS: Readonly<EncoderOptions> = {
  keyframeIntervalFrames: 30,
  answerResets: true,
};

export type EncoderStats = {
  sessions: number;
  configs: number;
  keyframes: number;
  resetKeyframes: number;
  deltas: number;
};

/**
 * Starts like scrcpy (session, config, IDR) and then sends one P frame per
 * tick. A reset restarts it the same way; a periodic IDR repeats the GOP
 * without resending the config, so a late joiner depends on the server's
 * cached SPS/PPS.
 */
export class FakeEncoder {
  readonly socket = new PassThrough();
  readonly stats: EncoderStats = { sessions: 0, configs: 0, keyframes: 0, resetKeyframes: 0, deltas: 0 };
  options: EncoderOptions = { ...DEFAULT_ENCODER_OPTIONS };
  #frame = 0;
  #pts = 0n;
  #resetPending = false;
  #startedByReset = false;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly gop: Gop,
    private readonly size: { width: number; height: number },
    private readonly frameIntervalMs = 100,
  ) {}

  start(): void {
    this.#startSession(false);
    this.#tick();
    this.#timer = setInterval(() => this.#tick(), this.frameIntervalMs);
  }

  requestReset(): void {
    if (this.options.answerResets) this.#resetPending = true;
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.socket.end();
  }

  #startSession(fromReset: boolean): void {
    this.socket.write(v4SessionPacket(this.size.width, this.size.height));
    this.socket.write(v4FramePacket(this.gop.config, 0n, { config: true }));
    this.stats.sessions++;
    this.stats.configs++;
    this.#frame = 0;
    this.#startedByReset = fromReset;
  }

  #tick(): void {
    if (this.#resetPending) {
      this.#resetPending = false;
      this.#startSession(true);
    } else {
      const interval = this.options.keyframeIntervalFrames;
      if ((interval > 0 && this.#frame >= interval) || this.#frame > this.gop.deltas.length) {
        this.#frame = 0;
        this.#startedByReset = false;
      }
    }
    if (this.#frame === 0) {
      this.socket.write(v4FramePacket(this.gop.idr, this.#pts, { key: true }));
      this.stats.keyframes++;
      if (this.#startedByReset) this.stats.resetKeyframes++;
    } else {
      this.socket.write(v4FramePacket(this.gop.deltas[this.#frame - 1]!, this.#pts));
      this.stats.deltas++;
    }
    this.#frame++;
    this.#pts += BigInt(this.frameIntervalMs) * 1000n;
  }
}
