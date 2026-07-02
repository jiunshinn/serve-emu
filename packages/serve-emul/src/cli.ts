#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { pickDevice } from "./adb.ts";
import { listAvds, listRunningAvds, startEmulator } from "./emulator.ts";
import { SCRCPY_DEFAULTS } from "./scrcpy.ts";
import { startServer } from "./server.ts";
import { getUpdateNotice } from "./update-check.ts";
import packageJson from "../package.json";

const argv = Bun.argv.slice(2);
const { values } = parseArgs({
  args: argv,
  options: {
    port: { type: "string", short: "p", default: "3300" },
    serial: { type: "string", short: "s" },
    "max-fps": { type: "string", default: String(SCRCPY_DEFAULTS.maxFps) },
    "bit-rate": { type: "string", default: String(SCRCPY_DEFAULTS.bitRate) },
    "max-size": { type: "string", default: String(SCRCPY_DEFAULTS.maxSize) },
    "key-frame-interval": { type: "string", default: String(SCRCPY_DEFAULTS.keyFrameInterval) },
    "repeat-frame-ms": { type: "string", default: String(SCRCPY_DEFAULTS.repeatFrameMs) },
    avd: { type: "string" },
    "avd-list": { type: "boolean" },
    "running-avds": { type: "boolean" },
    "restart-avd": { type: "boolean" },
    emulator: { type: "string" },
    "emulator-port": { type: "string" },
    gpu: { type: "string", default: "host" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

function numberOption(name: string, fallback: number): number {
  const value = values[name as keyof typeof values];
  if (typeof value !== "string") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number.`);
  return n;
}

async function checkForUpdate() {
  if (process.env.SERVE_EMUL_UPDATE_CHECK === "0") return;

  const notice = await getUpdateNotice({
    packageName: packageJson.name,
    currentVersion: packageJson.version,
    cachePath: process.env.SERVE_EMUL_UPDATE_CHECK_CACHE,
  });
  if (notice) console.error(notice);
}

if (values.help) {
  console.log(`serve-emul — host an Android device over scrcpy + WebSocket

Usage:
  serve-emul [-p <port>] [-s <serial>] [--max-fps N] [--bit-rate N] [--max-size N] [--key-frame-interval sec] [--repeat-frame-ms ms]
  serve-emul --avd <name> [--restart-avd]
  serve-emul --avd-list
  serve-emul --running-avds

Options:
  -p, --port <port>      Port to listen on (default: 3300)
  -s, --serial <serial>  adb device serial (defaults to the only booted device)
      --max-fps <n>      Cap source frame rate (default: ${SCRCPY_DEFAULTS.maxFps})
      --bit-rate <bps>   H.264 bit rate (default: ${SCRCPY_DEFAULTS.bitRate})
      --max-size <px>    Cap longest screen edge in pixels; 0 = native. The
                         emulator only has a software H.264 encoder, which
                         sustains 60fps only below ~1 megapixel, so this
                         defaults to ${SCRCPY_DEFAULTS.maxSize}.
      --key-frame-interval <sec>
                         Ask the encoder for regular keyframes; 0 disables this
                         codec option (default: ${SCRCPY_DEFAULTS.keyFrameInterval}). Late joiners get keyframes
                         on demand via reset-video, so a long interval avoids
                         periodic keyframe bursts.
      --repeat-frame-ms <ms>
                         Re-encode the previous frame after this many ms with no
                         screen change, so static screens keep producing frames
                         (16 ≈ steady 60fps at the cost of extra CPU/bandwidth;
                         0 keeps the encoder default of one repeat per 100ms)
      --avd <name>       Launch this Android Virtual Device before streaming
      --gpu <mode>       Emulator GPU mode for --avd launches (default: host).
                         host uses the real GPU for smooth ~60fps; the AVD's
                         own auto often falls back to a software compositor that
                         stutters. Use swiftshader_indirect on headless hosts.
      --restart-avd      Stop a running matching AVD before launching it
      --avd-list         Print available Android Virtual Device names
      --running-avds     Print currently running emulator AVDs
      --emulator <path>  Android Emulator binary (default: PATH or Android SDK)
      --emulator-port <n>
                         Emulator console port for --avd (even 5554-5682)
  -h, --help             Show this help
`);
  process.exit(0);
}

async function main() {
  await checkForUpdate().catch(() => {});

  if (values["avd-list"]) {
    console.log((await listAvds(values.emulator)).join("\n"));
    return;
  }

  if (values["running-avds"]) {
    const running = await listRunningAvds();
    console.log(running.length ? running.map((avd) => `${avd.serial}\t${avd.avd}\t${avd.state}`).join("\n") : "");
    return;
  }

  if ((values["emulator-port"] || values["restart-avd"]) && !values.avd) {
    throw new Error("--emulator-port and --restart-avd require --avd.");
  }

  if (values.avd && values.serial) {
    throw new Error("Use either --avd to launch an emulator or --serial to attach to an existing device, not both.");
  }

  let emulatorLaunch: Awaited<ReturnType<typeof startEmulator>> | null = null;
  const serial = values.avd
    ? (emulatorLaunch = await startEmulator({
        avd: values.avd,
        emulatorPath: values.emulator,
        port: values["emulator-port"] ? Number(values["emulator-port"]) : undefined,
        restartAvd: values["restart-avd"],
        gpu: values.gpu,
      })).serial
    : await pickDevice(values.serial);
  const port = Number(values.port);
  const maxFps = numberOption("max-fps", SCRCPY_DEFAULTS.maxFps);
  const bitRate = numberOption("bit-rate", SCRCPY_DEFAULTS.bitRate);
  const maxSize = numberOption("max-size", SCRCPY_DEFAULTS.maxSize);
  const keyFrameInterval = numberOption("key-frame-interval", SCRCPY_DEFAULTS.keyFrameInterval);
  const repeatFrameMs = numberOption("repeat-frame-ms", SCRCPY_DEFAULTS.repeatFrameMs);

  const { server, stop: stopServer } = await startServer({
    serial,
    port,
    maxFps,
    bitRate,
    maxSize,
    keyFrameInterval,
    repeatFrameMs,
  }).catch((err) => {
    emulatorLaunch?.stop();
    throw err;
  });

  const stop = () => {
    stopServer();
    emulatorLaunch?.stop();
  };
  process.once("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    stop();
    process.exit(0);
  });

  console.log(`serve-emul → http://localhost:${server.port}  (device: ${serial})`);
}

await main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
