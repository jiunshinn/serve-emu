#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import {
  displayHost,
  resolveAccessPolicy,
  startupUrl,
  TOKEN_CHARACTERS,
} from "./access-policy.ts";
import { pickDevice } from "./adb.ts";
import { CliLifecycle } from "./cli-lifecycle.ts";
import { listAvds, listRunningAvds, listWebcams, startEmulator } from "./emulator.ts";
import { describePortOwner } from "./port-owner.ts";
import { SCRCPY_DEFAULTS } from "./scrcpy.ts";
import {
  DEFAULT_HOST,
  DEFAULT_MAX_ACTIVE_UPLOADS,
  DEFAULT_MAX_APK_UPLOAD_BYTES,
  DEFAULT_MAX_MEDIA_UPLOAD_BYTES,
  DEFAULT_MAX_QUEUED_UPLOADS,
  DEFAULT_UPLOAD_QUEUE_TIMEOUT_MS,
  startServer,
} from "./server.ts";
import { getUpdateNotice } from "./update-check.ts";
import packageJson from "../package.json";

/** Parses CLI flags; throws a TypeError with an ERR_PARSE_ARGS_* code on bad input. */
export function parseCliArgs(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string", short: "p", default: "3300" },
      host: { type: "string" },
      token: { type: "string" },
      "unsafe-no-auth": { type: "boolean" },
      "allowed-host": { type: "string", multiple: true },
      serial: { type: "string", short: "s" },
      "max-fps": { type: "string", default: String(SCRCPY_DEFAULTS.maxFps) },
      "bit-rate": { type: "string", default: String(SCRCPY_DEFAULTS.bitRate) },
      "max-size": { type: "string", default: String(SCRCPY_DEFAULTS.maxSize) },
      "key-frame-interval": { type: "string", default: String(SCRCPY_DEFAULTS.keyFrameInterval) },
      "repeat-frame-ms": { type: "string", default: String(SCRCPY_DEFAULTS.repeatFrameMs) },
      "max-apk-upload-bytes": { type: "string", default: String(DEFAULT_MAX_APK_UPLOAD_BYTES) },
      "max-media-upload-bytes": { type: "string", default: String(DEFAULT_MAX_MEDIA_UPLOAD_BYTES) },
      "max-active-uploads": { type: "string", default: String(DEFAULT_MAX_ACTIVE_UPLOADS) },
      "max-queued-uploads": { type: "string", default: String(DEFAULT_MAX_QUEUED_UPLOADS) },
      "upload-queue-timeout-ms": { type: "string", default: String(DEFAULT_UPLOAD_QUEUE_TIMEOUT_MS) },
      avd: { type: "string" },
      "avd-list": { type: "boolean" },
      "running-avds": { type: "boolean" },
      "restart-avd": { type: "boolean" },
      emulator: { type: "string" },
      "emulator-port": { type: "string" },
      gpu: { type: "string", default: "host" },
      "camera-back": { type: "string" },
      "camera-front": { type: "string" },
      "webcam-list": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  return values;
}

export type CliValues = ReturnType<typeof parseCliArgs>;

