# serve-emu

The `npx serve` of Android devices.

Host your Android emulator (or real device) for use with agent tools like Codex, Cursor, or Claude Desktop — locally, over your LAN, or tunnel anywhere.

```sh
bunx serve-emu
# → Preview at http://localhost:3300
```

`serve-emu` spawns the scrcpy server on the device, opens an adb forward tunnel, pipes H.264 frames over a WebSocket, and decodes them in the browser with WebCodecs. Input events flow back over the same socket to scrcpy's control channel.

## Status

v1. Working:

- Live H.264 video stream from device → WebCodecs canvas
- Taps, swipes, hardware buttons (Back / Home / Recents / Power)
- Text injection, keyevents
- Multi-client (multiple browser tabs share one stream)
- Auto-replay of SPS/PPS to clients joining mid-stream

Planned:

- Logcat forwarding over SSE
- Camera injection (Camera2/CameraX hook)
- Multi-device routing
- Embeddable Connect-style middleware (`serve-emu/middleware`)
- Compiled single binary

## Requirements

- Node.js 18+ or Bun 1.1+
- `adb` on PATH (Android platform-tools)
- A booted device or emulator (`adb devices` shows it)
- Chrome / Edge / Safari 16.4+ (for WebCodecs)

## Quick start

```sh
bun install
bun run --filter serve-emu setup    # downloads scrcpy-server-v3.1 (90KB) into vendor/
bun run packages/serve-emu/src/cli.ts
# → http://localhost:3300
```

The `setup` step is also run lazily on first start, so you can skip it.

## CLI

```
serve-emu [-p <port>] [-s <serial>] [--max-fps N] [--bit-rate N] [--max-size N]
```

| flag | default | meaning |
|---|---|---|
| `-p, --port` | `3300` | HTTP port for the preview server |
| `-s, --serial` | auto | adb device serial (only required when multiple devices are attached) |
| `--max-fps` | `60` | cap source frame rate |
| `--bit-rate` | `8000000` | H.264 bit rate in bps |
| `--max-size` | `1920` | downscale longest edge to N pixels; `0` = native (encoders on many emulators reject above ~2560, so the default trims) |

## How it works

```
┌──────────────────┐ adb forward  ┌─────────────┐  H264 / WS    ┌─────────┐
│ scrcpy-server.jar│ ◄──────────► │  serve-emu  │ ────────────► │ Browser │
│ on device        │  TCP tunnel  │   (Bun)     │   WebCodecs   │ <canvas>│
│  • video socket  │              │             │ ◄──────────── │         │
│  • control socket│              │             │  input JSON   │         │
└──────────────────┘              └─────────────┘               └─────────┘
```

1. The CLI pushes `scrcpy-server-v3.1` to `/data/local/tmp/scrcpy-server.jar`.
2. It opens `adb forward tcp:<localPort> localabstract:scrcpy_<scid>`.
3. It spawns `app_process` with the scrcpy server class on the device, then connects two sockets through the tunnel: video and control.
4. The Bun server reads scrcpy's framed H.264 stream (12-byte header + Annex-B payload) and forwards each Access Unit as a binary WebSocket message.
5. The browser parses NAL units, configures a `VideoDecoder` from the SPS, and draws frames to a `<canvas>`. Pointer events are normalized to device coordinates and written back to scrcpy's control socket as 32-byte touch packets.

## License

Apache-2.0. Bundles the upstream [scrcpy](https://github.com/Genymobile/scrcpy) server binary (Apache-2.0) at runtime.
