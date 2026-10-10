import { afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { type ScrcpySession, type VideoPacket } from "../../src/scrcpy.ts";
import {
  startServer,
  type ServerDependencies,
  type ServerOpts,
} from "../../src/server.ts";
import type { RecoveryWatchdogClock } from "../../src/session-recovery-watchdog.ts";
import { deferred, type Deferred } from "./deferred.ts";

type FrameFeedEntry =
  | { type: "value"; value: VideoPacket | null }
  | { type: "error"; error: unknown };

class FrameFeed {
  #entries: FrameFeedEntry[] = [];
  #waiting: Deferred<VideoPacket | null> | null = null;

  read(): Promise<VideoPacket | null> {
    const entry = this.#entries.shift();
    if (entry) {
      return entry.type === "value"
        ? Promise.resolve(entry.value)
        : Promise.reject(entry.error);
    }
    this.#waiting = deferred<VideoPacket | null>();
    return this.#waiting.promise;
  }

  push(value: VideoPacket | null): void {
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = null;
      waiting.resolve(value);
      return;
    }
    this.#entries.push({ type: "value", value });
  }

  fail(error: unknown): void {
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = null;
      waiting.reject(error);
      return;
    }
    this.#entries.push({ type: "error", error });
  }
}

class FakeControlSocket extends EventEmitter {
  readonly destroyed = false;
  readonly writable = true;
  readonly writes: Buffer[] = [];

  write(packet: Buffer, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(Buffer.from(packet));
    callback?.();
    return true;
  }
}

type FakeScrcpy = ScrcpySession & {
  readonly fakeControlSocket: FakeControlSocket;
  readonly closeCalls: number;
  pushFrame(frame: VideoPacket): void;
  endFrames(): void;
  failFrames(error: unknown): void;
};

function fakeScrcpy(serial = "emulator-5554"): FakeScrcpy {
  const frames = new FrameFeed();
  const controlSocket = new FakeControlSocket();
  let settled = false;
  let closeCalls = 0;
  const session = {
    transport: "scrcpy",
    serial,
    protocol: 4,
    meta: {
      deviceName: "request-gates-device",
      codecId: "h264",
      width: 720,
      height: 1280,
    },
    proc: new EventEmitter(),
    controlSocket,
    fakeControlSocket: controlSocket,
    readFrame: () => frames.read(),
    close() {
      closeCalls += 1;
      if (settled) return;
      settled = true;
      frames.push(null);
    },
    get closeCalls() {
      return closeCalls;
    },
    pushFrame(packet: VideoPacket) {
      if (settled) throw new Error("frame feed is already terminal");
      frames.push(packet);
    },
    endFrames() {
      if (settled) return;
      settled = true;
      frames.push(null);
    },
    failFrames(error: unknown) {
      if (settled) return;
      settled = true;
      frames.fail(error);
    },
  };
  return session as unknown as FakeScrcpy;
}

const INERT_RECOVERY_CLOCK: RecoveryWatchdogClock = {
  now: () => 1_000,
  setInterval: () => Symbol("recovery-timer"),
  clearInterval: () => {},
};

type UpgradeData = {
  id: number;
  frameMeta: boolean;
  context: unknown;
  handle?: unknown;
};

type CapturedHandlers = {
  fetch(
    request: Request,
    server: CapturedServer,
  ): Promise<Response | undefined>;
  websocket: {
    maxPayloadLength: number;
    open(socket: FakeWebSocket): void;
    message(socket: FakeWebSocket, message: string | Buffer): void;
    close(socket: FakeWebSocket): void;
  };
};

type CapturedServer = {
  port: number;
  hostname: string;
  upgradeResult: boolean;
  upgrades: UpgradeData[];
  stopArguments: boolean[];
  upgrade(request: Request, options: { data: UpgradeData }): boolean;
  stop(closeActiveConnections?: boolean): void;
};

type FakeWebSocket = {
  data: UpgradeData;
  sent: unknown[];
  closes: Array<{ code?: number; reason?: string }>;
  bufferedAmount: number;
  sendResult: number;
  throwOnSend: boolean;
  send(value: string | Buffer): number;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
};

function fakeWebSocket(
  data: UpgradeData,
  options: {
    bufferedAmount?: number;
    sendResult?: number;
    throwOnSend?: boolean;
  } = {},
): FakeWebSocket {
  const sent: unknown[] = [];
  const closes: Array<{ code?: number; reason?: string }> = [];
  return {
    data,
    sent,
    closes,
    bufferedAmount: options.bufferedAmount ?? 0,
    sendResult: options.sendResult ?? 1,
    throwOnSend: options.throwOnSend ?? false,
    send(value) {
      if (this.throwOnSend) throw new Error("injected websocket send failure");
      sent.push(typeof value === "string" ? JSON.parse(value) : value);
      return this.sendResult;
    },
    close(code, reason) {
      closes.push({ code, reason });
    },
    getBufferedAmount() {
      return this.bufferedAmount;
    },
  };
}

