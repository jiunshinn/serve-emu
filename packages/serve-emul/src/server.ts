import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { execText } from "./exec.ts";
import {
  getFontScale,
  getNetworkStatus,
  getNightMode,
  getUserRotation,
  listAllDevices,
  screencapPng,
  setFontScale,
  setNetworkEnabled,
  setNightMode,
  setUserRotation,
  type NightMode,
  type OrientationMode,
} from "./adb.ts";
import {
  findAccessibilityNode,
  getAccessibilitySnapshot,
  parseAccessibilitySelector,
  type AccessibilitySnapshot,
} from "./accessibility.ts";
import {
  clearAppData,
  forceStopApp,
  grantPermission,
  importMediaFile,
  installApk,
  launchApp,
} from "./app-management.ts";
import { getForegroundApp } from "./app-info.ts";
import { FrameStatWindow } from "./frame-stat-window.ts";
import {
  FRAME_META_HEADER_BYTES,
  epochNowMs,
  writeFrameMetaHeader,
} from "./shared/frame-meta.ts";
import {
  startScrcpy,
  type ScrcpySession,
  type ScrcpyErrorCode,
  ScrcpyStreamError,
} from "./scrcpy.ts";
import {
  listAvds,
  listRunningAvds,
  startEmulator,
  stopEmulator,
} from "./emulator.ts";
import {
  dispatch,
  parseGesture,
  resetVideoPacket,
  type Gesture,
  type Screen,
} from "./input.ts";
import {
  parseGeoFix,
  setEmulatorLocationAsync,
  type GeoFix,
} from "./location.ts";
import { parseRoutePlaybackRequest, RoutePlayback } from "./route-playback.ts";
import { SessionRecorder } from "./session-recorder.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "..", "dist", "ui");

export type ServerOpts = {
  serial: string;
  port: number;
  /** Address to bind. Defaults to loopback (127.0.0.1). */
  host?: string;
  /**
   * Shared secret required on every request. When empty/undefined, auth is
   * disabled (intended only for loopback binds). Presented via bearer token,
   * the `semu_session` cookie, or a `token` query param.
   */
  token?: string;
  maxFps?: number;
  bitRate?: number;
  maxSize?: number;
  keyFrameInterval?: number;
  repeatFrameMs?: number;
};

export const DEFAULT_HOST = "127.0.0.1";
const SESSION_COOKIE = "semu_session";

