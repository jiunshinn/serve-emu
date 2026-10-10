import { describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { createPublicKey, verify } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, decodeFrame, parseDiscovery } from "./grpc-client.ts";

describe("native emulator frame decoding", () => {
  test("retains RGBA and microsecond timestamps without integer precision loss", () => {
    const bytes = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]);
    const frame = decodeFrame({ format: { width: 2, height: 1 }, image: bytes, seq: 7, timestampUs: "9007199254740993" });
    expect(frame.rgba).toBe(bytes);
    expect(frame.timestampUs).toBe(9007199254740993n);
    expect(frame.seq).toBe(7);
  });

  test("rejects truncated, oversized and inconsistent invisible frames", () => {
    expect(() => decodeFrame({ format: { width: 2, height: 2 }, image: Buffer.alloc(15) })).toThrow();
    expect(() => decodeFrame({ format: { width: 4097, height: 1 }, image: Buffer.alloc(4097 * 4) })).toThrow();
    expect(() => decodeFrame({ format: { width: 0, height: 8 }, image: Buffer.alloc(0) })).toThrow();
    expect(decodeFrame({ format: { width: 0, height: 0 } }).rgba.length).toBe(0);
  });
});

test("discovery parses INI comments and preserves equals signs in credentials", () => {
  const properties = parseDiscovery("# heading\r\n[emulator]\r\ngrpc.port = 8554\r\ngrpc.token = a=b=c\r\n; ignored\r\n__proto__=safe\r\n");
  expect(properties["grpc.port"]).toBe("8554");
  expect(properties["grpc.token"]).toBe("a=b=c");
  expect(Object.getPrototypeOf(properties)).toBe(null);
});

