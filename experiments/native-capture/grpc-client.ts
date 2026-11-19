import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const RPC_TIMEOUT_MS = 5_000;

export type ClientOptions = {
  emulatorDir: string;
  discoveryFile?: string;
  grpcAddress?: string;
  serial?: string;
  /** Must match the emulator's -grpc-allowlist issuer entry. */
  jwtIssuer?: string;
};

/** maxSize: 0 keeps native resolution; omitted defaults to a 960px edge. */
export type ScreenshotOptions = { maxSize?: number; signal?: AbortSignal };
export type CapturedFrame = {
  width: number;
  height: number;
  /** Raw emulator bytes. Validate orientation before adding a vertical flip. */
  rgba: Buffer;
  seq: number;
  timestampUs: bigint;
};
export type RtcProbe = {
  supported: boolean;
  status: string;
  code: number;
};

type Discovery = { file?: string; properties: Record<string, string> };
type RawImage = {
  format?: { width?: number; height?: number };
  width?: number;
  height?: number;
  image?: Buffer;
  seq?: number;
  timestampUs?: string;
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Deliberately never print discovery contents: they can include credentials. */
export function parseDiscovery(text: string): Record<string, string> {
  const properties: Record<string, string> = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean || clean.startsWith("#") || clean.startsWith(";") || clean.startsWith("[")) continue;
    const separator = clean.indexOf("=");
    if (separator < 1) continue;
    properties[clean.slice(0, separator).trim()] = clean.slice(separator + 1).trim();
  }
  return properties;
}

function matchesSerial(properties: Record<string, string>, serial: string): boolean {
  const consolePort = serial.replace(/^emulator-/, "");
  return properties["port.serial"] === serial
    || properties["avd.serial"] === serial
    || properties["port.serial"] === consolePort
    || properties["port.console"] === consolePort;
}

async function discover(options: ClientOptions): Promise<Discovery> {
  if (options.discoveryFile) {
    const properties = parseDiscovery(await readFile(options.discoveryFile, "utf8"));
    if (options.serial && !matchesSerial(properties, options.serial)) {
      throw new Error("Explicit discovery file does not match the requested emulator serial.");
    }
    return { file: options.discoveryFile, properties };
  }
  const roots = [
    process.env.ANDROID_EMULATOR_HOME,
    process.env.ANDROID_USER_HOME,
    process.env.ANDROID_SDK_HOME && join(process.env.ANDROID_SDK_HOME, ".android"),
    join(homedir(), ".android"),
    join(homedir(), "Library", "Android"),
    join(homedir(), "Library", "Caches", "TemporaryItems"),
    tmpdir(),
  ].filter((root): root is string => Boolean(root));
  const discoveries: Discovery[] = [];
  for (const root of new Set(roots)) {
    const directory = join(root, "avd", "running");
    let files: string[];
    try { files = await readdir(directory); } catch { continue; }
    for (const name of files) {
      const match = /^pid_(\d+)(?:_info)?\.ini$/.exec(name);
      if (!match) continue;
      try {
        process.kill(Number(match[1]), 0); // Ignore stale discovery entries.
        const file = join(directory, name);
        const properties = parseDiscovery(await readFile(file, "utf8"));
        if (!properties["grpc.port"] && !properties["grpc.address"]) continue;
        if (options.serial && !matchesSerial(properties, options.serial)) continue;
        if (options.grpcAddress && properties["grpc.port"] !== options.grpcAddress.split(":").at(-1)
          && properties["grpc.address"] !== options.grpcAddress) continue;
        discoveries.push({ file, properties });
      } catch { /* A process can exit during discovery. */ }
    }
  }
  if (discoveries.length === 1) return discoveries[0]!;
  if (discoveries.length > 1) throw new Error("Multiple emulator gRPC endpoints found; pass discoveryFile or serial.");
  if (options.grpcAddress && !options.serial) return { properties: {} };
  throw new Error("No matching emulator gRPC discovery file found; pass discoveryFile.");
}

