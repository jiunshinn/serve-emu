// Test-only adapter: production Bun HTTP/WS handlers and built UI, deterministic
// scrcpy transport. No fixture endpoint is shipped in the package.
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { startServer, type ServerDependencies } from "../../src/server.ts";
import { ControlInputQueue } from "../../src/control-input-queue.ts";
import { FramedReader, readFrame, type ScrcpySession } from "../../src/scrcpy.ts";
import type { AccessibilityNode, AccessibilitySnapshot } from "../../src/accessibility.ts";
import {
  DEFAULT_ENCODER_OPTIONS,
  FakeEncoder,
  loadGop,
  type EncoderOptions,
} from "./fake-encoder.ts";

const port = Number(process.env.SERVE_EMU_FIXTURE_PORT ?? 33117);
const token = process.env.SERVE_EMU_FIXTURE_TOKEN || undefined;
const benchmark = process.env.SERVE_EMU_FIXTURE_BENCHMARK === "1";
const gop = loadGop(
  Buffer.from(await Bun.file(new URL("gop-red-green.h264", import.meta.url)).arrayBuffer()),
);
if (benchmark) {
  // An Annex-B filler NAL makes the fixture exercise transport at roughly
  // 8 Mbps and 30 fps while keeping its tiny, repeatable H.264 picture.
  const filler = Buffer.alloc(32 * 1024, 0xff);
  filler.set([0, 0, 0, 1, 12], 0);
  filler[filler.length - 1] = 0x80;
  gop.idr = Buffer.concat([gop.idr, filler]);
  gop.deltas = gop.deltas.map((delta) => Buffer.concat([delta, filler]));
}
// Single-IDR GOPs: the encoder repeats the key frame, so each device keeps
// one solid color.
const loadFrame = async (name: string) =>
  loadGop(Buffer.from(await Bun.file(new URL(name, import.meta.url)).arrayBuffer()));
const blueGop = await loadFrame("blue-frame.h264");
const blueLargeGop = await loadFrame("blue-large-frame.h264");
let encoderOptions: EncoderOptions = { ...DEFAULT_ENCODER_OPTIONS };
const encoders = new Map<string, FakeEncoder>();
let rejectInput = false;
let rejectSerials = new Set<string>();
let distinctColors = false;
let differentSizes = false;
let extraDevices = false;
let accessibilityMode: "normal" | "missing" | "ambiguous" = "normal";
const accessibilityLoads: string[] = [];
const activeSessions = new Map<string, number>();
const previewRequests: string[] = [];
const controlRequests: string[] = [];
const packets: {
  serial: string;
  type: number;
  action: number;
  pointerId: string | null;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  keycode: number | null;
  text: string | null;
}[] = [];
const sessions = new Map<string, ControlInputQueue>();
const displaySize = (serial: string) => differentSizes && serial === "device-b"
  ? { width: 1280, height: 960 }
  : { width: 640, height: 640 };
