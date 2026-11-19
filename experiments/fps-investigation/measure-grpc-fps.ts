// Frame cadence of the emulator's own gRPC screenshot stream
// (EmulatorController/streamScreenshot), which reads frames on the host side
// instead of capturing and encoding them inside the guest like scrcpy.
//
// Frames are delivered through shared memory (MMAP transport), so each
// streamed message carries only metadata and grpcurl is not the bottleneck.
// Rates come from the emulator's own per-frame timestamps; `seq` gaps count
// frames the emulator produced but did not deliver.
//
// Requires: the emulator started with `-grpc <port> -grpc-use-token`, and
// grpcurl on PATH. The emulator log prints the discovery file
// ("Advertising in: .../pid_<pid>.ini"), which holds the port and token.
//
// usage: bun measure-grpc-fps.ts <discovery.ini> <width> <height> [seconds=10]
// Pass the size explicitly (e.g. the display's native size). The proto allows
// 0x0 for "native", but see the README for an emulator crash seen with it.

import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync, ftruncateSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const [iniPath, widthArg, heightArg, secondsArg = "10"] = process.argv.slice(2);
const width = Number(widthArg);
const height = Number(heightArg);
const seconds = Number(secondsArg);
if (!iniPath || !(width > 0) || !(height > 0)) {
  console.error("usage: bun measure-grpc-fps.ts <discovery.ini> <width> <height> [seconds]");
  process.exit(2);
}

const ini = Object.fromEntries(
  readFileSync(iniPath, "utf8")
    .split("\n")
    .map((line) => line.split("="))
    .filter((parts) => parts.length >= 2)
    .map(([key, ...rest]) => [key.trim(), rest.join("=").trim()]),
);
const port = ini["grpc.port"];
const token = ini["grpc.token"];
if (!port || !token) {
  throw new Error(`${iniPath} has no grpc.port/grpc.token; start the emulator with -grpc <port> -grpc-use-token`);
}

const sdk =
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  join(homedir(), "Library/Android/sdk");
const protoDir = process.env.EMULATOR_PROTO_DIR ?? join(sdk, "emulator/lib");

// The emulator writes each frame into this file. 64 MiB covers RGB888 up to
// 4K; the file is sparse, so it does not actually use that much disk.
const shmPath = join(tmpdir(), `serve-emu-grpc-frame-${process.pid}.shm`);
const fd = openSync(shmPath, "w");
ftruncateSync(fd, 64 * 1024 * 1024);
closeSync(fd);

const request = {
  format: "RGB888",
  width,
  height,
  transport: { channel: "MMAP", handle: `file://${shmPath}` },
};
const grpcurl = spawn("grpcurl", [
  "-plaintext",
  "-H", `authorization: Bearer ${token}`,
  "-import-path", protoDir,
  "-proto", "emulator_controller.proto",
  "-d", JSON.stringify(request),
  `127.0.0.1:${port}`,
  "android.emulation.control.EmulatorController/streamScreenshot",
]);

let output = "";
grpcurl.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
grpcurl.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
// Listen for exit immediately: grpcurl exits early on a connection or auth
// error, and a listener attached after that would wait forever.
const exited = new Promise<"exited">((resolve) =>
  grpcurl.once("close", () => resolve("exited")),
);
const outcome = await Promise.race([
  exited,
  new Promise<"elapsed">((resolve) => setTimeout(() => resolve("elapsed"), seconds * 1000)),
]);
if (outcome === "elapsed") {
  grpcurl.kill();
  await exited;
}
rmSync(shmPath, { force: true });

const timestamps = [...output.matchAll(/"timestampUs":\s*"(\d+)"/g)].map((m) => Number(m[1]));
// proto3 omits seq 0, so seq gaps are counted between the values present.
const seqs = [...output.matchAll(/"seq":\s*(\d+)/g)].map((m) => Number(m[1]));
const size = /"width":\s*(\d+),\s*"height":\s*(\d+)/.exec(output);

if (timestamps.length < 2) {
  console.error(`no frames received; grpcurl said:\n${output.slice(0, 600)}`);
  process.exit(1);
}

const intervalsMs = timestamps
  .slice(1)
  .map((t, i) => (t - timestamps[i]) / 1000)
  .sort((a, b) => a - b);
const pct = (q: number) => intervalsMs[Math.min(intervalsMs.length - 1, Math.floor(intervalsMs.length * q))];
const spanS = (timestamps[timestamps.length - 1] - timestamps[0]) / 1e6;
const seqGaps = seqs.slice(1).filter((s, i) => s - seqs[i] > 1).length;

console.log(
  [
    `size=${size ? `${size[1]}x${size[2]}` : "unknown"}`,
    `frames=${timestamps.length}`,
    `fps=${((timestamps.length - 1) / spanS).toFixed(1)}`,
    `intervalMs p50=${pct(0.5).toFixed(1)} p95=${pct(0.95).toFixed(1)} max=${intervalsMs[intervalsMs.length - 1].toFixed(1)}`,
    `seqGaps=${seqGaps}`,
  ].join(" "),
);
