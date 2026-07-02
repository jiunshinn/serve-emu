import { buildCodecString, scanAU } from "./h264";
import { epochNowMs, parseFramePacket } from "../../shared/frame-meta";

// The worker owns the whole WebSocket → decode → present pipeline so that
// main-thread work (React renders, health polling, panels) can never stall
// frame presentation, and vice versa.

// How deep the decoder's pending queue may grow before we jump to a keyframe to
// shed latency. Hardware decoders keep a multi-frame pipeline, so a small value
// like 4 trips on every transient hiccup; 12 (~200ms at 60fps) tolerates spikes
// while still bounding latency.
const SOFT_DECODE_QUEUE_SIZE = 12;
const DECODER_RECOVERY_COOLDOWN_MS = 500;
const KEYFRAME_REQUEST_COOLDOWN_MS = 400;
const FRAME_QUEUE_SIZE = 3;
const PENDING_TIMING_LIMIT = 256;
const STATS_INTERVAL_MS = 1000;

export type StreamStats = {
  fps: number;
  decodeQueue: number;
  transitMs: number | null;
  e2eMs: number | null;
  codec: string | null;
  rendered: boolean;
};

type WorkerCommand =
  | { type: "init"; canvas: OffscreenCanvas; url: string }
  | { type: "connect" }
  | { type: "send"; text: string }
  | { type: "stop" };

// Typed against the worker global's message surface only, to avoid pulling the
// whole WebWorker lib into the DOM-flavored UI tsconfig.
const workerPort = self as unknown as {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
};

// requestAnimationFrame is available in dedicated workers everywhere WebCodecs
// is, but fall back to a vsync-ish timer just in case.
const scheduleFrame: (cb: () => void) => number =
  typeof requestAnimationFrame === "function"
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(cb, 16) as unknown as number;
const cancelFrame: (handle: number) => void =
  typeof cancelAnimationFrame === "function" ? (h) => cancelAnimationFrame(h) : (h) => clearTimeout(h);

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let url = "";
let ws: WebSocket | null = null;
let stopped = false;
let reconnectDelay = 500;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let decoder: VideoDecoder | null = null;
let codecString: string | null = null;
let sawKeyframe = false;
let frameIdx = 0;
let frameQueue: (VideoFrame | null)[] = new Array(FRAME_QUEUE_SIZE).fill(null);
let frameQueueHead = 0;
let frameQueueCount = 0;
let renderHandle = 0;
let lastDecoderRecoveryAt = 0;
let lastKeyframeRequestAt = 0;
let droppingUntilKeyframe = false;

// Per-frame receive/server timestamps keyed by chunk timestamp, so decoded
// VideoFrames (which carry the same timestamp) can be matched back for
// latency measurement.
const pendingTimings = new Map<number, { recvMs: number; serverTsMs: number | null }>();
let hasRendered = false;
let renderedSinceTick = 0;
let transitSumMs = 0;
let transitCount = 0;
let e2eSumMs = 0;
let e2eCount = 0;

const postStatus = (status: string) => workerPort.postMessage({ type: "status", status });

const postStats = () => {
  const stats: StreamStats = {
    fps: renderedSinceTick,
    decodeQueue: decoder?.decodeQueueSize ?? 0,
    transitMs: transitCount > 0 ? Math.round((transitSumMs / transitCount) * 10) / 10 : null,
    e2eMs: e2eCount > 0 ? Math.round((e2eSumMs / e2eCount) * 10) / 10 : null,
    codec: codecString,
    rendered: hasRendered,
  };
  renderedSinceTick = 0;
  transitSumMs = 0;
  transitCount = 0;
  e2eSumMs = 0;
  e2eCount = 0;
  workerPort.postMessage({ type: "stats", stats });
};

const rememberTiming = (timestamp: number, recvMs: number, serverTsMs: number | null) => {
  if (pendingTimings.size >= PENDING_TIMING_LIMIT) {
    const oldest = pendingTimings.keys().next();
    if (!oldest.done) pendingTimings.delete(oldest.value);
  }
  pendingTimings.set(timestamp, { recvMs, serverTsMs });
};

const clearFrameQueue = () => {
  if (renderHandle) {
    cancelFrame(renderHandle);
    renderHandle = 0;
  }
  for (let i = 0; i < FRAME_QUEUE_SIZE; i++) {
    const frame = frameQueue[i];
    if (frame) pendingTimings.delete(frame.timestamp);
    frame?.close();
    frameQueue[i] = null;
  }
  frameQueueHead = 0;
  frameQueueCount = 0;
};

const closeDecoder = () => {
  if (!decoder) return;
  try {
    if (decoder.state !== "closed") decoder.close();
  } catch {}
  decoder = null;
  pendingTimings.clear();
};

