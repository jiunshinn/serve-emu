import { spawn } from "node:child_process";
import { Mp4Frames } from "./mp4-frames.ts";

export function hostEncoder(options: {
  width: number; height: number; fps: number; bitRate: number;
  onFrame: (data: Buffer, timestampUs: bigint) => void;
  onError: (error: Error) => void;
}) {
  const { width, height, fps, bitRate } = options;
  const proc = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-probesize", "32", "-analyzeduration", "0", "-fpsprobesize", "0",
    "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`,
    "-framerate", String(fps), "-i", "pipe:0", "-an",
    "-vf", "format=nv12", "-c:v", "h264_videotoolbox",
    "-realtime", "1", "-allow_sw", "0", "-flags", "+low_delay", "-bf", "0", "-g", String(fps),
    "-b:v", String(bitRate),
    "-movflags", "empty_moov+default_base_moof+frag_every_frame",
    "-f", "mp4", "-flush_packets", "1", "pipe:1",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let exited = false;
  const completed = new Promise<void>((resolve) => proc.once("close", () => { exited = true; resolve(); }));
  let closed = false;
  let blocked = false;
  let stderr = "";
  let idleFlush: ReturnType<typeof setTimeout> | null = null;
  let lastTimestamp = 0n;
  const timestamps: bigint[] = [];
  const parser = new Mp4Frames((data) => {
    const timestamp = timestamps.shift();
    if (timestamp !== undefined && !closed) options.onFrame(data, timestamp);
  });
  const fail = (error: Error) => { if (!closed) options.onError(error); };
  proc.on("error", fail);
  proc.stdin.on("error", fail);
  proc.stdin.on("drain", () => { blocked = false; });
  proc.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4096); });
  proc.stdout.on("data", (data: Buffer) => {
    try { parser.push(data); } catch (error) { fail(error as Error); }
  });
  proc.on("exit", (code) => {
    if (!closed) fail(new Error(`VideoToolbox encoder exited (${code}): ${stderr.trim()}`));
  });
  const submit = (rgba: Buffer, timestampUs: bigint): boolean => {
    if (closed || blocked || timestamps.length >= 4) return false;
    if (rgba.length !== width * height * 4) {
      fail(new Error("Capture dimensions changed; reconnect the experiment"));
      return false;
    }
    lastTimestamp = timestampUs > lastTimestamp ? timestampUs : lastTimestamp + 1n;
    timestamps.push(lastTimestamp);
    blocked = !proc.stdin.write(rgba);
    return true;
  };
  return {
    write(rgba: Buffer, timestampUs: bigint): boolean {
      if (closed) return false;
      if (idleFlush) clearTimeout(idleFlush);
      // FFmpeg flushes a fragment when the next packet arrives. After motion
      // stops, submit ONE duplicate so the final changed frame is not stranded.
      const flush = () => {
        idleFlush = null;
        if (!closed && !submit(rgba, timestampUs + 1n)) idleFlush = setTimeout(flush, 16);
      };
      idleFlush = setTimeout(flush, 75);
      return submit(rgba, timestampUs);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (idleFlush) clearTimeout(idleFlush);
      proc.stdin.destroy();
      proc.kill("SIGTERM");
      if (exited) return;
      const timer = setTimeout(() => { proc.kill("SIGKILL"); }, 1000);
      try { await completed; } finally { clearTimeout(timer); }
    },
  };
}
