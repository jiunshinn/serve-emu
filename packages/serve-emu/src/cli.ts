#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { pickDevice } from "./adb.ts";
import { startServer } from "./server.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: "string", short: "p", default: "3300" },
    serial: { type: "string", short: "s" },
    "max-fps": { type: "string", default: "60" },
    "bit-rate": { type: "string", default: "8000000" },
    "max-size": { type: "string", default: "1920" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(`serve-emu — host an Android device over scrcpy + WebSocket

Usage:
  serve-emu [-p <port>] [-s <serial>] [--max-fps N] [--bit-rate N] [--max-size N]

Options:
  -p, --port <port>      Port to listen on (default: 3300)
  -s, --serial <serial>  adb device serial (defaults to the only booted device)
      --max-fps <n>      Cap source frame rate (default: 60)
      --bit-rate <bps>   H.264 bit rate (default: 8000000)
      --max-size <px>    Cap longest screen edge in pixels; 0 = native, but many
                         emulators reject native resolutions above ~2560 so this
                         defaults to 1920 (set to 0 if you want full native).
  -h, --help             Show this help
`);
  process.exit(0);
}

const serial = pickDevice(values.serial);
const port = Number(values.port);
const { server } = await startServer({
  serial,
  port,
  maxFps: Number(values["max-fps"]),
  bitRate: Number(values["bit-rate"]),
  maxSize: Number(values["max-size"]),
});

console.log(`serve-emu → http://localhost:${server.port}  (device: ${serial})`);