test("explicit discovery refuses a different or unidentified serial before proto loading or authentication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "serve-emu-grpc-discovery-test-"));
  const discoveryFile = join(directory, "discovery.ini");
  const jwks = join(directory, "jwks");
  await mkdir(jwks);
  try {
    for (const identity of ["port.serial=emulator-5558", "avd.serial=emulator-5558", "port.console=5558", ""]) {
      await writeFile(discoveryFile, `${identity}\ngrpc.port=8558\ngrpc.jwks=${jwks}\ngrpc.jwk_active=${join(directory, "active.json")}\n`);
      await expect(createClient({ emulatorDir: directory, discoveryFile, serial: "emulator-5556" }))
        .rejects.toThrow("Explicit discovery file does not match the requested emulator serial.");
      expect(await readdir(jwks)).toHaveLength(0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// A protocol fixture independent of SDK installation. The real client loads
// the emulator's full controller proto; this fake emulator exercises gRPC,
// signed authentication, stream cancellation and cleanup without any device.
const PROTO = `syntax = "proto3";
package android.emulation.control;
message Empty {}
message ImageFormat { enum Format { PNG = 0; RGBA8888 = 1; } Format format = 1; uint32 width = 3; uint32 height = 4; }
message Image { ImageFormat format = 1; bytes image = 4; uint32 seq = 5; uint64 timestampUs = 6; }
service EmulatorController {
 rpc getScreenshot(ImageFormat) returns (Image);
 rpc streamScreenshot(ImageFormat) returns (stream Image);
}`;

test("JWT calls use method audiences, screenshot native bounds, and clean up streams and registered keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "serve-emu-grpc-test-"));
  const library = join(directory, "lib");
  const jwks = join(directory, "jwks");
  const active = join(directory, "active.json");
  const protoPath = join(library, "emulator_controller.proto");
  await mkdir(library);
  await mkdir(jwks);
  await writeFile(protoPath, PROTO);
  const service = (await protoLoader.load(protoPath, { keepCase: true, longs: String, enums: String, defaults: true }))[
    "android.emulation.control.EmulatorController"
  ] as protoLoader.ServiceDefinition;
  const server = new grpc.Server();
  let client: Awaited<ReturnType<typeof createClient>> | undefined;
  let refreshBusy = false;
  const refresh = setInterval(async () => {
    if (refreshBusy) return;
    refreshBusy = true;
    try {
      const files = (await readdir(jwks)).filter((name) => name.endsWith(".jwk"));
      const sets = await Promise.all(files.map(async (name) => JSON.parse(await readFile(join(jwks, name), "utf8"))));
      await writeFile(active, JSON.stringify({ keys: sets.flatMap((set) => set.keys) }));
    } catch { /* Fixture may be tearing down. */ }
    finally { refreshBusy = false; }
  }, 10);
  let methodAudiences = 0;
  let nativeBounds = false;
  let streamCancelled = false;
  const validate = async (metadata: grpc.Metadata, method: string) => {
    const bearer = String(metadata.get("authorization")[0] ?? "");
    const [headerPart, claimsPart, signature] = bearer.replace(/^Bearer /, "").split(".");
    if (!headerPart || !claimsPart || !signature) throw new Error("Missing test authorization.");
    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString());
    const claims = JSON.parse(Buffer.from(claimsPart, "base64url").toString());
    const set = JSON.parse(await readFile(active, "utf8"));
    const key = set.keys.find((entry: { kid: string }) => entry.kid === header.kid);
    if (!key || "d" in key) throw new Error("Test key registration invalid.");
    const valid = verify("sha256", Buffer.from(`${headerPart}.${claimsPart}`),
      { key: createPublicKey({ key, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
    if (!valid || header.typ !== undefined || header.alg !== "ES256" || claims.iss !== "serve-emu-native-capture"
      || claims.aud.length !== 1 || claims.aud[0] !== method || claims.exp - claims.iat > 130) {
      throw new Error("Test JWT validation failed.");
    }
    methodAudiences++;
  };
  const frame = { format: { width: 2, height: 1 }, image: Buffer.alloc(8), seq: 2, timestampUs: "9007199254740993" };
  server.addService(service, {
    getScreenshot: async (call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) => {
      try {
        await validate(call.metadata, service.getScreenshot!.path);
        nativeBounds = call.request.width === 0 && call.request.height === 0 && call.request.format === "RGBA8888";
        callback(null, frame);
      } catch { callback({ code: grpc.status.UNAUTHENTICATED, message: "Test authentication failed." }); }
    },
    streamScreenshot: async (call: grpc.ServerWritableStream<any, any>) => {
      call.on("cancelled", () => { streamCancelled = true; });
      try {
        await validate(call.metadata, service.streamScreenshot!.path);
        call.write({ format: { width: 0, height: 0 }, image: Buffer.alloc(0) });
        call.write(frame);
      } catch { call.destroy(new Error("Test authentication failed.")); }
    },
  });
  try {
    const port = await new Promise<number>((resolve, reject) => server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, port) => error ? reject(error) : resolve(port)));
    const discovery = join(directory, "discovery.ini");
    await writeFile(discovery, `port.serial=emulator-5556\ngrpc.port=${port}\ngrpc.jwks=${jwks}\ngrpc.jwk_active=${active}\n`);
    client = await createClient({ emulatorDir: directory, discoveryFile: discovery, serial: "emulator-5556" });
    const screenshot = await client.screenshot({ maxSize: 0 });
    expect(nativeBounds).toBe(true);
    expect(screenshot.timestampUs).toBe(9007199254740993n);
    await new Promise<void>((resolve, reject) => {
      const handle = client!.streamScreenshots({
        onFrame(value) { expect(value.width).toBe(2); handle.cancel(); resolve(); },
        onError: reject,
      });
    });
    for (let i = 0; i < 50 && !streamCancelled; i++) await Bun.sleep(10);
    expect(streamCancelled).toBe(true);
    expect(methodAudiences).toBe(2);
    await client.close();
    expect((await readdir(jwks)).filter((name) => name.endsWith(".jwk"))).toHaveLength(0);
  } finally {
    await client?.close();
    clearInterval(refresh);
    server.forceShutdown();
    while (refreshBusy) await Bun.sleep(5);
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
