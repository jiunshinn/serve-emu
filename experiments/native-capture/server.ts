import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { createClient } from "./grpc-client.ts";
import { hostEncoder } from "./host-encoder.ts";
import { startScrcpy, type ScrcpySession } from "../../packages/serve-emu/src/scrcpy.ts";
import { dispatch, resetVideoPacket, type Gesture } from "../../packages/serve-emu/src/input.ts";
import { parseWsClientJson } from "../../packages/serve-emu/src/shared/websocket-contracts.ts";
import { FRAME_META_HEADER_BYTES, writeFrameMetaHeader, epochNowMs } from "../../packages/serve-emu/src/shared/frame-meta.ts";
import { scanAU } from "../../packages/serve-emu/src/ui/lib/h264.ts";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
  serial: { type: "string" }, discovery: { type: "string" },
  "emulator-dir": { type: "string", default: join(process.env.ANDROID_HOME ?? join(homedir(), "Library/Android/sdk"), "emulator") },
  port: { type: "string", default: "3302" }, "max-size": { type: "string", default: "1280" },
  fps: { type: "string", default: "60" }, "bit-rate": { type: "string", default: "8000000" },
  probe: { type: "boolean", default: false },
} });
if (!values.serial) throw new Error("Pass --serial emulator-N (the experiment never selects a device implicitly)");
const serial = values.serial;
const bounded = (value: string, min: number, max: number) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Expected integer ${min}..${max}, got ${value}`);
  return number;
};
const port = bounded(values.port!, 1024, 65535);
const maxSize = bounded(values["max-size"]!, 128, 2560);
const fps = bounded(values.fps!, 1, 120);
const bitRate = bounded(values["bit-rate"]!, 100_000, 50_000_000);
const grpc = await createClient({ emulatorDir: values["emulator-dir"]!, discoveryFile: values.discovery, serial });
if (values.probe) {
  try {
    const screenshot = await grpc.screenshot({ maxSize: 128 });
    console.log(JSON.stringify({ capture: { width: screenshot.width, height: screenshot.height, bytes: screenshot.rgba.length }, rtc: await grpc.probeRtc() }, null, 2));
  } finally { await grpc.close(); }
  process.exit(0);
}
let physicalSize: { width: number; height: number };
const assets = new Map<string, Blob>();
try {
const original = await grpc.screenshot({ maxSize: 0 });
physicalSize = { width: original.width, height: original.height };
for (const [route, entrypoint] of [
  ["/client.js", join(import.meta.dir, "client.ts")],
  ["/worker.js", join(import.meta.dir, "../../packages/serve-emu/src/ui/lib/stream-worker.ts")],
] as const) {
  const build = await Bun.build({ entrypoints: [entrypoint], target: "browser", minify: false });
  if (!build.success) throw new Error(build.logs.join("\n"));
  assets.set(route, build.outputs[0]!);
}
} catch (error) { await grpc.close(); throw error; }

type Backend = "scrcpy" | "native";
type Client = ServerWebSocket<{ backend: Backend }>;
let active: Client | null = null;
let acceptedClient: Client | null = null;
let activeAbort: AbortController | null = null;
let closePipeline: (() => Promise<void>) | null = null;
let scrcpy: ScrcpySession | null = null;
let switching = Promise.resolve();
let controlQueue = Promise.resolve();
let pendingControls = 0;
let nativePointer: { x: number; y: number } | null = null;
let lastReset = 0;
let sourceWindow = 0;
let encodedWindow = 0;
let previousTick = performance.now();
const health = { backend: "none" as string, width: 0, height: 0, sourceFps: 0, encodedFps: 0, droppedFrames: 0, clients: 0, error: null as string | null };
const tick = setInterval(() => {
  const now = performance.now(), seconds = (now - previousTick) / 1000;
  health.sourceFps = Math.round(sourceWindow / seconds * 10) / 10;
  health.encodedFps = Math.round(encodedWindow / seconds * 10) / 10;
  sourceWindow = encodedWindow = 0; previousTick = now;
}, 1000);

async function stopPipeline() {
  activeAbort?.abort(); activeAbort = null;
  const close = closePipeline;
  closePipeline = null; scrcpy = null;
  if (close) await close();
  await controlQueue;
  if (nativePointer) {
    const point = nativePointer;
    nativePointer = null;
    await grpc.sendMouse({ ...point, buttons: 0 }).catch((error) => {
      console.error("Native pointer release failed:", String(error));
    });
  }
}
function sendFrame(ws: Client, data: Buffer, pts: bigint, isKey: boolean) {
  if (active !== ws || ws.readyState !== WebSocket.OPEN) return;
  encodedWindow++;
  // Never leave a slow browser with broken H.264 references after a frame drop.
  if (ws.getBufferedAmount() > 2 * 1024 * 1024) {
    health.droppedFrames++;
    ws.close(1013, "Video receiver is too slow; reconnect");
    return;
  }
  const packet = Buffer.allocUnsafe(FRAME_META_HEADER_BYTES + data.length);
  writeFrameMetaHeader(packet, { isKey, pts, serverTsMs: epochNowMs() });
  data.copy(packet, FRAME_META_HEADER_BYTES);
  if (ws.send(packet) === 0) ws.close(1013, "Video send failed");
}
function session(ws: Client, width: number, height: number) {
  health.width = width; health.height = height;
  ws.send(JSON.stringify({ type: "video-session", size: { width, height } }));
}
function fail(ws: Client, error: unknown) {
  if (active !== ws) return;
  health.error = error instanceof Error ? error.message : String(error);
  console.error(health.error);
  ws.send(JSON.stringify({ ok: false, error: health.error }));
  ws.close(1011, "Capture pipeline failed; see health");
}

async function startPipeline(ws: Client) {
  if (active) active.close(1000, "Switching comparison backend");
  active = null;
  await stopPipeline();
  if (ws.readyState !== WebSocket.OPEN) return;
  active = ws;
  Object.assign(health, { backend: ws.data.backend, clients: 1, droppedFrames: 0, error: null, sourceFps: 0, encodedFps: 0 });
  sourceWindow = encodedWindow = 0; previousTick = performance.now();
  const abort = new AbortController();
  activeAbort = abort;
  closePipeline = async () => { abort.abort(); };
  try {
    if (ws.data.backend === "scrcpy") {
      const capture = await startScrcpy({ serial, maxSize, maxFps: fps, bitRate, signal: abort.signal });
      if (active !== ws || ws.readyState !== WebSocket.OPEN) { await capture.close(); return; }
      scrcpy = capture;
      closePipeline = async () => { abort.abort(); await capture.close(); };
      session(ws, capture.meta.width, capture.meta.height);
      let config: Buffer | null = null;
      void (async () => {
        while (!abort.signal.aborted) {
          const frame = await capture.readFrame();
          if (!frame) break;
          if (frame.type === "session") { config = null; session(ws, frame.width, frame.height); continue; }
          if (frame.isConfig) { config = frame.data; continue; }
          sourceWindow++;
          sendFrame(ws, frame.isKey && config ? Buffer.concat([config, frame.data]) : frame.data, frame.pts, frame.isKey);
        }
        if (!abort.signal.aborted) fail(ws, new Error("scrcpy stream ended"));
      })().catch((error) => { if (!abort.signal.aborted) fail(ws, error); });
    } else {
      const first = await grpc.screenshot({ maxSize, signal: abort.signal });
      if (active !== ws || ws.readyState !== WebSocket.OPEN) return;
      session(ws, first.width, first.height);
      const encoder = hostEncoder({ width: first.width, height: first.height, fps, bitRate,
        onFrame: (data, timestampUs) => sendFrame(ws, data, timestampUs, scanAU(data).isKey),
        onError: (error) => fail(ws, error),
      });
      closePipeline = async () => { abort.abort(); await encoder.close(); };
      const stream = grpc.streamScreenshots({ maxSize, signal: abort.signal,
        onFrame: (frame) => {
          sourceWindow++;
          if (frame.width !== first.width || frame.height !== first.height) {
            fail(ws, new Error("Capture dimensions changed; reconnect the experiment"));
            return;
          }
          if (!encoder.write(frame.rgba, frame.timestampUs)) health.droppedFrames++;
        },
        onError: (error) => { if (!abort.signal.aborted) fail(ws, error); },
        onEnd: () => { if (!abort.signal.aborted) fail(ws, new Error("Native capture stream ended")); },
      });
      closePipeline = async () => { abort.abort(); stream.cancel(); await encoder.close(); };
    }
  } catch (error) { if (!abort.signal.aborted) fail(ws, error); }
}

async function gesture(action: Gesture) {
  if (!active) throw new Error("Connect a viewer first");
  if (scrcpy) return dispatch(scrcpy.controlSocket, action, { width: health.width, height: health.height });
  if (action.type === "touch") {
    const point = { x: Math.round(action.x * (physicalSize.width - 1)), y: Math.round(action.y * (physicalSize.height - 1)) };
    // Retain a pressed pointer even if its RPC fails after dispatch. Teardown
    // releases it after in-flight input finishes, including abrupt disconnects.
    if (action.action !== "up") nativePointer = point;
    await grpc.sendMouse({ ...point, buttons: action.action === "up" ? 0 : 1 });
    if (action.action === "up") nativePointer = null;
    return;
  }
  const keys = { home: "GoHome", back: "GoBack", recents: "AppSwitch", power: "Power" };
  if (action.type in keys) return grpc.sendKey({ key: keys[action.type as keyof typeof keys], eventType: "keypress" });
  if (action.type === "text") return grpc.sendKey({ text: action.text });
  throw new Error("Experimental native controls support pointer, Home, Back, Recents, Power, and text only");
}

const origin = `http://127.0.0.1:${port}`;
const server = await (async () => {
try {
return Bun.serve<{ backend: Backend }>({
  hostname: "127.0.0.1", port, maxRequestBodySize: 16 * 1024,
  fetch(req, server) {
    const url = new URL(req.url);
    // Android's host-loopback alias may load the inert animation fixture only.
    if (req.method === "GET" && url.host === `10.0.2.2:${port}` && (url.pathname === "/motion" || url.pathname === "/motion.html")) return new Response(Bun.file(join(import.meta.dir, "motion.html")));
    if (url.host !== `127.0.0.1:${port}` || (req.headers.has("origin") && req.headers.get("origin") !== origin)) return Response.json({ ok: false, error: "Origin rejected" }, { status: 403 });
    if (req.method !== "GET") return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
    if (url.pathname === "/ws") {
      const backend = url.searchParams.get("backend");
      if (backend !== "native" && backend !== "scrcpy") return Response.json({ ok: false, error: "Unknown backend" }, { status: 400 });
      if (req.headers.get("origin") !== origin) return Response.json({ ok: false, error: "Origin required" }, { status: 403 });
      return server.upgrade(req, { data: { backend } }) ? undefined : new Response("Upgrade failed", { status: 400 });
    }
    if (url.pathname === "/health") return Response.json(health);
    if (url.pathname === "/") return new Response(Bun.file(join(import.meta.dir, "index.html")));
    if (url.pathname === "/motion" || url.pathname === "/motion.html") return new Response(Bun.file(join(import.meta.dir, "motion.html")));
    if (assets.has(url.pathname)) return new Response(assets.get(url.pathname), { headers: { "content-type": "text/javascript" } });
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    maxPayloadLength: 16 * 1024,
    open(ws) {
      if (acceptedClient?.readyState === WebSocket.OPEN) { ws.close(1013, "This experiment supports one viewer at a time"); return; }
      acceptedClient = ws;
      switching = switching.then(() => startPipeline(ws)).catch((error) => fail(ws, error));
    },
    close(ws) {
      if (acceptedClient === ws) acceptedClient = null;
      if (active !== ws) return;
      activeAbort?.abort();
      active = null; health.clients = 0;
      switching = switching.then(async () => { if (!active) await stopPipeline(); }).catch(console.error);
    },
    message(ws, raw) {
      if (active !== ws || typeof raw !== "string") return;
      try {
        const message = parseWsClientJson(raw);
        if (message.type === "clock-sync") { ws.send(JSON.stringify({ type: "clock-sync", clientTsMs: message.clientTsMs, serverTsMs: epochNowMs() })); return; }
        if (message.type === "reset-video") {
          if (scrcpy && performance.now() - lastReset > 500) { lastReset = performance.now(); scrcpy.controlSocket.write(resetVideoPacket()); }
          return;
        }
        if (pendingControls >= 128) throw new Error("Control queue is full");
        pendingControls++;
        controlQueue = controlQueue.then(async () => { if (active === ws) await gesture(message); })
          .catch((error) => { ws.send(JSON.stringify({ ok: false, error: String(error) })); })
          .finally(() => { pendingControls--; });
      } catch (error) { ws.send(JSON.stringify({ ok: false, error: String(error) })); }
    },
  },
});
} catch (error) { clearInterval(tick); await grpc.close(); throw error; }
})();
console.log(`Capture comparison: ${origin} (device ${serial}; max-size ${maxSize}; ${fps} fps)`);
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(tick);
  active?.close(1000, "Experiment stopped"); active = null;
  await switching; await stopPipeline(); await grpc.close();
  await server.stop(true);
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