const accessibilitySnapshot = (serial: string): AccessibilitySnapshot => {
  const { width, height } = displaySize(serial);
  const button = (id: string, text: string, resourceId: string, x: number, y: number): AccessibilityNode => ({
    id,
    text,
    contentDescription: text,
    resourceId: resourceId ? `com.qa:id/${resourceId}` : "",
    className: "android.widget.Button",
    packageName: "com.qa",
    clickable: true,
    enabled: true,
    bounds: {
      left: width * (x - 0.125), top: height * (y - 0.125),
      right: width * (x + 0.125), bottom: height * (y + 0.125),
    },
  });
  const target = serial === "device-b";
  const search = button("1", "Search", "nav_search", target ? 0.75 : 0.25, target ? 0.25 : 0.75);
  const nodes: AccessibilityNode[] = [
    {
      id: "0", text: "", contentDescription: "", resourceId: "com.qa:id/root",
      className: "android.widget.FrameLayout", packageName: "com.qa", clickable: false, enabled: true,
      bounds: { left: 0, top: 0, right: width, bottom: height },
    },
    ...(target && accessibilityMode === "missing" ? [] : [search]),
    button("2", "Search", "search_content", target ? 0.25 : 0.75, target ? 0.25 : 0.75),
    button("3", "Home", "", target ? 0.25 : 0.75, target ? 0.75 : 0.25),
    ...(target && accessibilityMode === "ambiguous" ? [button("4", "Search", "nav_search", 0.75, 0.75)] : []),
  ];
  return { ok: true, capturedAt: new Date().toISOString(), nodes };
};
// The video stream is v4-framed bytes from FakeEncoder, read by the
// production FramedReader/readFrame, as for a real scrcpy server.
const openScrcpy = async (serial: string): Promise<ScrcpySession> => {
  encoders.get(serial)?.stop();
  const large = differentSizes && serial === "device-b";
  const frames = large ? blueLargeGop : distinctColors && serial === "device-b" ? blueGop : gop;
  const encoder = new FakeEncoder(frames, { width: large ? 128 : 64, height: large ? 96 : 64 }, benchmark ? 33 : 100);
  activeSessions.set(serial, (activeSessions.get(serial) ?? 0) + 1);
  let closed = false;
  encoder.options = { ...encoderOptions };
  encoders.set(serial, encoder);
  const reader = new FramedReader(encoder.socket as unknown as Socket);
  encoder.start();
  return {
    transport: "scrcpy",
    serial,
    protocol: 4,
    meta: { deviceName: serial, codecId: "h264", width: large ? 128 : 64, height: large ? 96 : 64 },
    proc: new EventEmitter(),
    controlSocket: new EventEmitter(),
    readFrame: () => readFrame(reader, 4),
    async close() {
      encoder.stop();
      if (closed) return;
      closed = true;
      const remaining = (activeSessions.get(serial) ?? 1) - 1;
      if (remaining > 0) activeSessions.set(serial, remaining);
      else activeSessions.delete(serial);
    },
  } as unknown as ScrcpySession;
};

// Never outputs, so the decode queue only grows. Each key chunk it is asked
// to decode is reported to /__test/decoded, so a test can tell whether the
// key frame that ends a recovery was decoded or dropped.
const slowDecoder = `
globalThis.VideoDecoder = class {
  state = "unconfigured"; decodeQueueSize = 0;
  configure() { this.state = "configured"; }
  decode(chunk) {
    this.decodeQueueSize++;
    if (chunk && chunk.type === "key") fetch("/__test/decoded", { method: "POST" }).catch(() => {});
  }
  close() { this.state = "closed"; this.decodeQueueSize = 0; }
};
`;
let decodedKeyframes = 0;
const serve: ServerDependencies["serve"] = ((options: any) => {
  const productionFetch = options.fetch;
  return Bun.serve({
    ...options,
    async fetch(req: Request, server: any) {
      const url = new URL(req.url);
      if (url.pathname === "/__test/control" && req.method === "POST") {
        const body = (await req.json()) as {
          reject?: boolean;
          clear?: boolean;
          encoder?: Partial<EncoderOptions>;
          distinctColors?: boolean;
          differentSizes?: boolean;
          rejectSerials?: string[];
          extraDevices?: boolean;
          accessibilityMode?: "normal" | "missing" | "ambiguous";
        };
        rejectInput = body.reject === true;
        rejectSerials = new Set(body.rejectSerials ?? []);
        distinctColors = body.distinctColors === true;
        differentSizes = body.differentSizes === true;
        extraDevices = body.extraDevices === true;
        accessibilityMode = body.accessibilityMode ?? "normal";
        if (body.clear) {
          packets.length = 0;
          previewRequests.length = 0;
          controlRequests.length = 0;
          accessibilityLoads.length = 0;
          decodedKeyframes = 0;
          encoderOptions = { ...DEFAULT_ENCODER_OPTIONS };
        }
        if (body.encoder) encoderOptions = { ...encoderOptions, ...body.encoder };
        for (const encoder of encoders.values()) encoder.options = { ...encoderOptions };
        return Response.json({ ok: true });
      }
      if (url.pathname === "/__test/decoded") {
        if (req.method === "POST") decodedKeyframes++;
        return Response.json({ keyframes: decodedKeyframes });
      }
      if (url.pathname === "/__test/encoder")
        return Response.json(
          Object.fromEntries([...encoders].map(([serial, encoder]) => [serial, encoder.stats])),
        );
      if (url.pathname === "/__test/packets")
        return Response.json({
          packets,
          queues: Object.fromEntries(
            [...sessions].map(([serial, q]) => [serial, q.snapshot()]),
          ),
        });
      if (url.pathname === "/__test/streams")
        return Response.json({
          activeSessions: Object.fromEntries(activeSessions),
          previewRequests,
          controlRequests,
          accessibilityLoads,
        });
      const deviceSocket = /^\/d\/([^/]+)\/ws$/.exec(url.pathname);
      if (deviceSocket)
        (url.searchParams.get("control") === "1" ? controlRequests : previewRequests)
          .push(decodeURIComponent(deviceSocket[1]!));
      // The test marks the stream worker's script (found by its Worker name,
      // not its chunk name) with ?slow.
      if (url.pathname.startsWith("/assets/") && url.searchParams.has("slow")) {
        const file = Bun.file(
          new URL(`../../dist/ui${url.pathname}`, import.meta.url),
        );
        return new Response(slowDecoder + (await file.text()), {
          headers: { "Content-Type": "text/javascript" },
        });
      }
      return productionFetch(req, server);
    },
  });
}) as typeof Bun.serve;

