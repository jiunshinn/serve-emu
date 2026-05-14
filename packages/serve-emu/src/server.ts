import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startScrcpy, readFrame, type ScrcpySession } from "./scrcpy.ts";
import { dispatch, resetVideoPacket, type Gesture, type Screen } from "./input.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type ServerOpts = {
  serial: string;
  port: number;
  maxFps?: number;
  bitRate?: number;
  maxSize?: number;
};

type WsData = { id: number };

export async function startServer(opts: ServerOpts) {
  const session = await startScrcpy({
    serial: opts.serial,
    maxFps: opts.maxFps,
    bitRate: opts.bitRate,
    maxSize: opts.maxSize,
  });
  console.log(
    `scrcpy ready: ${session.meta.deviceName} • ${session.meta.codecId} • ${session.meta.width}×${session.meta.height}`,
  );

  const clients = new Set<{ send: (data: Buffer) => void }>();
  const screen: Screen = { width: session.meta.width, height: session.meta.height };
  // Cache the SPS+PPS bytes that scrcpy emits as a standalone "config" packet
  // and inline them in front of every keyframe so each WS message is a
  // self-contained Access Unit the browser can hand straight to WebCodecs.
  let cachedConfig: Buffer | null = null;

  (async () => {
    while (true) {
      const f = await readFrame(session.videoReader);
      if (!f) break;
      if (f.isConfig) {
        cachedConfig = f.data;
        continue;
      }
      const out = f.isKey && cachedConfig ? Buffer.concat([cachedConfig, f.data]) : f.data;
      for (const c of clients) c.send(out);
    }
  })();

  let nextId = 1;
  const server = Bun.serve<WsData>({
    port: opts.port,
    async fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/api") {
        return Response.json({
          serial: opts.serial,
          device: session.meta.deviceName,
          codec: session.meta.codecId,
          size: { width: session.meta.width, height: session.meta.height },
        });
      }

      if (url.pathname === "/ws") {
        const ok = srv.upgrade(req, { data: { id: nextId++ } });
        if (ok) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        const html = await readFile(join(__dirname, "ui", "index.html"), "utf8");
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        const handle = { send: (data: Buffer) => ws.send(data) };
        clients.add(handle);
        (ws.data as WsData & { handle?: typeof handle }).handle = handle;
        // Force scrcpy to emit a fresh keyframe so this client can start
        // decoding immediately (default GOP is 10s). cachedConfig will be
        // bundled into that keyframe automatically.
        session.controlSocket.write(resetVideoPacket());
      },
      message(ws, raw) {
        if (typeof raw !== "string") return;
        try {
          const msg = JSON.parse(raw) as Gesture;
          void dispatch(session.controlSocket, msg, screen);
          ws.send(JSON.stringify({ ok: true }));
        } catch (err) {
          ws.send(JSON.stringify({ ok: false, error: String(err) }));
        }
      },
      close(ws) {
        const handle = (ws.data as WsData & { handle?: { send: (b: Buffer) => void } }).handle;
        if (handle) clients.delete(handle);
      },
    },
  });

  const stop = () => {
    server.stop();
    session.close();
  };
  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });

  return { server, session, stop };
}

export type StartedServer = Awaited<ReturnType<typeof startServer>>;
export type { ScrcpySession };