function numberOption(values: CliValues, name: string, fallback: number): number {
  const value = values[name as keyof CliValues];
  if (typeof value !== "string") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number.`);
  return n;
}

async function checkForUpdate(signal: AbortSignal) {
  if (process.env.SERVE_EMU_UPDATE_CHECK === "0") return;

  const notice = await getUpdateNotice({
    packageName: packageJson.name,
    currentVersion: packageJson.version,
    cachePath: process.env.SERVE_EMU_UPDATE_CHECK_CACHE,
    signal,
  });
  if (notice && !signal.aborted) console.error(notice);
}

function printHelp() {
  console.log(`serve-emu — host an Android device over scrcpy + WebSocket

Usage:
  serve-emu [-p <port>] [--host <addr>] [--token <secret>] [-s <serial>] [--max-fps N] [--bit-rate N] [--max-size N] [--key-frame-interval sec] [--repeat-frame-ms ms]
  serve-emu --avd <name> [--restart-avd] [--camera-back <mode>] [--camera-front <mode>]
  serve-emu --avd-list
  serve-emu --running-avds
  serve-emu --webcam-list

Options:
  -p, --port <port>      Port to listen on (default: 3300)
      --host <addr>      Address to bind (default: 127.0.0.1, loopback only).
                         Use 0.0.0.0 to expose over the LAN — this requires
                         authentication (see --token) unless --unsafe-no-auth.
      --token <secret>   Require this shared secret on every request. Browsers
                         authenticate by opening the printed ?token= URL once
                         (exchanged for an HttpOnly cookie); agents send
                         'Authorization: Bearer <secret>'. On a non-loopback
                         bind a token is generated automatically if omitted.
                         Allowed characters: ${TOKEN_CHARACTERS}.
      --unsafe-no-auth   Allow a non-loopback bind with NO authentication.
                         Anyone who can reach the port can control the device.
      --allowed-host <name>
                         Without --token, also answer requests for this host
                         name (repeatable), e.g. behind a reverse proxy. IP
                         addresses, localhost, and --host are always accepted;
                         other names are rejected to block DNS rebinding.
  -s, --serial <serial>  adb device serial (defaults to the only booted device)
      --max-fps <n>      Cap source frame rate (default: ${SCRCPY_DEFAULTS.maxFps})
      --bit-rate <bps>   H.264 bit rate (default: ${SCRCPY_DEFAULTS.bitRate})
      --max-size <px>    Cap longest screen edge in pixels; 0 = native. The
                         emulator only has a software H.264 encoder, which
                         sustains 60fps only below ~1 megapixel, so this
                         defaults to ${SCRCPY_DEFAULTS.maxSize}.
      --key-frame-interval <sec>
                         Advisory keyframe interval; 0 omits this codec option,
                         leaving scrcpy's own 10s default (default: ${SCRCPY_DEFAULTS.keyFrameInterval}).
                         The emulator's encoder counts it in frames at a nominal
                         60fps, so keyframes arrive later at lower frame rates.
                         Clients get keyframes on demand via reset-video and
                         never wait for a periodic one.
      --repeat-frame-ms <ms>
                         Re-encode the previous frame after this many ms with no
                         screen change (0 keeps the encoder default of 100ms).
                         Android repeats a frame at most 10 times, so a static
                         screen still stops sending frames.
      --max-apk-upload-bytes <n>    Maximum streamed APK bytes (default: ${DEFAULT_MAX_APK_UPLOAD_BYTES})
      --max-media-upload-bytes <n>  Maximum streamed media bytes (default: ${DEFAULT_MAX_MEDIA_UPLOAD_BYTES})
      --max-active-uploads <n>      Concurrent uploads (default: ${DEFAULT_MAX_ACTIVE_UPLOADS})
      --max-queued-uploads <n>      Queued uploads (default: ${DEFAULT_MAX_QUEUED_UPLOADS})
      --upload-queue-timeout-ms <ms> Upload queue wait limit (default: ${DEFAULT_UPLOAD_QUEUE_TIMEOUT_MS})
      --avd <name>       Launch this Android Virtual Device before streaming.
                         If serve-emu started the emulator, serve-emu exits
                         when it exits while it is still the streamed device
                         (not for an AVD that was already running).
      --gpu <mode>       Emulator GPU mode for --avd launches (default: host).
                         host uses the real GPU for smooth ~60fps; the AVD's
                         own auto often falls back to a software compositor that
                         stutters. Use swiftshader_indirect on headless hosts.
      --restart-avd      Stop a running matching AVD before launching it
      --camera-back <mode>
                         Experimental. Back camera for --avd launches. webcam<N>
                         shows a host webcam (see --webcam-list); emulated,
                         virtualscene, none, and imagefile:<path> also work. The
                         emulator picks cameras at boot, so add --restart-avd if
                         the AVD is already running.
      --camera-front <mode>
                         Experimental. Front camera for --avd launches; same
                         modes except virtualscene. Each webcam can feed only
                         one camera.
      --avd-list         Print available Android Virtual Device names
      --running-avds     Print currently running emulator AVDs
      --webcam-list      Experimental. Print host webcams the emulator can use
      --emulator <path>  Android Emulator binary (default: PATH or Android SDK)
      --emulator-port <n>
                         Emulator console port for --avd (even 5554-5682)
  -h, --help             Show this help
`);
}

async function main(values: CliValues) {
  // The listing commands below never contact the registry; the server path
  // checks in the background once it is listening.

  if (values["avd-list"]) {
    console.log((await listAvds(values.emulator)).join("\n"));
    return;
  }

  if (values["running-avds"]) {
    const running = await listRunningAvds();
    console.log(running.length ? running.map((avd) => `${avd.serial}\t${avd.avd}\t${avd.state}`).join("\n") : "");
    return;
  }

  if (values["webcam-list"]) {
    const webcams = await listWebcams(values.emulator);
    console.log(webcams.map((webcam) => `${webcam.name}\t${webcam.device}`).join("\n"));
    return;
  }

  if ((values["emulator-port"] || values["restart-avd"]) && !values.avd) {
    throw new Error("--emulator-port and --restart-avd require --avd.");
  }

  const cameraRequested = values["camera-back"] !== undefined || values["camera-front"] !== undefined;
  if (cameraRequested && !values.avd) {
    throw new Error(
      "--camera-back and --camera-front require --avd: the emulator picks its cameras at boot.",
    );
  }

  if (values.avd && values.serial) {
    throw new Error("Use either --avd to launch an emulator or --serial to attach to an existing device, not both.");
  }

  if (cameraRequested) {
    console.error(
      "Camera support is experimental, and the camera preview can be slow. " +
        "Known limitations: https://github.com/jiunshinn/serve-emu#camera",
    );
  }

  // Access-control policy, settled before an emulator is launched or a device
  // picked so a bad --token fails fast. See resolveAccessPolicy.
  const host = values.host ?? DEFAULT_HOST;
  const { token, warnings } = resolveAccessPolicy({
    host,
    token: values.token,
    unsafeNoAuth: Boolean(values["unsafe-no-auth"]),
    generateToken: () => randomBytes(24).toString("base64url"),
  });

  type ActiveServer = Awaited<ReturnType<typeof startServer>>;
  // Installed before the emulator boots: a signal during the boot wait must
  // still stop the emulator this process started, and wait until it exits.
  const lifecycle = new CliLifecycle<ActiveServer>();
  let emulatorLaunch: Awaited<ReturnType<typeof startEmulator>> | null = null;
  const stop = () => lifecycle.stop();
  process.once("SIGINT", () => {
    void stop()
      .catch((err) => console.error("Shutdown cleanup failed:", err))
      .finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void stop()
      .catch((err) => console.error("Shutdown cleanup failed:", err))
      .finally(() => process.exit(0));
  });

  let serial: string;
  try {
    serial = values.avd
      ? (emulatorLaunch = await lifecycle.trackEmulator(
          startEmulator({
            avd: values.avd,
            emulatorPath: values.emulator,
            port: values["emulator-port"] ? Number(values["emulator-port"]) : undefined,
            restartAvd: values["restart-avd"],
            gpu: values.gpu,
            cameraBack: values["camera-back"],
            cameraFront: values["camera-front"],
            signal: lifecycle.signal,
          }),
        )).serial
      : await pickDevice(values.serial);
  } catch (err) {
    // startEmulator already stopped its own child; the signal handler exits.
    if (lifecycle.signal.aborted) {
      await stop();
      return;
    }
    throw err;
  }
  const port = Number(values.port);
  const maxFps = numberOption(values, "max-fps", SCRCPY_DEFAULTS.maxFps);
  const bitRate = numberOption(values, "bit-rate", SCRCPY_DEFAULTS.bitRate);
  const maxSize = numberOption(values, "max-size", SCRCPY_DEFAULTS.maxSize);
  const keyFrameInterval = numberOption(values, "key-frame-interval", SCRCPY_DEFAULTS.keyFrameInterval);
  const repeatFrameMs = numberOption(values, "repeat-frame-ms", SCRCPY_DEFAULTS.repeatFrameMs);
  const maxApkUploadBytes = numberOption(values, "max-apk-upload-bytes", DEFAULT_MAX_APK_UPLOAD_BYTES);
  const maxMediaUploadBytes = numberOption(values, "max-media-upload-bytes", DEFAULT_MAX_MEDIA_UPLOAD_BYTES);
  const maxActiveUploads = numberOption(values, "max-active-uploads", DEFAULT_MAX_ACTIVE_UPLOADS);
  const maxQueuedUploads = numberOption(values, "max-queued-uploads", DEFAULT_MAX_QUEUED_UPLOADS);
  const uploadQueueTimeoutMs = numberOption(values, "upload-queue-timeout-ms", DEFAULT_UPLOAD_QUEUE_TIMEOUT_MS);


  const startupTask = lifecycle.trackServer(startServer({
    serial,
    port,
    host,
    token,
    allowedHosts: values["allowed-host"],
    signal: lifecycle.signal,
    maxFps,
    bitRate,
    maxSize,
    keyFrameInterval,
    repeatFrameMs,
    maxApkUploadBytes,
    maxMediaUploadBytes,
    maxActiveUploads,
    maxQueuedUploads,
    uploadQueueTimeoutMs,
  }));
  let activeServer: ActiveServer;
  try {
    activeServer = await startupTask;
  } catch (err) {
    await emulatorLaunch?.stop();
    if (lifecycle.signal.aborted) {
      await stop();
      return;
    }
    if ((err as { code?: unknown } | null)?.code === "EADDRINUSE") {
      const owner = await describePortOwner(host, port);
      if (owner) {
        throw new Error(`${owner} Stop it, or choose another port with -p.`, { cause: err });
      }
    }
    throw err;
  }
  if (lifecycle.signal.aborted) {
    await stop();
    return;
  }
  const { server } = activeServer;
  if (emulatorLaunch) {
    const avd = values.avd;
    lifecycle.watchEmulator(emulatorLaunch, () => activeServer.deviceSerial, (exit) => {
      const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
      console.error(
        `error: the emulator serve-emu launched (${exit.serial}, AVD ${avd}) exited with ${how}; stopping serve-emu.`,
      );
      void stop()
        .catch((err) => console.error("Shutdown cleanup failed:", err))
        .finally(() => process.exit(1));
    });
    // It exited while the server was starting: watchEmulator already began
    // the shutdown, so don't print a URL that is about to stop working.
    if (lifecycle.signal.aborted) return;
  }

  const base = `http://${displayHost(host)}:${server.port}`;
  console.log(`serve-emu → ${startupUrl(base, token)}  (device: ${serial})`);
  if (token) {
    console.error(
      "Authentication is ON. Open the URL above once to authenticate this browser " +
        "(the token is exchanged for an HttpOnly cookie). Agents send " +
        "'Authorization: Bearer <token>' or append ?token=<token>.",
    );
  }
  for (const warning of warnings) console.error(warning);

  // In the background, after the startup URL: a slow or unreachable registry
  // never delays the server, and a notice prints to stderr when it settles.
  void checkForUpdate(lifecycle.signal).catch(() => {});
}

function isParseArgsError(err: unknown): err is TypeError & { code: string } {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_");
}

/** Runs the CLI for `argv`; errors carry a one-line, user-facing message. */
export async function runCli(argv: string[]): Promise<void> {
  let values: CliValues;
  try {
    values = parseCliArgs(argv);
  } catch (err) {
    if (isParseArgsError(err)) {
      // Drop parseArgs' hint about '-'-prefixed positionals; the CLI takes none.
      const message = err.message.replace(/\. To specify a positional argument.*$/s, "");
      throw new Error(`${message}. Run 'serve-emu --help' for usage.`, { cause: err });
    }
    throw err;
  }
  if (values.help) {
    printHelp();
    return;
  }
  await main(values);
}

if (import.meta.main) {
  await runCli(Bun.argv.slice(2)).catch((err) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