/** Constant-time string compare that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = part.slice(idx + 1).trim();
  }
  return out;
}

type SessionStatus = "streaming" | "stopped" | "error";
type GridDeviceKind = "physical" | "emulator" | "avd";

type GridDevice = {
  id: string;
  kind: GridDeviceKind;
  serial: string | null;
  avd: string | null;
  name: string;
  state: string;
  current: boolean;
  canSelect: boolean;
  canStart: boolean;
  canStop: boolean;
};

type DeviceGridResponse = {
  ok: true;
  currentSerial: string;
  sessionStatus: SessionStatus;
  devices: GridDevice[];
};

type WsData = { id: number; frameMeta: boolean; handle?: Client };

type Client = {
  id: number;
  ws: ServerWebSocket<WsData>;
  frameMeta: boolean;
  sentFrames: number;
  droppedFrames: number;
  backpressureEvents: number;
  awaitingKeyFrame: boolean;
};

const MAX_WS_MESSAGE_BYTES = 16 * 1024;
const DROP_FRAME_BUFFERED_BYTES = 512 * 1024;
const CLOSE_CLIENT_BUFFERED_BYTES = 16 * 1024 * 1024;
// Rolling window used for /health frame timing stats: 240 frames ≈ 4s at 60fps.
const FRAME_STAT_WINDOW = 240;
const VIDEO_RESET_COOLDOWN_MS = 500;
const FIRST_FRAME_RESET_MS = 5000;
const AWAITING_KEYFRAME_RESET_MS = 2500;
const MAX_JSON_BODY_BYTES = 8 * 1024;
const MAX_ROUTE_BODY_BYTES = 2 * 1024 * 1024;
const MAX_LOGCAT_QUERY_BYTES = 200;

export async function startServer(opts: ServerOpts) {
  const openScrcpy = (serial: string) =>
    startScrcpy({
      serial,
      maxFps: opts.maxFps,
      bitRate: opts.bitRate,
      maxSize: opts.maxSize,
      keyFrameInterval: opts.keyFrameInterval,
      repeatFrameMs: opts.repeatFrameMs,
    });

  const host = opts.host ?? DEFAULT_HOST;
  const authToken = opts.token && opts.token.length > 0 ? opts.token : null;

  /** Token presented by the request, from bearer header, cookie, or query. */
  const presentedToken = (req: Request, url: URL): string | null => {
    const authorization = req.headers.get("authorization");
    if (authorization && authorization.startsWith("Bearer ")) {
      return authorization.slice("Bearer ".length).trim();
    }
    const cookie = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
    if (cookie) return cookie;
    return url.searchParams.get("token");
  };

  const tokenValid = (req: Request, url: URL): boolean => {
    if (!authToken) return true;
    const presented = presentedToken(req, url);
    return presented !== null && safeEqual(presented, authToken);
  };

  /**
   * Same-origin guard for state-changing requests and the WebSocket upgrade.
   * A missing Origin means a non-browser client (CLI/agent), which is gated by
   * the token check instead. A present Origin must match the request Host.
   */
  const originAllowed = (req: Request): boolean => {
    const origin = req.headers.get("origin");
    if (!origin) return true;
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    return originHost === req.headers.get("host");
  };

  let currentSerial = opts.serial;
  let session: ScrcpySession = await openScrcpy(currentSerial);
  console.log(
    `scrcpy ready: ${session.meta.deviceName} • ${session.meta.codecId} • ${session.meta.width}×${session.meta.height}`,
  );

  const clients = new Set<Client>();
  const screen: Screen = {
    width: session.meta.width,
    height: session.meta.height,
  };
  let startedMs = Date.now();
  let startedAt = new Date(startedMs).toISOString();
  let status: SessionStatus = "streaming";
  let lastError: string | null = null;
  let lastErrorCode: string | null = null;
  let lastErrorMeta: Record<string, string | number> | null = null;
  let stoppedAt: string | null = null;
  let stopRequested = false;
  let frameCount = 0;
  let configPacketCount = 0;
  let lastFrameMs = 0;
  let totalDroppedFrames = 0;
  let totalBackpressureEvents = 0;
  let sourceFps = 0;
  let lastFpsFrameCount = 0;
  const frameStats = new FrameStatWindow(FRAME_STAT_WINDOW);
  let videoResetRequests = 0;
  let lastVideoResetAt: string | null = null;
  let lastVideoResetReason: string | null = null;
  let lastVideoResetMs = 0;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let lastLocation: (GeoFix & { appliedAt: string }) | null = null;
  const createRoutePlayback = () =>
    new RoutePlayback({
      applyLocation: (fix) => setEmulatorLocationAsync(currentSerial, fix),
      onLocation: (fix) => {
        lastLocation = fix;
      },
    });
  let sessionRecorder = new SessionRecorder();
  let routePlayback = createRoutePlayback();
  let sessionGeneration = 0;
  let accessibilitySnapshotCache: {
    snapshot: AccessibilitySnapshot;
    expiresMs: number;
  } | null = null;
  let accessibilitySnapshotInFlight: Promise<AccessibilitySnapshot> | null =
    null;

  const health = () => ({
    ok: status === "streaming",
    status,
    serial: currentSerial,
    device: session.meta.deviceName,
    codec: session.meta.codecId,
    size: { width: screen.width, height: screen.height },
    clients: clients.size,
    frames: frameCount,
    sourceFps,
    frameStats: frameStats.summary(),
    configPackets: configPacketCount,
    droppedFrames: totalDroppedFrames,
    backpressureEvents: totalBackpressureEvents,
    videoResetRequests,
    lastVideoResetAt,
    lastVideoResetReason,
    location: lastLocation,
    route: routePlayback.snapshot(),
    session: sessionRecorder.snapshot(),
    clientsDetail: Array.from(clients, (client) => ({
      id: client.id,
      frameMeta: client.frameMeta,
      sentFrames: client.sentFrames,
      droppedFrames: client.droppedFrames,
      backpressureEvents: client.backpressureEvents,
      bufferedBytes: client.ws.getBufferedAmount(),
      awaitingKeyFrame: client.awaitingKeyFrame,
    })),
    startedAt,
    stoppedAt,
    lastFrameAt: lastFrameMs > 0 ? new Date(lastFrameMs).toISOString() : null,
    lastError,
    lastErrorCode,
    lastErrorMeta,
  });

  const closeClients = (code: number, reason: string) => {
    for (const c of clients) {
      try {
        c.ws.close(code, reason);
      } catch {}
    }
    clients.clear();
  };

  const deviceGrid = async (): Promise<DeviceGridResponse> => {
    const [adbDevices, runningAvds, avds] = await Promise.all([
      listAllDevices(),
      listRunningAvds(),
      listAvds(),
    ]);
    const runningBySerial = new Map(
      runningAvds.map((running) => [running.serial, running]),
    );
    const runningByAvd = new Map(
      runningAvds.map((running) => [running.avd, running]),
    );
    const rows: GridDevice[] = adbDevices.map((device) => {
      const running = runningBySerial.get(device.serial);
      const isEmulator = /^emulator-\d+$/.test(device.serial);
      return {
        id: device.serial,
        kind: isEmulator ? "emulator" : "physical",
        serial: device.serial,
        avd: running?.avd ?? null,
        name: running?.avd ?? device.serial,
        state: device.state,
        current: device.serial === currentSerial,
        canSelect: device.state === "device",
        canStart: false,
        canStop: isEmulator,
      };
    });

    const knownAvdSerials = new Set(
      runningAvds.map((running) => running.serial),
    );
    for (const avd of avds) {
      const running = runningByAvd.get(avd);
      if (running && knownAvdSerials.has(running.serial)) continue;
      rows.push({
        id: `avd:${avd}`,
        kind: "avd",
        serial: running?.serial ?? null,
        avd,
        name: avd,
        state: running?.state ?? "stopped",
        current: running?.serial === currentSerial,
        canSelect: running?.state === "device",
        canStart: !running,
        canStop: Boolean(running),
      });
    }

    return { ok: true, currentSerial, sessionStatus: status, devices: rows };
  };

  const markTerminal = (
    nextStatus: Exclude<SessionStatus, "streaming">,
    reason: string,
    generation = sessionGeneration,
    detail?: { code?: string; meta?: Record<string, string | number> | null },
  ) => {
    if (generation !== sessionGeneration) return;
    if (status !== "streaming") return;
    status = nextStatus;
    lastError = reason;
    lastErrorCode = detail?.code ?? null;
    lastErrorMeta = detail?.meta ?? null;
    stoppedAt = new Date().toISOString();
    if (watchdog) clearInterval(watchdog);
    routePlayback.close();
    session.close();
    closeClients(nextStatus === "error" ? 1011 : 1000, reason);
  };

  const sendJson = (ws: ServerWebSocket<WsData>, value: unknown) => {
    try {
      ws.send(JSON.stringify(value));
    } catch {}
  };

  const withFrameMeta = (
    frameData: Buffer,
    frame: { pts: bigint; isKey: boolean },
    config: Buffer | null,
  ): Buffer => {
    const configBytes = config?.length ?? 0;
    const out = Buffer.allocUnsafe(
      FRAME_META_HEADER_BYTES + configBytes + frameData.length,
    );
    writeFrameMetaHeader(out, {
      isKey: frame.isKey,
      pts: frame.pts,
      serverTsMs: epochNowMs(),
    });
    if (config) config.copy(out, FRAME_META_HEADER_BYTES);
    frameData.copy(out, FRAME_META_HEADER_BYTES + configBytes);
    return out;
  };

  const withConfig = (frameData: Buffer, config: Buffer | null): Buffer => {
    if (!config) return frameData;
    const out = Buffer.allocUnsafe(config.length + frameData.length);
    config.copy(out, 0);
    frameData.copy(out, config.length);
    return out;
  };

  const wantsAck = (value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return true;
    return (value as Record<string, unknown>).ack !== false;
  };

  const isResetVideoRequest = (value: unknown) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "reset-video";

  const readJsonBody = async (
    req: Request,
    maxBytes = MAX_JSON_BODY_BYTES,
  ): Promise<unknown> => {
    const contentLength = Number(req.headers.get("content-length") ?? "0");
    if (contentLength > maxBytes) throw new Error("request body too large");
    return req.json();
  };

  const shouldRecord = (value: unknown) =>
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).record !== false;

  const readAccessibilitySnapshot = async (cacheMs = 2_500) => {
    const now = Date.now();
    if (
      accessibilitySnapshotCache &&
      accessibilitySnapshotCache.expiresMs > now
    ) {
      return accessibilitySnapshotCache.snapshot;
    }
    if (accessibilitySnapshotInFlight) return accessibilitySnapshotInFlight;
    accessibilitySnapshotInFlight = getAccessibilitySnapshot(currentSerial)
      .then((snapshot) => {
        accessibilitySnapshotCache = {
          snapshot,
          expiresMs: Date.now() + cacheMs,
        };
        return snapshot;
      })
      .finally(() => {
        accessibilitySnapshotInFlight = null;
      });
    return accessibilitySnapshotInFlight;
  };

  const dispatchGesture = async (
    gesture: Gesture,
    source: string,
    record = true,
  ) => {
    if (status !== "streaming") throw new Error(`session is ${status}`);
    await dispatch(session.controlSocket, gesture, screen);
    if (record) sessionRecorder.recordGesture(gesture, source);
  };

  const applyLocation = async (fix: GeoFix, source: string, record = true) => {
    routePlayback.stop();
    await setEmulatorLocationAsync(currentSerial, fix);
    lastLocation = { ...fix, appliedAt: new Date().toISOString() };
    if (record) sessionRecorder.recordLocation(fix, source);
    return lastLocation;
  };

  const resolvePackagePids = async (
    packageName: string,
  ): Promise<Set<string>> => {
    if (!/^[A-Za-z0-9_.:-]+$/.test(packageName)) return new Set();
    const r = await execText(
      "adb",
      ["-s", currentSerial, "shell", "pidof", packageName],
      {
        timeout: 2_000,
      },
    );
    if (r.status !== 0) return new Set();
    return new Set(r.stdout.trim().split(/\s+/).filter(Boolean));
  };

  const logcatStream = (url: URL) => {
    const packageName = (url.searchParams.get("package") ?? "")
      .trim()
      .slice(0, MAX_LOGCAT_QUERY_BYTES);
    const search = (url.searchParams.get("search") ?? "")
      .trim()
      .slice(0, MAX_LOGCAT_QUERY_BYTES)
      .toLowerCase();
    const proc = spawn("adb", [
      "-s",
      currentSerial,
      "logcat",
      "-v",
      "threadtime",
    ]);
    const encoder = new TextEncoder();
    let pidSet = new Set<string>();
    let pidTimer: ReturnType<typeof setInterval> | null = null;
    let buffer = "";

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, value: unknown) => {
          try {
            controller.enqueue(
              encoder.encode(
                `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`,
              ),
            );
          } catch {}
        };
        const matches = (line: string) => {
          if (search && !line.toLowerCase().includes(search)) return false;
          if (!packageName) return true;
          const parts = line.trim().split(/\s+/, 5);
          const pid = parts[2];
          return (pid && pidSet.has(pid)) || line.includes(packageName);
        };
        const consume = (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line && matches(line))
              send("log", { line, at: new Date().toISOString() });
          }
        };

        send("ready", {
          serial: currentSerial,
          package: packageName || null,
          pids: Array.from(pidSet),
          search: search || null,
        });
        if (packageName) {
          void resolvePackagePids(packageName).then((set) => {
            pidSet = set;
          });
          pidTimer = setInterval(() => {
            void resolvePackagePids(packageName).then((set) => {
              pidSet = set;
            });
          }, 5_000);
        }
        proc.stdout.on("data", consume);
        proc.stderr.on("data", (chunk) => {
          const text = chunk.toString("utf8").trim();
          if (text) send("error", { line: text, at: new Date().toISOString() });
        });
        proc.once("exit", (code, signal) => {
          send("close", { code, signal });
          try {
            controller.close();
          } catch {}
          if (pidTimer) clearInterval(pidTimer);
        });
        proc.once("error", (err) => {
          send("error", { line: err.message, at: new Date().toISOString() });
          try {
            controller.close();
          } catch {}
          if (pidTimer) clearInterval(pidTimer);
        });
      },
      cancel() {
        if (pidTimer) clearInterval(pidTimer);
        try {
          proc.kill("SIGTERM");
        } catch {}
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  };

  const gestureEndpoint = async (
    req: Request,
    type: Gesture["type"],
    source: string,
  ) => {
    try {
      const payload = await readJsonBody(req);
      const gesture = parseGesture(
        typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload)
          ? { ...payload, type }
          : payload,
      );
      await dispatchGesture(gesture, source, shouldRecord(payload));
      return Response.json({ ok: true });
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  };

  const keyEndpoint = async (req: Request) => {
    try {
      const payload = await readJsonBody(req);
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
      ) {
        throw new Error("key payload must be an object");
      }
      const key = (payload as Record<string, unknown>).key;
      const gesture =
        key === "back" || key === "home" || key === "recents" || key === "power"
          ? parseGesture({ type: key })
          : parseGesture({ ...payload, type: "key" });
      await dispatchGesture(gesture, "rest:key", shouldRecord(payload));
      return Response.json({ ok: true });
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  };

  const accessibilityTapEndpoint = async (req: Request) => {
    try {
      const payload = await readJsonBody(req);
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
      ) {
        throw new Error("accessibility tap payload must be an object");
      }
      const body = payload as Record<string, unknown>;
      const selector = parseAccessibilitySelector(body.selector ?? body);
      const snapshot = await readAccessibilitySnapshot(1_000);
      const node = findAccessibilityNode(snapshot.nodes, selector);
      const centerX = (node.bounds.left + node.bounds.right) / 2;
      const centerY = (node.bounds.top + node.bounds.bottom) / 2;
      const accessibilityWidth = Math.max(
        ...snapshot.nodes.map((n) => n.bounds.right),
        screen.width,
      );
      const accessibilityHeight = Math.max(
        ...snapshot.nodes.map((n) => n.bounds.bottom),
        screen.height,
      );
      const x = centerX / accessibilityWidth;
      const y = centerY / accessibilityHeight;
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        x > 1 ||
        y < 0 ||
        y > 1
      ) {
        throw new Error(
          "matched accessibility node is outside the current stream bounds",
        );
      }
      await dispatchGesture(
        {
          type: "tap",
          x,
          y,
        },
        "accessibility:tap",
        shouldRecord(payload),
      );
      return Response.json({ ok: true, node, capturedAt: snapshot.capturedAt });
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  };

  const appJsonEndpoint = async (
    req: Request,
    action: (payload: Record<string, unknown>) => unknown | Promise<unknown>,
  ) => {
    try {
      const payload = await readJsonBody(req);
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
      ) {
        throw new Error("payload must be an object");
      }
      const result = await action(payload as Record<string, unknown>);
      return Response.json(result);
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  };

  const installEndpoint = async (req: Request) => {
    try {
      const form = await req.formData();
      const file = form.get("apk");
      if (!(file instanceof File))
        throw new Error("multipart field apk must be a file");
      return Response.json(await installApk(currentSerial, file));
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  };

  const fileImportEndpoint = async (req: Request) => {
    try {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File))
        throw new Error("multipart field file must be a file");
      return Response.json(await importMediaFile(currentSerial, file));
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  };

  const requestVideoReset = (reason: string) => {
    const now = Date.now();
    if (now - lastVideoResetMs < VIDEO_RESET_COOLDOWN_MS) return;
    lastVideoResetMs = now;
    videoResetRequests++;
    lastVideoResetAt = new Date(now).toISOString();
    lastVideoResetReason = reason;
    try {
      session.controlSocket.write(resetVideoPacket());
    } catch {}
  };

  const dropUntilKeyFrame = (client: Client) => {
    client.droppedFrames++;
    totalDroppedFrames++;
    client.awaitingKeyFrame = true;
    requestVideoReset("client backpressure");
  };

  const sendFrame = (client: Client, data: Buffer, isKeyFrame: boolean) => {
    if (client.awaitingKeyFrame) {
      if (!isKeyFrame) {
        client.droppedFrames++;
        totalDroppedFrames++;
        return;
      }
      client.awaitingKeyFrame = false;
    }

    const buffered = client.ws.getBufferedAmount();
    if (buffered > CLOSE_CLIENT_BUFFERED_BYTES) {
      clients.delete(client);
      try {
        client.ws.close(1013, "client too slow");
      } catch {}
      return;
    }
    if (buffered > DROP_FRAME_BUFFERED_BYTES) {
      dropUntilKeyFrame(client);
      return;
    }
    const sent = client.ws.send(data);
    if (sent === -1) {
      client.backpressureEvents++;
      totalBackpressureEvents++;
      dropUntilKeyFrame(client);
      return;
    }
    if (sent === 0) {
      clients.delete(client);
      return;
    }
    client.sentFrames++;
  };
  // Cache the SPS+PPS bytes that scrcpy emits as a standalone "config" packet
  // and inline them in front of every keyframe so each WS message is a
  // self-contained Access Unit the browser can hand straight to WebCodecs.
  let cachedConfig: Buffer | null = null;

  const startFramePump = (activeSession: ScrcpySession, generation: number) => {
    cachedConfig = null;
    void (async () => {
      try {
        while (!stopRequested && generation === sessionGeneration) {
          const f = await activeSession.readFrame();
          if (generation !== sessionGeneration) break;
          if (!f) {
            if (!stopRequested)
              markTerminal("stopped", "scrcpy video stream ended", generation);
            break;
          }
          if (f.type === "session") {
            if (f.width > 0 && f.height > 0) {
              screen.width = f.width;
              screen.height = f.height;
              cachedConfig = null;
              for (const c of clients) {
                c.awaitingKeyFrame = true;
                sendJson(c.ws, {
                  type: "video-session",
                  size: { width: f.width, height: f.height },
                });
              }
              requestVideoReset(
                `video session resized to ${f.width}×${f.height}`,
              );
            }
            continue;
          }
          if (f.isConfig) {
            cachedConfig = f.data;
            configPacketCount++;
            continue;
          }
          frameCount++;
          lastFrameMs = Date.now();
          frameStats.record(f.data.length, f.isKey);
          const config = f.isKey ? cachedConfig : null;
          let rawOut: Buffer | null = null;
          let framedOut: Buffer | null = null;
          for (const c of clients) {
            if (c.awaitingKeyFrame && !f.isKey) {
              c.droppedFrames++;
              totalDroppedFrames++;
              continue;
            }
            const out = c.frameMeta
              ? (framedOut ??= withFrameMeta(f.data, f, config))
              : (rawOut ??= withConfig(f.data, config));
            sendFrame(c, out, f.isKey);
          }
        }
      } catch (err) {
        if (stopRequested) return;
        if (err instanceof ScrcpyStreamError) {
          markTerminal("error", err.message, generation, {
            code: err.code,
            meta: err.meta ?? null,
          });
        } else {
          markTerminal("error", String(err), generation);
        }
      }
    })();
  };

  const attachSessionHandlers = (
    activeSession: ScrcpySession,
    generation: number,
  ) => {
    activeSession.proc.once("exit", (code, signal) => {
      if (!stopRequested && status === "streaming") {
        markTerminal(
          "error",
          `scrcpy exited with code ${code ?? "null"} signal ${signal ?? "null"}`,
          generation,
        );
      }
    });
    activeSession.controlSocket.once("error", (err) => {
      if (!stopRequested && status === "streaming") {
        markTerminal(
          "error",
          `scrcpy control socket error: ${err.message}`,
          generation,
        );
      }
    });
  };

  const resetSessionStats = (nextSession: ScrcpySession) => {
    screen.width = nextSession.meta.width;
    screen.height = nextSession.meta.height;
    startedMs = Date.now();
    startedAt = new Date(startedMs).toISOString();
    status = "streaming";
    lastError = null;
    lastErrorCode = null;
    lastErrorMeta = null;
    stoppedAt = null;
    frameCount = 0;
    configPacketCount = 0;
    lastFrameMs = 0;
    totalDroppedFrames = 0;
    totalBackpressureEvents = 0;
    sourceFps = 0;
    lastFpsFrameCount = 0;
    frameStats.reset();
    videoResetRequests = 0;
    lastVideoResetAt = null;
    lastVideoResetReason = null;
    lastVideoResetMs = 0;
    lastLocation = null;
    sessionRecorder = new SessionRecorder();
    routePlayback.close();
    routePlayback = createRoutePlayback();
    accessibilitySnapshotCache = null;
    accessibilitySnapshotInFlight = null;
  };

  const switchSession = async (serial: string) => {
    if (serial === currentSerial && status === "streaming") {
      return {
        ok: true,
        serial: currentSerial,
        device: session.meta.deviceName,
      };
    }
    const device = (await listAllDevices()).find(
      (candidate) => candidate.serial === serial,
    );
    if (!device) throw new Error(`Unknown adb device "${serial}".`);
    if (device.state !== "device")
      throw new Error(`${serial} is ${device.state}, not ready.`);

    const nextSession = await openScrcpy(serial);
    const previousSession = session;
    sessionGeneration++;
    closeClients(1012, "device switched");
    try {
      previousSession.close();
    } catch {}
    currentSerial = serial;
    session = nextSession;
    resetSessionStats(nextSession);
    startFramePump(nextSession, sessionGeneration);
    attachSessionHandlers(nextSession, sessionGeneration);
    console.log(
      `scrcpy ready: ${nextSession.meta.deviceName} • ${nextSession.meta.codecId} • ${nextSession.meta.width}×${nextSession.meta.height}`,
    );
    return {
      ok: true,
      serial: currentSerial,
      device: nextSession.meta.deviceName,
    };
  };

  const stopCurrentSession = (reason: string) => {
    sessionGeneration++;
    status = "stopped";
    lastError = reason;
    stoppedAt = new Date().toISOString();
    routePlayback.close();
    closeClients(1000, reason);
    try {
      session.close();
    } catch {}
  };

  startFramePump(session, sessionGeneration);

  watchdog = setInterval(() => {
    sourceFps = frameCount - lastFpsFrameCount;
    lastFpsFrameCount = frameCount;
    if (status !== "streaming" || clients.size === 0) return;
    const now = Date.now();
    if (frameCount === 0 && now - startedMs > FIRST_FRAME_RESET_MS) {
      requestVideoReset("first video frame not received");
      return;
    }
    if (
      Array.from(clients).some((client) => client.awaitingKeyFrame) &&
      now - (lastFrameMs || startedMs) > AWAITING_KEYFRAME_RESET_MS
    ) {
      requestVideoReset("client awaiting keyframe");
    }
  }, 1000);

  attachSessionHandlers(session, sessionGeneration);

  let nextId = 1;
  const server = Bun.serve<WsData>({
    port: opts.port,
    hostname: host,
    async fetch(req, srv) {
      const url = new URL(req.url);

      // Bootstrap: exchange a valid one-time URL token for an HttpOnly cookie,
      // then redirect to a clean URL so the secret never lingers in the address
      // bar, browser history, or referer logs. Same-origin fetch/EventSource/WS
      // calls carry the cookie automatically afterward. Scoped to browser
      // navigations (Accept: text/html) so agents hitting `/api?token=` still
      // get their JSON response instead of a redirect.
      if (
        authToken &&
        req.method === "GET" &&
        (req.headers.get("accept") ?? "").includes("text/html")
      ) {
        const queryToken = url.searchParams.get("token");
        if (queryToken && safeEqual(queryToken, authToken)) {
          const clean = new URL(url);
          clean.searchParams.delete("token");
          return new Response(null, {
            status: 303,
            headers: {
              Location: `${clean.pathname}${clean.search}`,
              "Set-Cookie": `${SESSION_COOKIE}=${authToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
            },
          });
        }
      }

      if (!tokenValid(req, url)) {
        return new Response(
          JSON.stringify({ ok: false, error: "unauthorized" }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "WWW-Authenticate": "Bearer",
            },
          },
        );
      }

      // CSRF / cross-origin guard: reject upgrades and state-changing requests
      // whose Origin does not match the host. Applied even without auth so the
      // control channel is never open to arbitrary cross-origin pages.
      if (
        url.pathname === "/ws" ||
        (req.method !== "GET" && req.method !== "HEAD")
      ) {
        if (!originAllowed(req)) {
          return new Response(
            JSON.stringify({ ok: false, error: "forbidden origin" }),
            {
              status: 403,
              headers: { "Content-Type": "application/json; charset=utf-8" },
            },
          );
        }
      }

      if (url.pathname === "/api") {
        return Response.json({
          serial: currentSerial,
          device: session.meta.deviceName,
          codec: session.meta.codecId,
          size: { width: screen.width, height: screen.height },
          status,
          clients: clients.size,
        });
      }

      if (url.pathname === "/api/devices") {
        if (req.method !== "GET")
          return new Response("method not allowed", { status: 405 });
        try {
          return Response.json({
            ok: true,
            currentSerial,
            devices: (await listAllDevices()).map((device) => ({
              ...device,
              current: device.serial === currentSerial,
            })),
          });
        } catch (err) {
          return Response.json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 400 },
          );
        }
      }

      if (url.pathname === "/api/device-grid") {
        if (req.method !== "GET")
          return new Response("method not allowed", { status: 405 });
        try {
          return Response.json(await deviceGrid());
        } catch (err) {
          return Response.json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 400 },
          );
        }
      }

      if (url.pathname === "/api/devices/select") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        try {
          const payload = await readJsonBody(req);
          if (
            typeof payload !== "object" ||
            payload === null ||
            Array.isArray(payload)
          ) {
            throw new Error("select payload must be an object");
          }
          const serial = (payload as Record<string, unknown>).serial;
          if (typeof serial !== "string" || !serial.trim()) {
            throw new Error("serial is required");
          }
          return Response.json(await switchSession(serial.trim()));
        } catch (err) {
          return Response.json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 400 },
          );
        }
      }

      if (url.pathname === "/api/avds/start") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        try {
          const payload = await readJsonBody(req);
          if (
            typeof payload !== "object" ||
            payload === null ||
            Array.isArray(payload)
          ) {
            throw new Error("start payload must be an object");
          }
          const avd = (payload as Record<string, unknown>).avd;
          if (typeof avd !== "string" || !avd.trim())
            throw new Error("avd is required");
          const launch = await startEmulator({ avd: avd.trim() });
          const select = (payload as Record<string, unknown>).select !== false;
          if (select) {
            const switched = await switchSession(launch.serial);
            return Response.json({ ...switched, avd: avd.trim() });
          }
          return Response.json({
            ok: true,
            serial: launch.serial,
            avd: avd.trim(),
          });
        } catch (err) {
          return Response.json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 400 },
          );
        }
      }

      if (url.pathname === "/api/avds/stop") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        try {
          const payload = await readJsonBody(req);
          if (
            typeof payload !== "object" ||
            payload === null ||
            Array.isArray(payload)
          ) {
            throw new Error("stop payload must be an object");
          }
          const body = payload as Record<string, unknown>;
          let serial =
            typeof body.serial === "string" ? body.serial.trim() : "";
          if (!serial && typeof body.avd === "string" && body.avd.trim()) {
            serial =
              (await listRunningAvds()).find(
                (running) => running.avd === body.avd,
              )?.serial ?? "";
          }
          if (!serial) throw new Error("serial or running avd is required");
          if (!/^emulator-\d+$/.test(serial))
            throw new Error(`${serial} is not an emulator`);
          if (serial === currentSerial)
            stopCurrentSession("current emulator stopped");
          await stopEmulator(serial);
          return Response.json({ ok: true, serial });
        } catch (err) {
          return Response.json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 400 },
          );
        }
      }

      if (url.pathname === "/api/orientation") {
        if (req.method === "GET") {
          try {
            return Response.json({
              ok: true,
              orientation: await getUserRotation(currentSerial),
            });
          } catch (err) {
            return Response.json(
              {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              },
              { status: 400 },
            );
          }
        }
        if (req.method === "POST") {
          try {
            const payload = await readJsonBody(req);
            if (
              typeof payload !== "object" ||
              payload === null ||
              Array.isArray(payload)
            ) {
              throw new Error("orientation payload must be an object");
            }
            const orientation = (payload as Record<string, unknown>)
              .orientation;
            if (
              orientation !== "auto" &&
              orientation !== "portrait" &&
              orientation !== "landscape"
            ) {
              throw new Error(
                "orientation must be auto, portrait, or landscape",
              );
            }
            return Response.json({
              ok: true,
              orientation: await setUserRotation(
                currentSerial,
                orientation as OrientationMode,
              ),
            });
          } catch (err) {
            return Response.json(
              {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              },
              { status: 400 },
            );
          }
        }
        return new Response("method not allowed", { status: 405 });
      }

      if (url.pathname === "/api/night-mode") {
        if (req.method === "GET") {
          try {
            return Response.json({
              ok: true,
              nightMode: await getNightMode(currentSerial),
            });
          } catch (err) {
            return Response.json(
              {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              },
              { status: 400 },
            );
          }
        }
        if (req.method === "POST") {
          try {
            const payload = await readJsonBody(req);
            if (
              typeof payload !== "object" ||
              payload === null ||
              Array.isArray(payload)
            ) {
              throw new Error("night mode payload must be an object");
            }
            const mode = (payload as Record<string, unknown>).mode;
            if (mode !== "dark" && mode !== "light" && mode !== "auto") {
              throw new Error("mode must be dark, light, or auto");
            }
            return Response.json({
              ok: true,
              nightMode: await setNightMode(currentSerial, mode as NightMode),
            });
          } catch (err) {
            return Response.json(
              {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              },
              { status: 400 },
            );
          }
        }
        return new Response("method not allowed", { status: 405 });
      }

      if (url.pathname === "/api/font-scale") {
        if (req.method === "GET") {
          try {
            return Response.json({
              ok: true,
              fontScale: await getFontScale(currentSerial),
            });
          } catch (err) {
            return Response.json(
              {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              },
              { status: 400 },
            );
          }
        }
        if (req.method === "POST") {
          try {
            const payload = await readJsonBody(req);
            if (
              typeof payload !== "object" ||
              payload === null ||
              Array.isArray(payload)
            ) {
              throw new Error("font scale payload must be an object");
            }
            const scale = Number((payload as Record<string, unknown>).scale);
            if (!Number.isFinite(scale) || scale < 0.7 || scale > 2) {
              throw new Error("scale must be a number between 0.7 and 2.0");
            }
            return Response.json({
              ok: true,
              fontScale: await setFontScale(currentSerial, scale),
            });
          } catch (err) {
            return Response.json(
              {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              },
              { status: 400 },
            );
          }
        }
        return new Response("method not allowed", { status: 405 });
      }

      if (url.pathname === "/api/network") {
        if (req.method === "GET") {
          try {
            return Response.json({
              ok: true,
              network: await getNetworkStatus(currentSerial),
            });
          } catch (err) {
            return Response.json(
              {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              },
              { status: 400 },
            );
          }
        }
        if (req.method === "POST") {
          try {
            const payload = await readJsonBody(req);
            if (
              typeof payload !== "object" ||
              payload === null ||
              Array.isArray(payload)
            ) {
              throw new Error("network payload must be an object");
            }
            const enabled = (payload as Record<string, unknown>).enabled;
            if (typeof enabled !== "boolean") {
              throw new Error("enabled must be a boolean");
            }
            return Response.json({
              ok: true,
              network: await setNetworkEnabled(currentSerial, enabled),
            });
          } catch (err) {
            return Response.json(
              {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              },
              { status: 400 },
            );
          }
        }
        return new Response("method not allowed", { status: 405 });
      }

      if (url.pathname === "/health") {
        return Response.json(health(), {
          status: status === "streaming" ? 200 : 503,
        });
      }

      if (url.pathname === "/api/logcat") {
        if (req.method !== "GET")
          return new Response("method not allowed", { status: 405 });
        return logcatStream(url);
      }

      if (url.pathname === "/api/screenshot") {
        if (req.method !== "GET" && req.method !== "POST") {
          return new Response("method not allowed", { status: 405 });
        }
        try {
          const png = await screencapPng(currentSerial);
          if (url.searchParams.get("format") === "base64") {
            return Response.json({
              ok: true,
              mimeType: "image/png",
              data: png.toString("base64"),
            });
          }
          return new Response(new Uint8Array(png), {
            headers: { "Content-Type": "image/png" },
          });
        } catch (err) {
          return Response.json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 400 },
          );
        }
      }

      if (url.pathname === "/api/foreground") {
        if (req.method !== "GET")
          return new Response("method not allowed", { status: 405 });
        try {
          return Response.json({
            ok: true,
            app: await getForegroundApp(currentSerial),
          });
        } catch (err) {
          return Response.json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 400 },
          );
        }
      }

      if (url.pathname === "/api/accessibility") {
        if (req.method !== "GET")
          return new Response("method not allowed", { status: 405 });
        try {
          return Response.json(await readAccessibilitySnapshot());
        } catch (err) {
          return Response.json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 400 },
          );
        }
      }

      if (url.pathname === "/api/accessibility/tap") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return accessibilityTapEndpoint(req);
      }

      if (url.pathname === "/api/tap") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return gestureEndpoint(req, "tap", "rest:tap");
      }

      if (url.pathname === "/api/swipe") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return gestureEndpoint(req, "swipe", "rest:swipe");
      }

      if (url.pathname === "/api/text") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return gestureEndpoint(req, "text", "rest:text");
      }

      if (url.pathname === "/api/key") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return keyEndpoint(req);
      }

      if (url.pathname === "/api/session") {
        if (req.method === "GET")
          return Response.json(sessionRecorder.snapshot());
        if (req.method === "DELETE")
          return Response.json({ ok: true, session: sessionRecorder.clear() });
        return new Response("method not allowed", { status: 405 });
      }

      if (url.pathname === "/api/session/replay") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        try {
          const payload = await readJsonBody(req);
          const multiplier =
            typeof payload === "object" &&
            payload !== null &&
            !Array.isArray(payload)
              ? Number((payload as Record<string, unknown>).multiplier ?? 1)
              : 1;
          const replay = sessionRecorder.replay(
            {
              dispatchGesture: (gesture) =>
                dispatchGesture(gesture, "session:replay", false),
              setLocation: async (fix) => {
                await applyLocation(fix, "session:replay", false);
              },
            },
            multiplier,
          );
          void replay.catch(() => {});
          return Response.json({
            ok: true,
            session: sessionRecorder.snapshot(),
          });
        } catch (err) {
          return Response.json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 400 },
          );
        }
      }

      if (url.pathname === "/api/session/replay/stop") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return Response.json({
          ok: true,
          session: sessionRecorder.stopReplay(),
        });
      }

      if (url.pathname === "/api/apps/install") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return installEndpoint(req);
      }

      if (url.pathname === "/api/files/import") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return fileImportEndpoint(req);
      }

      if (url.pathname === "/api/apps/launch") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return appJsonEndpoint(req, (payload) =>
          launchApp(
            currentSerial,
            String(payload.packageName ?? ""),
            typeof payload.activity === "string" && payload.activity.trim()
              ? payload.activity
              : undefined,
          ),
        );
      }

      if (url.pathname === "/api/apps/clear") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return appJsonEndpoint(req, (payload) =>
          clearAppData(currentSerial, String(payload.packageName ?? "")),
        );
      }

      if (url.pathname === "/api/apps/force-stop") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return appJsonEndpoint(req, (payload) =>
          forceStopApp(currentSerial, String(payload.packageName ?? "")),
        );
      }

      if (url.pathname === "/api/apps/grant") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return appJsonEndpoint(req, (payload) =>
          grantPermission(
            currentSerial,
            String(payload.packageName ?? ""),
            String(payload.permission ?? ""),
          ),
        );
      }

      if (url.pathname === "/api/location") {
        if (req.method === "GET") {
          return Response.json({
            serial: currentSerial,
            emulator: /^emulator-\d+$/.test(currentSerial),
            location: lastLocation,
          });
        }
        if (req.method === "POST") {
          try {
            const fix = parseGeoFix(await readJsonBody(req));
            lastLocation = await applyLocation(fix, "rest:location");
            return Response.json({ ok: true, location: lastLocation });
          } catch (err) {
            return Response.json(
              {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              },
              { status: 400 },
            );
          }
        }
        return new Response("method not allowed", { status: 405 });
      }

      if (url.pathname === "/api/route") {
        if (req.method === "GET") {
          return Response.json(routePlayback.snapshot());
        }
        if (req.method === "POST") {
          try {
            const route = parseRoutePlaybackRequest(
              await readJsonBody(req, MAX_ROUTE_BODY_BYTES),
            );
            return Response.json({
              ok: true,
              route: await routePlayback.start(route),
            });
          } catch (err) {
            return Response.json(
              {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              },
              { status: 400 },
            );
          }
        }
        if (req.method === "DELETE") {
          return Response.json({ ok: true, route: routePlayback.stop() });
        }
        return new Response("method not allowed", { status: 405 });
      }

      if (url.pathname === "/api/route/control") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        try {
          const payload = await readJsonBody(req);
          if (
            typeof payload !== "object" ||
            payload === null ||
            Array.isArray(payload)
          ) {
            throw new Error("control payload must be an object");
          }
          const action = (payload as Record<string, unknown>).action;
          if (action === "pause")
            return Response.json({ ok: true, route: routePlayback.pause() });
          if (action === "resume")
            return Response.json({ ok: true, route: routePlayback.resume() });
          if (action === "stop")
            return Response.json({ ok: true, route: routePlayback.stop() });
          throw new Error("action must be pause, resume, or stop");
        } catch (err) {
          return Response.json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 400 },
          );
        }
      }

      if (url.pathname === "/ws") {
        if (status !== "streaming") {
          return new Response(JSON.stringify(health()), {
            status: 503,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });
        }
        const frameMeta = url.searchParams.get("frame-meta") === "1";
        const ok = srv.upgrade(req, { data: { id: nextId++, frameMeta } });
        if (ok) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }

      const reqPath = url.pathname === "/" ? "/index.html" : url.pathname;
      if (reqPath.includes(".."))
        return new Response("not found", { status: 404 });
      const file = Bun.file(join(UI_DIR, reqPath));
      if (await file.exists()) return new Response(file);
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        const handle: Client = {
          id: ws.data.id,
          ws,
          frameMeta: ws.data.frameMeta,
          sentFrames: 0,
          droppedFrames: 0,
          backpressureEvents: 0,
          awaitingKeyFrame: true,
        };
        clients.add(handle);
        ws.data.handle = handle;
        requestVideoReset("client opened");
      },
      message(ws, raw) {
        if (typeof raw !== "string") return;
        if (raw.length > MAX_WS_MESSAGE_BYTES) {
          ws.close(1009, "message too large");
          return;
        }
        try {
          if (status !== "streaming") throw new Error(`session is ${status}`);
          const payload = JSON.parse(raw);
          const acknowledge = wantsAck(payload);
          if (isResetVideoRequest(payload)) {
            requestVideoReset("client requested keyframe");
            if (acknowledge) sendJson(ws, { ok: true });
            return;
          }
          const msg = parseGesture(payload);
          void dispatchGesture(msg, "ws", shouldRecord(payload))
            .then(() => {
              if (acknowledge) sendJson(ws, { ok: true });
            })
            .catch((err) => sendJson(ws, { ok: false, error: String(err) }));
        } catch (err) {
          sendJson(ws, { ok: false, error: String(err) });
        }
      },
      close(ws) {
        if (ws.data.handle) clients.delete(ws.data.handle);
      },
    },
  });

  const stop = () => {
    if (stopRequested) return;
    stopRequested = true;
    if (status === "streaming") {
      status = "stopped";
      stoppedAt = new Date().toISOString();
    }
    closeClients(1001, "server stopping");
    if (watchdog) clearInterval(watchdog);
    routePlayback.close();
    server.stop(true);
    session.close();
  };

  return { server, session, stop };
}

export type StartedServer = Awaited<ReturnType<typeof startServer>>;
export type { ScrcpySession };
