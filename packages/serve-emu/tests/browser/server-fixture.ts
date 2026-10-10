// Test-only adapter: production Bun HTTP/WS handlers and built UI, deterministic
// scrcpy transport. No fixture endpoint is shipped in the package.
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { startServer, type ServerDependencies } from "../../src/server.ts";
import { ControlInputQueue } from "../../src/control-input-queue.ts";
import { FramedReader, readFrame, type ScrcpySession } from "../../src/scrcpy.ts";
import {
  DEFAULT_ENCODER_OPTIONS,
  FakeEncoder,
  loadGop,
  type EncoderOptions,
} from "./fake-encoder.ts";

const port = Number(process.env.SERVE_EMU_FIXTURE_PORT ?? 33117);
const token = process.env.SERVE_EMU_FIXTURE_TOKEN || undefined;
const gop = loadGop(
  Buffer.from(await Bun.file(new URL("gop-red-green.h264", import.meta.url)).arrayBuffer()),
);
let encoderOptions: EncoderOptions = { ...DEFAULT_ENCODER_OPTIONS };
const encoders = new Map<string, FakeEncoder>();
let rejectInput = false;
const packets: {
  serial: string;
  type: number;
  action: number;
  pointerId: string | null;
}[] = [];
const sessions = new Map<string, ControlInputQueue>();
// The video stream is v4-framed bytes from FakeEncoder, read by the
// production FramedReader/readFrame, as for a real scrcpy server.
const openScrcpy = async (serial: string): Promise<ScrcpySession> => {
  encoders.get(serial)?.stop();
  const encoder = new FakeEncoder(gop, { width: 64, height: 64 });
  encoder.options = { ...encoderOptions };
  encoders.set(serial, encoder);
  const reader = new FramedReader(encoder.socket as unknown as Socket);
  encoder.start();
  return {
    transport: "scrcpy",
    serial,
    protocol: 4,
    meta: { deviceName: serial, codecId: "h264", width: 64, height: 64 },
    proc: new EventEmitter(),
    controlSocket: new EventEmitter(),
    readFrame: () => readFrame(reader, 4),
    async close() {
      encoder.stop();
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
          encoder?: Partial<EncoderOptions>;
        };
        rejectInput = body.reject === true;
        if (body.clear) {
          packets.length = 0;
          encoderOptions = { ...DEFAULT_ENCODER_OPTIONS };
        }
        if (body.encoder) encoderOptions = { ...encoderOptions, ...body.encoder };
        for (const encoder of encoders.values()) encoder.options = { ...encoderOptions };
        return Response.json({ ok: true });
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
  { serial: "device-a", port, token },
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
            if (packet[0] === 17) encoders.get(session.serial)?.requestReset();
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