const requestKeyframe = () => {
  const now = performance.now();
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (now - lastKeyframeRequestAt < KEYFRAME_REQUEST_COOLDOWN_MS) return;
  lastKeyframeRequestAt = now;
  ws.send(JSON.stringify({ type: "reset-video", ack: false }));
};

// Soft recovery: the pipeline fell behind but the decoder is still healthy.
// Keep it configured (no close/reconfigure cost, no SPS re-init) and just
// drop incoming deltas until the next keyframe to shed accumulated latency.
// Frames already inside the decoder keep draining to the canvas meanwhile,
// so the stream stays smooth instead of freezing on a teardown.
const recoverToKeyframe = () => {
  const now = performance.now();
  if (now - lastDecoderRecoveryAt < DECODER_RECOVERY_COOLDOWN_MS && droppingUntilKeyframe) return;
  lastDecoderRecoveryAt = now;
  droppingUntilKeyframe = true;
  requestKeyframe();
};

// Hard recovery: the decoder itself errored. Tear it down and rebuild from
// the next keyframe's SPS/PPS.
const beginDecoderRecovery = () => {
  const now = performance.now();
  if (now - lastDecoderRecoveryAt < DECODER_RECOVERY_COOLDOWN_MS && droppingUntilKeyframe) return;
  lastDecoderRecoveryAt = now;
  closeDecoder();
  clearFrameQueue();
  sawKeyframe = false;
  frameIdx = 0;
  droppingUntilKeyframe = true;
  requestKeyframe();
  postStatus("recovering video");
};

const renderFromQueue = () => {
  renderHandle = 0;
  if (frameQueueCount === 0 || !canvas || !ctx) return;

  // Latency-first policy: each vsync, present the NEWEST decoded frame and
  // discard the staler ones still queued. They were superseded before they
  // could be shown, so drawing them would only add display lag. Showing the
  // freshest frame keeps glass-to-glass latency near one vsync interval
  // instead of growing with queue depth. The queue stays as a small burst
  // absorber.
  const tail = (frameQueueHead - frameQueueCount + FRAME_QUEUE_SIZE) % FRAME_QUEUE_SIZE;
  for (let k = 0; k < frameQueueCount - 1; k++) {
    const idx = (tail + k) % FRAME_QUEUE_SIZE;
    const stale = frameQueue[idx];
    if (stale) pendingTimings.delete(stale.timestamp);
    stale?.close();
    frameQueue[idx] = null;
  }
  const newest = (frameQueueHead - 1 + FRAME_QUEUE_SIZE) % FRAME_QUEUE_SIZE;
  const frame = frameQueue[newest]!;
  frameQueue[newest] = null;
  frameQueueHead = 0;
  frameQueueCount = 0;

  if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
  }
  ctx.drawImage(frame, 0, 0);

  const timing = pendingTimings.get(frame.timestamp);
  if (timing) {
    pendingTimings.delete(frame.timestamp);
    if (timing.serverTsMs !== null) {
      e2eSumMs += epochNowMs() - timing.serverTsMs;
      e2eCount++;
    }
  }
  frame.close();
  if (!hasRendered) {
    hasRendered = true;
    // Tell the main thread right away, before the next stats tick — the first
    // health poll races against it and would otherwise latch "waiting for video".
    workerPort.postMessage({ type: "rendered" });
  }
  renderedSinceTick++;
};