function localAddress(address: string): string {
  if (!/^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(address)) {
    throw new Error("Native capture gRPC must use a loopback host and port.");
  }
  const port = Number(address.split(":").at(-1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid emulator gRPC port.");
  return address;
}

async function authentication(properties: Record<string, string>, issuer: string) {
  const keyDirectory = properties["grpc.jwks"];
  // JWT takes precedence when discovery contains both forms.
  if (keyDirectory) {
    const activeFile = properties["grpc.jwk_active"];
    if (!activeFile) throw new Error("JWT discovery is missing grpc.jwk_active.");
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const kid = randomUUID();
    const publicJwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig", key_ops: ["verify"] };
    const registeredFile = join(keyDirectory, `serve-emu-native-${kid}.jwk`);
    await writeFile(registeredFile, JSON.stringify({ keys: [publicJwk] }), { mode: 0o600, flag: "wx" });
    const cleanup = async () => { await unlink(registeredFile).catch(() => {}); };
    try {
      const deadline = Date.now() + RPC_TIMEOUT_MS;
      let loaded = false;
      while (Date.now() < deadline) {
        try {
          const active = JSON.parse(await readFile(activeFile, "utf8"));
          loaded = Array.isArray(active.keys) && active.keys.some((key: { kid?: string }) => key.kid === kid);
        } catch { /* The emulator rewrites this file when its key set changes. */ }
        if (loaded) break;
        await delay(50);
      }
      if (!loaded) throw new Error("Emulator did not load the native capture authentication key within 5 seconds.");
    } catch (error) {
      await cleanup();
      throw error;
    }
    return {
      mode: "jwt" as const,
      metadata(method: string) {
        const now = Math.floor(Date.now() / 1000);
        // Emulator's Tink validator rejects an unsolicited JWT `typ` header.
        const header = Buffer.from(JSON.stringify({ alg: "ES256", kid })).toString("base64url");
        const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: [method], iat: now - 5, exp: now + 120 })).toString("base64url");
        const content = `${header}.${claims}`;
        const signature = sign("sha256", Buffer.from(content), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
        const metadata = new grpc.Metadata();
        metadata.set("authorization", `Bearer ${content}.${signature}`);
        return metadata;
      },
      cleanup,
    };
  }
  return {
    mode: properties["grpc.token"] ? "token" as const : "none" as const,
    metadata(_method: string) {
      const metadata = new grpc.Metadata();
      if (properties["grpc.token"]) metadata.set("authorization", `Bearer ${properties["grpc.token"]}`);
      return metadata;
    },
    cleanup: async () => {},
  };
}

function imageRequest(options: ScreenshotOptions) {
  const maxSize = options.maxSize ?? 960;
  if (!Number.isInteger(maxSize) || maxSize < 0 || maxSize > 4096) {
    throw new Error("maxSize must be an integer from 0 through 4096.");
  }
  // Both bounds preserve aspect ratio while limiting the longest edge.
  return { format: "RGBA8888", width: maxSize, height: maxSize, display: 0 };
}

export function decodeFrame(image: RawImage): CapturedFrame {
  const width = image.format?.width ?? image.width ?? 0;
  const height = image.format?.height ?? image.height ?? 0;
  const rgba = image.image ?? Buffer.alloc(0);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0
    || width > 4096 || height > 4096 || (width === 0) !== (height === 0)
    || rgba.length > MAX_FRAME_BYTES || rgba.length !== width * height * 4) {
    throw new Error("Emulator returned invalid RGBA frame dimensions or byte length.");
  }
  return { width, height, rgba, seq: image.seq ?? 0, timestampUs: BigInt(image.timestampUs ?? "0") };
}