const started = await startServer(
  { serial: "device-a", port, token, maxDevices: 16, idleDeviceMs: 300 },
  {
    openScrcpy,
    serve,
    listDevices: async () => [
      { serial: "device-a", state: "device" },
      { serial: "device-b", state: "device" },
      { serial: "device-offline", state: "offline" },
      { serial: "device-unauthorized", state: "unauthorized" },
      ...(extraDevices ? Array.from({ length: 7 }, (_, index) => ({ serial: `device-extra-${index + 1}`, state: "device" })) : []),
    ],
    listAvds: async () => ["Stopped_Pixel"],
    listRunningAvds: async () => [],
    loadAccessibility: async (serial) => {
      accessibilityLoads.push(serial);
      return accessibilitySnapshot(serial);
    },
    loadDisplaySize: async (serial) => displaySize(serial),
    createInputQueue(session) {
      const queue = new ControlInputQueue({
        writer: {
          async write(packet) {
            if (packet[0] === 17) encoders.get(session.serial)?.requestReset();
            if ((rejectInput || rejectSerials.has(session.serial)) && packet[0] !== 17)
              throw new Error("injected device input failure");
            packets.push({
              serial: session.serial,
              type: packet[0]!,
              action: packet[1] ?? -1,
              pointerId:
                packet[0] === 2 ? packet.readBigUInt64BE(2).toString() : null,
              x: packet[0] === 2 ? packet.readInt32BE(10) : null,
              y: packet[0] === 2 ? packet.readInt32BE(14) : null,
              width: packet[0] === 2 ? packet.readUInt16BE(18) : null,
              height: packet[0] === 2 ? packet.readUInt16BE(20) : null,
              keycode: packet[0] === 0 ? packet.readInt32BE(2) : null,
              text: packet[0] === 1 ? packet.toString("utf8", 5, 5 + packet.readUInt32BE(1)) : null,
            });
          },
        },
      });
      sessions.set(session.serial, queue);
      return queue;
    },
  },
);
if (benchmark) process.send?.(started.server.port);
process.on("SIGTERM", () => void started.stop().then(() => process.exit(0)));
process.on("SIGINT", () => void started.stop().then(() => process.exit(0)));