const ensureDecoder = (spsBytes: Uint8Array): boolean => {
  if (decoder?.state === "configured") return true;
  closeDecoder();
  if (!ctx) return false;
  const codec = buildCodecString(spsBytes);
  let dec: VideoDecoder;
  dec = new VideoDecoder({
    output: (frame) => {
      if (decoder !== dec) {
        frame.close();
        return;
      }
      if (frameQueueCount >= FRAME_QUEUE_SIZE) {
        const tail = (frameQueueHead - frameQueueCount + FRAME_QUEUE_SIZE) % FRAME_QUEUE_SIZE;
        const stale = frameQueue[tail];
        if (stale) pendingTimings.delete(stale.timestamp);
        stale?.close();
        frameQueue[tail] = null;
        frameQueueCount--;
      }
      frameQueue[frameQueueHead] = frame;
      frameQueueHead = (frameQueueHead + 1) % FRAME_QUEUE_SIZE;
      frameQueueCount++;
      if (!renderHandle) {
        renderHandle = scheduleFrame(renderFromQueue);
      }
    },
    error: (e) => {
      console.error("VideoDecoder error", e);
      postStatus("decoder error");
      if (decoder === dec) beginDecoderRecovery();
    },
  });
  try {
    dec.configure({ codec, optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" });
    decoder = dec;
    codecString = codec;
    console.log("VideoDecoder configured:", codec);
    return true;
  } catch (e) {
    console.error("VideoDecoder configure failed", e);
    try {
      dec.close();
    } catch {}
    postStatus("decoder config failed");
    requestKeyframe();
    return false;
  }
};

const feedFrame = (raw: ArrayBuffer) => {
  const recvMs = epochNowMs();
  const packet = parseFramePacket(raw);
  if (packet.serverTsMs !== null) {
    transitSumMs += recvMs - packet.serverTsMs;
    transitCount++;
  }
  const needsScan =
    packet.isKey === null ||
    (packet.isKey && (!decoder || decoder.state !== "configured" || droppingUntilKeyframe));
  const scanned = needsScan ? scanAU(packet.data) : null;
  const isKey = packet.isKey ?? scanned?.isKey ?? false;
  const spsBytes = scanned?.spsBytes ?? null;
  if (spsBytes && !ensureDecoder(spsBytes)) return;

  if (droppingUntilKeyframe) {
    if (!isKey) return;
    if (!decoder || decoder.state !== "configured") {
      requestKeyframe();
      return;
    }
    droppingUntilKeyframe = false;
  }

  if (!decoder || decoder.state !== "configured") {
    if (!isKey) requestKeyframe();
    return;
  }

  if (decoder.decodeQueueSize > SOFT_DECODE_QUEUE_SIZE) {
    recoverToKeyframe();
    return;
  }

  if (!sawKeyframe) {
    if (!isKey) {
      requestKeyframe();
      return;
    }
    sawKeyframe = true;
    postStatus("streaming");
  }
  const timestamp = packet.timestamp ?? Math.round((frameIdx * 1_000_000) / 60);
  try {
    decoder.decode(
      new EncodedVideoChunk({
        type: isKey ? "key" : "delta",
        timestamp,
        data: packet.data,
      }),
    );
    frameIdx++;
    rememberTiming(timestamp, recvMs, packet.serverTsMs);
  } catch (e) {
    console.error("decode failed", e);
    beginDecoderRecovery();
  }
};

const connect = () => {
  if (stopped) return;
  const sock = new WebSocket(url);
  sock.binaryType = "arraybuffer";
  ws = sock;
  sock.onopen = () => {
    reconnectDelay = 500;
    postStatus("streaming");
  };
  sock.onerror = () => postStatus("connection error");
  sock.onclose = () => {
    if (stopped || ws !== sock) return;
    const retryIn = reconnectDelay;
    postStatus(`disconnected — retrying in ${Math.round(retryIn / 1000)}s`);
    closeDecoder();
    frameIdx = 0;
    sawKeyframe = false;
    reconnectDelay = Math.min(Math.round(reconnectDelay * 1.6), 5000);
    retryTimer = setTimeout(connect, retryIn);
  };
  sock.onmessage = (e) => {
    if (typeof e.data === "string") {
      try {
        const msg = JSON.parse(e.data) as { type?: string; size?: { width: number; height: number } };
        if (
          msg.type === "video-session" &&
          msg.size &&
          Number.isFinite(msg.size.width) &&
          Number.isFinite(msg.size.height)
        ) {
          closeDecoder();
          clearFrameQueue();
          frameIdx = 0;
          sawKeyframe = false;
          droppingUntilKeyframe = true;
          workerPort.postMessage({ type: "session", size: msg.size });
          requestKeyframe();
        }
      } catch {}
      return;
    }
    feedFrame(e.data as ArrayBuffer);
  };
};

const start = () => {
  stopped = false;
  if (statsTimer === null) statsTimer = setInterval(postStats, STATS_INTERVAL_MS);
  connect();
};

const stop = () => {
  stopped = true;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (statsTimer !== null) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
  const sock = ws;
  ws = null;
  try {
    sock?.close();
  } catch {}
  clearFrameQueue();
  closeDecoder();
};

workerPort.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data as WorkerCommand;
  switch (msg.type) {
    case "init": {
      if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") {
        postStatus("WebCodecs unsupported");
        return;
      }
      canvas = msg.canvas;
      ctx = canvas.getContext("2d", { alpha: false }) as OffscreenCanvasRenderingContext2D | null;
      if (!ctx) {
        postStatus("canvas unavailable");
        return;
      }
      url = msg.url;
      start();
      break;
    }
    case "connect": {
      if (!canvas || !ctx) return;
      if (stopped) {
        reconnectDelay = 500;
        start();
      }
      break;
    }
    case "send": {
      if (ws?.readyState === WebSocket.OPEN) ws.send(msg.text);
      break;
    }
    case "stop": {
      stop();
      break;
    }
  }
});
