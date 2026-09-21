// Test-only adapter: production Bun HTTP/WS handlers and built UI, deterministic
// scrcpy transport. No fixture endpoint is shipped in the package.
import { EventEmitter } from "node:events";
import { startServer, type ServerDependencies } from "../../src/server.ts";
import { ControlInputQueue } from "../../src/control-input-queue.ts";
import type { ScrcpySession } from "../../src/scrcpy.ts";

const keyframe = Buffer.from(
  await Bun.file(new URL("red-frame.h264", import.meta.url)).arrayBuffer(),
);
let rejectInput = false;
const packets: {
  serial: string;
  type: number;
  action: number;
  pointerId: string | null;
}[] = [];
const sessions = new Map<string, ControlInputQueue>();
const openScrcpy = async (serial: string): Promise<ScrcpySession> => {
  let closed = false;
  let pts = 0n;
  return {
    transport: "scrcpy",
    serial,
    protocol: 4,
    meta: { deviceName: serial, codecId: "h264", width: 64, height: 64 },
    proc: new EventEmitter(),
    controlSocket: new EventEmitter(),
    async readFrame() {
      await Bun.sleep(100);
      if (closed) return null;
      pts += 100_000n;
      return {
        type: "frame",
        data: keyframe,
        pts,
        isKey: true,
        isConfig: false,
      };
    },
    async close() {
      closed = true;
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
        };
        rejectInput = body.reject === true;
        if (body.clear) packets.length = 0;
        return Response.json({ ok: true });
      }
      if (url.pathname === "/__test/packets")
        return Response.json({
          packets,
          queues: Object.fromEntries(
            [...sessions].map(([serial, q]) => [serial, q.snapshot()]),
          ),
        });
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
    listDevices: async () =>
      ["device-a", "device-b"].map((serial) => ({ serial, state: "device" })),
    listAvds: async () => [],
    listRunningAvds: async () => [],
    createInputQueue(session) {
      const queue = new ControlInputQueue({
        writer: {
          async write(packet) {
            if (rejectInput && packet[0] !== 17)
              throw new Error("injected device input failure");
            packets.push({
              serial: session.serial,
              type: packet[0]!,
              action: packet[1] ?? -1,
              pointerId:
                packet[0] === 2 ? packet.readBigUInt64BE(2).toString() : null,
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