type Harness = {
  started: Awaited<ReturnType<typeof startServer>>;
  /** The first device's session; the one the server starts on. */
  session: FakeScrcpy;
  /** One fake scrcpy session per serial in `options.serials`. */
  sessions: Map<string, FakeScrcpy>;
  server: CapturedServer;
  handlers: CapturedHandlers;
  request(path: string, init?: RequestInit): Promise<Response | undefined>;
  /** Upgrades `/ws` (plus `query`) and opens the socket on the server. */
  openWebSocket(
    options?: Parameters<typeof fakeWebSocket>[1] & { query?: string },
  ): Promise<FakeWebSocket>;
};

type HarnessOptions = Partial<ServerOpts> & {
  /**
   * The devices fake adb lists, each with its own fake scrcpy session. The
   * server starts on the first. Defaults to `[options.serial]`.
   */
  serials?: string[];
};

const activeServers: Array<Awaited<ReturnType<typeof startServer>>> = [];

afterEach(async () => {
  const servers = activeServers.splice(0);
  await Promise.allSettled(servers.map((server) => server.stop()));
});

async function createHarness(
  options: HarnessOptions = {},
  dependencyOverrides: ServerDependencies = {},
): Promise<Harness> {
  const serials = options.serials ?? [options.serial ?? "emulator-5554"];
  const sessions = new Map(serials.map((serial) => [serial, fakeScrcpy(serial)]));
  const session = sessions.get(serials[0]!)!;
  let handlers: CapturedHandlers | null = null;
  const server: CapturedServer = {
    port: options.port ?? 33_040,
    hostname: options.host ?? "127.0.0.1",
    upgradeResult: true,
    upgrades: [],
    stopArguments: [],
    upgrade(_request, upgradeOptions) {
      this.upgrades.push(upgradeOptions.data);
      return this.upgradeResult;
    },
    stop(closeActiveConnections = false) {
      this.stopArguments.push(closeActiveConnections);
    },
  };
  const serve = ((serveOptions: CapturedHandlers) => {
    handlers = serveOptions;
    return server;
  }) as unknown as typeof Bun.serve;
  const started = await startServer(
    {
      serial: options.serial ?? session.serial,
      port: options.port ?? server.port,
      host: options.host,
      token: options.token,
      allowedHosts: options.allowedHosts,
    },
    {
      log: () => {},
      openScrcpy: async (serial) => {
        const opened = sessions.get(serial);
        if (!opened) throw new Error(`no fake scrcpy session for ${serial}`);
        return opened;
      },
      // With explicit serials, fake adb lists exactly those devices. Without,
      // the real listing runs (tests stub `adb` on PATH for it).
      ...(options.serials
        ? {
            listDevices: async () =>
              serials.map((serial) => ({ serial, state: "device" })),
          }
        : {}),
      recoveryClock: INERT_RECOVERY_CLOCK,
      serve,
      ...dependencyOverrides,
    },
  );
  activeServers.push(started);
  if (!handlers) throw new Error("Bun.serve options were not captured");
  const capturedHandlers = handlers as CapturedHandlers;

  const request: Harness["request"] = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("host")) {
      headers.set("host", `${server.hostname}:${server.port}`);
    }
    return capturedHandlers.fetch(
      new Request(`http://${server.hostname}:${server.port}${path}`, {
        ...init,
        headers,
      }),
      server,
    );
  };

  return {
    started,
    session,
    sessions,
    server,
    handlers: capturedHandlers,
    request,
    async openWebSocket({ query = "", ...socketOptions } = {}) {
      const upgraded = await request(`/ws${query}`);
      if (upgraded !== undefined) {
        throw new Error(`websocket upgrade was refused with ${upgraded.status}`);
      }
      const data = server.upgrades.at(-1);
      if (!data) throw new Error("websocket upgrade data was not captured");
      const socket = fakeWebSocket(data, socketOptions);
      capturedHandlers.websocket.open(socket);
      return socket;
    },
  };
}

async function response(
  value: Promise<Response | undefined>,
): Promise<Response> {
  const result = await value;
  if (!result) throw new Error("expected an HTTP response");
  return result;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met before timeout");
}

export {
  createHarness,
  FakeControlSocket,
  fakeScrcpy,
  FrameFeed,
  fakeWebSocket,
  INERT_RECOVERY_CLOCK,
  response,
  waitFor,
};
export type { CapturedServer, FakeScrcpy, FakeWebSocket, Harness, HarnessOptions };
