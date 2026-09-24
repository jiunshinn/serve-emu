// Test-only adapter: production Bun HTTP/WS handlers and built UI, deterministic
// scrcpy transport. No fixture endpoint is shipped in the package.
import { EventEmitter } from "node:events";
import { startServer, type ServerDependencies } from "../../src/server.ts";
import { ControlInputQueue } from "../../src/control-input-queue.ts";
import type { ScrcpySession } from "../../src/scrcpy.ts";
import type { AccessibilityNode, AccessibilitySnapshot } from "../../src/accessibility.ts";

const keyframe = Buffer.from(
  await Bun.file(new URL("red-frame.h264", import.meta.url)).arrayBuffer(),
);
const blueKeyframe = Buffer.from(
  await Bun.file(new URL("blue-frame.h264", import.meta.url)).arrayBuffer(),
);
const blueLargeKeyframe = Buffer.from(
  await Bun.file(new URL("blue-large-frame.h264", import.meta.url)).arrayBuffer(),
);
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
const openScrcpy = async (serial: string): Promise<ScrcpySession> => {
  let closed = false;
  let pts = 0n;
  const large = differentSizes && serial === "device-b";
  activeSessions.set(serial, (activeSessions.get(serial) ?? 0) + 1);
  return {
    transport: "scrcpy",
    serial,
    protocol: 4,
    meta: { deviceName: serial, codecId: "h264", width: large ? 128 : 64, height: large ? 96 : 64 },
    proc: new EventEmitter(),
    controlSocket: new EventEmitter(),
    async readFrame() {
      await Bun.sleep(100);
      if (closed) return null;
      pts += 100_000n;
      return {
        type: "frame",
        data: large ? blueLargeKeyframe : distinctColors && serial === "device-b" ? blueKeyframe : keyframe,
        pts,
        isKey: true,
        isConfig: false,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      const remaining = (activeSessions.get(serial) ?? 1) - 1;
      if (remaining > 0) activeSessions.set(serial, remaining);
      else activeSessions.delete(serial);
    },
  } as unknown as ScrcpySession;
};

const slowDecoder = `
globalThis.VideoDecoder = class {
  state = "unconfigured"; decodeQueueSize = 0;
  configure() { this.state = "configured"; }
  decode() { this.decodeQueueSize++; }
  close() { this.state = "closed"; this.decodeQueueSize = 0; }
};
`;
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
        }
        return Response.json({ ok: true });
      }
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
      if (url.pathname === "/ws" && url.searchParams.has("serial"))
        (url.searchParams.get("control") === "1" ? controlRequests : previewRequests).push(url.searchParams.get("serial")!);
      if (
        url.pathname.startsWith("/assets/stream-worker-") &&
        url.searchParams.has("slow")
      ) {
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
  { serial: "device-a", port: 33117 },
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
process.on("SIGTERM", () => void started.stop().then(() => process.exit(0)));
process.on("SIGINT", () => void started.stop().then(() => process.exit(0)));
