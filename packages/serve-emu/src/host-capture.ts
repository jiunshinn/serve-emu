import { discoverEmulatorGrpc, EmulatorGrpcError, HostCaptureUnavailableError, startScreenshotStream } from "./emulator-grpc.ts";
import { startHostEncoder } from "./host-encoder.ts";
import { SCRCPY_DEFAULTS, startScrcpy, type ScrcpySession, type StartOpts, type VideoPacket } from "./scrcpy.ts";

type Dependencies = {
  discover?: typeof discoverEmulatorGrpc;
  startControl?: typeof startScrcpy;
  startStream?: typeof startScreenshotStream;
  startEncoder?: typeof startHostEncoder;
  firstFrameTimeoutMs?: number;
};

async function waitForCapture<T>(pending: Promise<T>, signal: AbortSignal, timeoutMs: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      abort = () => reject(new HostCaptureUnavailableError("capture aborted"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      timer = setTimeout(() => reject(new HostCaptureUnavailableError(reason)), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

/** Combines native emulator screenshots and host H.264 with scrcpy input. */
export async function startHostCaptureSession(opts: StartOpts, deps: Dependencies = {}): Promise<ScrcpySession> {
  const lifecycle = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, lifecycle.signal]) : lifecycle.signal;
  let control: ScrcpySession | undefined;
  let stream: Awaited<ReturnType<typeof startScreenshotStream>> | undefined;
  let encoder: Awaited<ReturnType<typeof startHostEncoder>> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  let terminal: Error | null | undefined;
  const packets: VideoPacket[] = [];
  let wake: (() => void) | undefined;
  const finish = (error: Error | null) => { if (terminal === undefined) terminal = error; wake?.(); };
  const enqueue = (packet: VideoPacket) => {
    if (closed || terminal !== undefined) return;
    if (packets.length >= 64) throw new Error("Host capture packet queue overflow");
    packets.push(packet);
    wake?.();
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    signal.removeEventListener("abort", onAbort);
    lifecycle.abort();
    finish(null);
    closing = (async () => {
      const results = await Promise.allSettled([stream?.close(), encoder?.close(), control?.close()]);
      signal.removeEventListener("abort", onAbort);
      if (results.some((result) => result.status === "rejected")) throw new Error("Host capture cleanup failed");
    })();
    return closing;
  };
  const onAbort = () => { finish(new Error("Host capture aborted")); void close().catch(() => {}); };

  try {
    const endpoint = await (deps.discover ?? discoverEmulatorGrpc)(opts.serial);
    signal.throwIfAborted();
    control = await (deps.startControl ?? startScrcpy)({ ...opts, signal, video: false });
    stream = await (deps.startStream ?? startScreenshotStream)(endpoint, signal);
    const frames = stream.frames();
    const first = await waitForCapture(frames.next(), signal, deps.firstFrameTimeoutMs ?? 10_000, "first screenshot timed out");
    if (first.done) throw new HostCaptureUnavailableError("screenshot stream ended before first frame");
    signal.throwIfAborted();
    const meta = { ...control.meta, width: first.value.width, height: first.value.height };
    const buildEncoder = async (width: number, height: number) => {
      const previous = encoder;
      encoder = undefined;
      await previous?.close();
      signal.throwIfAborted();
      meta.width = width;
      meta.height = height;
      const nextEncoder = await (deps.startEncoder ?? startHostEncoder)({
        mmapPath: stream!.mmapPath, width, height,
        maxFps: opts.maxFps ?? SCRCPY_DEFAULTS.maxFps,
        bitRate: opts.bitRate ?? SCRCPY_DEFAULTS.bitRate,
        keyFrameInterval: opts.keyFrameInterval ?? SCRCPY_DEFAULTS.keyFrameInterval,
      });
      if (signal.aborted) await nextEncoder.close();
      signal.throwIfAborted();
      encoder = nextEncoder;
      enqueue({ type: "session", width, height, clientResized: false });
      const current = encoder;
      const output = current.packets();
      current.pushFrame();
      const firstPacket = await waitForCapture(output.next(), signal, deps.firstFrameTimeoutMs ?? 10_000, "first encoded frame timed out");
      if (firstPacket.done) throw new HostCaptureUnavailableError("encoder ended before first packet");
      enqueue({ type: "frame", ...firstPacket.value });
      void (async () => {
        try {
          for await (const packet of output) {
            if (encoder !== current || closed) return;
            enqueue({ type: "frame", ...packet });
          }
          if (encoder === current && !closed) finish(null);
        } catch (cause) {
          if (encoder === current && !closed && terminal === undefined) {
            const error = new Error("Host encoder stream failed", { cause });
            console.error("[host-capture]", error);
            finish(error);
          }
        }
      })();
    };
    await buildEncoder(meta.width, meta.height);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void (async () => {
      try {
        while (!closed && terminal === undefined) {
          const next = await frames.next();
          if (next.done) { finish(null); break; }
          const frame = next.value;
          if (frame.width !== meta.width || frame.height !== meta.height) await buildEncoder(frame.width, frame.height);
          else encoder?.pushFrame();
        }
      } catch {
        if (!closed) finish(new Error("Host screenshot stream failed"));
      }
    })();
    return {
      ...control, transport: "host-capture", meta,
      requestKeyFrame() { encoder?.requestKeyFrame(); },
      async readFrame() {
        while (packets.length === 0 && terminal === undefined) await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
        const packet = packets.shift();
        if (packet) return packet;
        if (terminal) throw terminal;
        return null;
      },
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    if (error instanceof HostCaptureUnavailableError || error instanceof EmulatorGrpcError) throw error;
    throw new HostCaptureUnavailableError("capture startup failed");
  }
}

/** Opt-in host capture, with a credential-safe fallback to device encoding. */
export async function openCaptureSession(opts: StartOpts & { hostCapture?: boolean }, deps: {
  platform?: NodeJS.Platform;
  startHost?: typeof startHostCaptureSession;
  startScrcpy?: typeof startScrcpy;
  log?: (line: string) => void;
} = {}): Promise<ScrcpySession> {
  let reason: string | undefined;
  if (opts.hostCapture && (deps.platform ?? process.platform) === "darwin" && /^emulator-\d+$/.test(opts.serial)) {
    try { return await (deps.startHost ?? startHostCaptureSession)(opts); }
    catch (error) {
      opts.signal?.throwIfAborted();
      reason = error instanceof HostCaptureUnavailableError ? error.reason
        : error instanceof EmulatorGrpcError ? `emulator gRPC status ${error.status}` : "capture startup failed";
      (deps.log ?? console.warn)(`[host-capture] ${reason}; falling back to scrcpy`);
    }
  }
  const session = await (deps.startScrcpy ?? startScrcpy)({ ...opts, video: true });
  if (reason) session.hostCaptureFallbackReason = reason;
  return session;
}
