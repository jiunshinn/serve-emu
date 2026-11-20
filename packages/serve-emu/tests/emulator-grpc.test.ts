import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerHttp2Stream, type IncomingHttpHeaders, type ServerHttp2Session } from "node:http2";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { discoverEmulatorGrpc, decodeScreenshot, encodeScreenshotRequest, EmulatorGrpcError, HostCaptureUnavailableError, startScreenshotStream } from "../src/emulator-grpc.ts";
import { startHostCaptureSession } from "../src/host-capture.ts";
import { fakeScrcpy } from "./helpers/server-harness.ts";

const TOKEN = "test-private-token";
const image = Buffer.from([10, 10, 8, 1, 18, 2, 8, 1, 24, 64, 32, 32, 40, 1, 48, 123]);
const expected = { width: 64, height: 32, rotation: 1, seq: 1n, timestampUs: 123n };

test("discovery matches dotted keys and serial, ignoring dead registrations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grpc-discovery-"));
  try {
    await writeFile(join(directory, "pid_123.ini"), `port.serial=5554\ngrpc.port=8554\ngrpc.token=${TOKEN}\nemulator.version=37.2.12.0\navd.name=pixel_fold\n`);
    await writeFile(join(directory, "pid_124.ini"), "port.serial=5554\ngrpc.port=9999\ngrpc.token=stale\n");
    await writeFile(join(directory, "unrelated.ini"), "");
    expect(await discoverEmulatorGrpc("emulator-5554", { directory, isAlive: (pid) => pid === 123 })).toEqual({ port: 8554, token: TOKEN });
    await expect(discoverEmulatorGrpc("emulator-5556", { directory, isAlive: () => true })).rejects.toBeInstanceOf(HostCaptureUnavailableError);
    await expect(discoverEmulatorGrpc("emulator-5554", { directory, isAlive: () => false })).rejects.toThrow("no live");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each(["", "grpc.port=8554", "grpc.token=secret", "grpc.port=0\ngrpc.token=secret", "grpc.port=65536\ngrpc.token=secret"])("requires both valid gRPC port and token: %s", async (properties) => {
  const directory = await mkdtemp(join(tmpdir(), "grpc-discovery-"));
  try {
    await writeFile(join(directory, "pid_123.ini"), `port.serial=5554\n${properties}`);
    await expect(discoverEmulatorGrpc("emulator-5554", { directory, isAlive: () => true })).rejects.toThrow("no live token-authenticated");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("discovery handles absent directories", async () => {
  await expect(discoverEmulatorGrpc("emulator-5554", { directory: "/nonexistent/serve-emu" })).rejects.toThrow("directory unavailable");
});

test("encodes native RGBA8888 and MMAP file URL using proto field numbers", () => {
  const handle = Buffer.from("file:///tmp/pixels");
  expect(encodeScreenshotRequest("/tmp/pixels")).toEqual(Buffer.concat([
    Buffer.from([8, 1, 24, 0, 32, 0, 50, handle.length + 4, 8, 1, 18, handle.length]), handle,
  ]));
});

test("decodes image metadata and skips image bytes and unknown fields", () => {
  expect(decodeScreenshot(Buffer.concat([image, Buffer.from([34, 3, 1, 2, 3, 61, 0, 0, 0, 0])]))).toEqual(expected);
});

test.each([Buffer.alloc(0), Buffer.from([10, 99]), Buffer.from([10, 4, 24, 0, 32, 1]), Buffer.from([0]), Buffer.from([15])])("rejects malformed or unbounded image metadata %p", (data) => {
  expect(() => decodeScreenshot(data)).toThrow();
});

async function fakeGrpc(handler: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => void) {
  const server = createServer();
  const sessions = new Set<ServerHttp2Session>();
  server.on("session", (session) => { sessions.add(session); session.on("error", () => {}); });
  server.on("stream", (stream, headers) => { stream.on("error", () => {}); handler(stream as ServerHttp2Stream, headers); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return {
    endpoint: { port: address.port, token: TOKEN },
    async close() { for (const session of sessions) session.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

test("HTTP/2 gRPC request uses bearer auth, MMAP and fragmented framed responses", async () => {
  let requestBody: Buffer = Buffer.alloc(0);
  let authorization: string | undefined;
  let path: string | undefined;
  const server = await fakeGrpc((stream, headers) => {
    authorization = headers.authorization;
    path = headers[":path"];
    stream.on("data", (chunk: Buffer) => { requestBody = Buffer.concat([requestBody, chunk]); });
    stream.on("end", () => {
      stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
      void (async () => {
        const prefix = Buffer.from([0, 0, 0, 0, image.length]);
        for (const byte of Buffer.concat([prefix, image, prefix, image])) { stream.write(Buffer.from([byte])); await setImmediate(); }
        stream.end();
      })();
    });
  });
  const capture = await startScreenshotStream(server.endpoint);
  try {
    expect(await Array.fromAsync(capture.frames())).toEqual([expected, expected]);
    expect(authorization).toBe(`Bearer ${TOKEN}`);
    expect(path).toBe("/android.emulation.control.EmulatorController/streamScreenshot");
    expect(requestBody.subarray(5)).toEqual(encodeScreenshotRequest(capture.mmapPath));
    expect((await stat(capture.mmapPath)).size).toBe(4096 * 4096 * 4);
    expect((await stat(capture.mmapPath)).mode & 0o777).toBe(0o600);
  } finally { await capture.close(); await server.close(); }
  await expect(stat(capture.mmapPath)).rejects.toThrow();
});

test("surfaces unauthenticated status without grpc-message secrets", async () => {
  const server = await fakeGrpc((stream) => {
    stream.respond({ ":status": 200, "grpc-status": "16", "grpc-message": TOKEN });
    stream.end();
  });
  const capture = await startScreenshotStream(server.endpoint);
  try {
    const error = await Array.fromAsync(capture.frames()).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(EmulatorGrpcError);
    expect(String(error)).toBe("EmulatorGrpcError: Emulator gRPC status 16");
  } finally { await capture.close(); await server.close(); }
});

test("abort interrupts a waiting gRPC stream", async () => {
  const controller = new AbortController();
  const server = await fakeGrpc((stream) => stream.respond({ ":status": 200 }));
  const capture = await startScreenshotStream(server.endpoint, controller.signal);
  try {
    const next = capture.frames().next();
    controller.abort();
    await expect(next).rejects.toThrow("aborted");
  } finally { await capture.close(); await server.close(); }
});

test.each([Buffer.from([1, 0, 0, 0, 0]), Buffer.from([0, 0, 32, 0, 0]), Buffer.from([0, 0, 0])])("rejects invalid or truncated gRPC framing %p", async (data) => {
  const server = await fakeGrpc((stream) => { stream.respond({ ":status": 200 }); stream.end(data); });
  const capture = await startScreenshotStream(server.endpoint);
  try { await expect(Array.fromAsync(capture.frames())).rejects.toThrow("Invalid emulator screenshot stream"); }
  finally { await capture.close(); await server.close(); }
});

test.skipIf(process.platform !== "darwin")("MMAP gRPC feeds the real Swift encoder, including keyframe requests and size changes", async () => {
  let path = "";
  let connection: ServerHttp2Stream | undefined;
  const server = await fakeGrpc((stream) => {
    const body: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => body.push(chunk));
    stream.on("end", () => {
      const request = Buffer.concat(body);
      path = fileURLToPath(request.subarray(request.indexOf("file:///")).toString());
      connection = stream;
      void (async () => {
        await writeFile(path, Buffer.alloc(64 * 32 * 4, 255), { flag: "r+" });
        stream.respond({ ":status": 200, "content-type": "application/grpc" });
        stream.write(Buffer.concat([Buffer.from([0, 0, 0, 0, image.length]), image]));
      })();
    });
  });
  const control = fakeScrcpy();
  const session = await startHostCaptureSession({ serial: "emulator-5554" }, {
    discover: async () => server.endpoint, startControl: async () => control,
  });
  try {
    expect(await session.readFrame()).toMatchObject({ type: "session", width: 64, height: 32 });
    expect(await session.readFrame()).toMatchObject({ type: "frame", isConfig: true });
    expect(await session.readFrame()).toMatchObject({ type: "frame", isKey: true });
    session.requestKeyFrame?.();
    let packet = await session.readFrame();
    while (packet?.type === "frame" && !packet.isConfig) packet = await session.readFrame();
    expect(packet).toMatchObject({ type: "frame", isConfig: true });
    expect(await session.readFrame()).toMatchObject({ type: "frame", isKey: true });
    const rotated = Buffer.from(image);
    rotated[9] = 32;
    rotated[11] = 64;
    await writeFile(path, Buffer.alloc(64 * 32 * 4, 128), { flag: "r+" });
    connection!.write(Buffer.concat([Buffer.from([0, 0, 0, 0, rotated.length]), rotated]));
    packet = await session.readFrame();
    while (packet?.type === "frame") packet = await session.readFrame();
    expect(packet).toMatchObject({ type: "session", width: 32, height: 64 });
    expect(await session.readFrame()).toMatchObject({ type: "frame", isConfig: true });
    expect(await session.readFrame()).toMatchObject({ type: "frame", isKey: true });
  } finally { await session.close(); await server.close(); }
  expect(control.closeCalls).toBe(1);
}, 60_000);
