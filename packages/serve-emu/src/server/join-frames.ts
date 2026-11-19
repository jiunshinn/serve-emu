import type { VideoPacket } from "../scrcpy.ts";
import { FRAME_META_HEADER_BYTES } from "../shared/frame-meta.ts";

type Frame = Extract<VideoPacket, { type: "frame" }>;
const MAX_JOIN_FRAMES = 32; // Within the browser decoder's 48-frame queue ceiling.
const MAX_JOIN_BYTES = 1024 * 1024;

/** A late viewer needs every dependency from the latest IDR to the live edge. */
export class JoinFrames {
  #frames: Frame[] = [];
  #bytes = 0;

  get frames(): readonly Frame[] {
    return this.#frames;
  }

  clear(): void {
    this.#frames.length = 0;
    this.#bytes = 0;
  }

  append(frame: Frame, config: Buffer | null): void {
    if (frame.isKey) this.clear();
    else if (this.#frames.length === 0) return;

    const bytes = frame.data.length + FRAME_META_HEADER_BYTES + (config?.length ?? 0);
    if (this.#frames.length >= MAX_JOIN_FRAMES || this.#bytes + bytes > MAX_JOIN_BYTES) {
      this.clear();
      return;
    }
    this.#frames.push(frame);
    this.#bytes += bytes;
  }
}