/** Native capture experiment only. Call close() to remove its public JWT key. */
export async function createClient(options: ClientOptions) {
  const discovery = await discover(options);
  const address = localAddress(options.grpcAddress ?? discovery.properties["grpc.address"]
    ?? `127.0.0.1:${discovery.properties["grpc.port"]}`);
  const definitions = await protoLoader.load(join(options.emulatorDir, "lib", "emulator_controller.proto"), {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
  });
  const service = definitions["android.emulation.control.EmulatorController"] as protoLoader.ServiceDefinition;
  if (!service?.getScreenshot || !service?.streamScreenshot) throw new Error("Installed emulator proto lacks screenshot RPCs.");
  const auth = await authentication(discovery.properties, options.jwtIssuer ?? "serve-emu-native-capture");
  const client = new grpc.Client(address, grpc.credentials.createInsecure(), {
    "grpc.max_receive_message_length": MAX_FRAME_BYTES + 1024 * 1024,
    "grpc.max_send_message_length": 64 * 1024,
    "grpc.enable_retries": 0,
  });
  const activeCalls = new Set<{ cancel(): void }>();
  let closed = false;
  const ensureOpen = () => { if (closed) throw new Error("Native capture client is closed."); };

  function rawUnary<T>(path: string, request: unknown, serialize: (value: any) => Buffer,
    deserialize: (value: Buffer) => T, signal?: AbortSignal): Promise<T> {
    ensureOpen();
    signal?.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const call = client.makeUnaryRequest(path, serialize, deserialize, request, auth.metadata(path),
        { deadline: Date.now() + RPC_TIMEOUT_MS }, (error, result) => {
          activeCalls.delete(call);
          signal?.removeEventListener("abort", abort);
          if (error) reject(error);
          else resolve(result!);
        });
      const abort = () => call.cancel();
      activeCalls.add(call);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  const unary = <T>(name: string, request: unknown, signal?: AbortSignal) => {
    const method = service[name]!;
    return rawUnary<T>(method.path, request, method.requestSerialize, method.responseDeserialize as (value: Buffer) => T, signal);
  };

  return {
    address,
    discoveryFile: discovery.file,
    authMode: auth.mode,
    async screenshot(options: ScreenshotOptions = {}): Promise<CapturedFrame> {
      return decodeFrame(await unary<RawImage>("getScreenshot", imageRequest(options), options.signal));
    },
    streamScreenshots(options: ScreenshotOptions & {
      onFrame(frame: CapturedFrame): void;
      onError?(error: Error): void;
      onEnd?(): void;
    }): { cancel(): void } {
      ensureOpen();
      options.signal?.throwIfAborted();
      const method = service.streamScreenshot!;
      const stream = client.makeServerStreamRequest(method.path, method.requestSerialize,
        method.responseDeserialize, imageRequest(options), auth.metadata(method.path));
      let cancelled = false;
      const cancel = () => { cancelled = true; stream.cancel(); };
      const cleanup = () => {
        activeCalls.delete(stream);
        options.signal?.removeEventListener("abort", cancel);
      };
      activeCalls.add(stream);
      options.signal?.addEventListener("abort", cancel, { once: true });
      stream.on("data", (image: RawImage) => {
        if (cancelled || closed) return;
        try {
          const frame = decodeFrame(image);
          // The emulator sends 0×0 when a display is inactive. There are no
          // pixels to encode; unary screenshot callers can observe this state.
          if (frame.width > 0 && frame.height > 0) options.onFrame(frame);
        }
        catch (error) { cancel(); options.onError?.(error instanceof Error ? error : new Error("Frame handler failed.")); }
      });
      stream.on("error", (error: grpc.ServiceError) => {
        cleanup();
        if (!cancelled && !closed) options.onError?.(error);
      });
      stream.on("end", () => { cleanup(); if (!cancelled && !closed) options.onEnd?.(); });
      return { cancel };
    },
    async sendMouse(event: { x: number; y: number; buttons?: number; display?: number }) {
      for (const coordinate of [event.x, event.y]) {
        if (!Number.isInteger(coordinate) || coordinate < 0 || coordinate > 32767) throw new Error("Mouse coordinates must be physical nonnegative integers.");
      }
      const buttons = event.buttons ?? 0;
      const display = event.display ?? 0;
      if (!Number.isInteger(buttons) || buttons < 0 || buttons > 7 || !Number.isInteger(display) || display < 0 || display > 32) throw new Error("Invalid mouse buttons or display.");
      await unary("sendMouse", { ...event, buttons, display });
    },
    async sendKey(event: { key?: string; text?: string; keyCode?: number; codeType?: "Usb" | "Evdev" | "XKB" | "Win" | "Mac"; eventType?: "keydown" | "keyup" | "keypress" }) {
      const values = [event.key, event.text, event.keyCode].filter((value) => value !== undefined);
      if (values.length !== 1) throw new Error("Provide exactly one of key, text, or keyCode.");
      if (event.key !== undefined && (typeof event.key !== "string" || !event.key || Buffer.byteLength(event.key) > 128)) throw new Error("Invalid key string.");
      if (event.text !== undefined && (typeof event.text !== "string" || Buffer.byteLength(event.text) > 1024)) throw new Error("Keyboard text exceeds 1024 bytes.");
      if (event.keyCode !== undefined && (!Number.isInteger(event.keyCode) || event.keyCode < 0 || event.keyCode > 65535)) throw new Error("Invalid keyCode.");
      if (event.eventType !== undefined && !["keydown", "keyup", "keypress"].includes(event.eventType)) throw new Error("Invalid eventType.");
      if (event.codeType !== undefined && !["Usb", "Evdev", "XKB", "Win", "Mac"].includes(event.codeType)) throw new Error("Invalid codeType.");
      await unary("sendKey", { ...event, eventType: event.eventType ?? "keypress" });
    },
    async probeRtc(): Promise<{ v1: RtcProbe; v2: RtcProbe }> {
      // Probe a nonexistent session rather than creating a WebRTC peer. A
      // registered service returns OK or NOT_FOUND; absent services return 12.
      const probe = async (prefix: string, wrapped: boolean): Promise<RtcProbe> => {
        const guid = Buffer.from(`serve-emu-probe-${randomUUID()}`);
        const id = Buffer.concat([Buffer.from([0x0a, guid.length]), guid]);
        const message = Buffer.from('{"bye":true}');
        const jsep = Buffer.concat([Buffer.from([0x0a, id.length]), id, Buffer.from([0x12, message.length]), message]);
        const request = wrapped ? Buffer.concat([Buffer.from([0x0a, jsep.length]), jsep]) : jsep;
        try {
          await rawUnary(prefix, request, (value: Buffer) => value, (value) => value);
          return { supported: true, status: "OK", code: grpc.status.OK };
        } catch (error) {
          const code = typeof (error as grpc.ServiceError).code === "number" ? (error as grpc.ServiceError).code : grpc.status.UNKNOWN;
          return { supported: code === grpc.status.NOT_FOUND,
            status: grpc.status[code] ?? "UNKNOWN", code };
        }
      };
      const v1 = await probe("/android.emulation.control.Rtc/sendJsepMessage", false);
      const v2 = await probe("/android.emulation.control.v2.Rtc/SendJsepMessage", true);
      return { v1, v2 };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const call of activeCalls) call.cancel();
      activeCalls.clear();
      client.close();
      await auth.cleanup();
    },
  };
}

export type NativeCaptureClient = Awaited<ReturnType<typeof createClient>>;
