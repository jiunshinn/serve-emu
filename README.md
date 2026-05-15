# serve-emu

The `npx serve` of Android devices.

Host your Android emulator (or real device) for use with agent tools like Codex, Cursor, or Claude Desktop — locally, over your LAN, or tunnel anywhere.

https://github.com/user-attachments/assets/7dd6d57c-4270-4b13-a733-992b7085d944

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
- Optional AVD launch with host webcam mapping for emulator camera apps

Planned:

- Logcat forwarding over SSE
- Camera injection beyond emulator startup camera mapping
- Multi-device routing
- Embeddable Connect-style middleware (`serve-emu/middleware`)
- Compiled single binary

## Requirements

- Node.js 18+ or Bun 1.1+
- `adb` on PATH (Android platform-tools)
- A booted device/emulator (`adb devices` shows it), or an AVD name passed with `--avd`
- Chrome / Edge / Safari 16.4+ (for WebCodecs)

## Quick start

```sh
bun install
bun run --filter serve-emu setup    # downloads scrcpy-server-v3.1 (90KB) into vendor/
bun run packages/serve-emu/src/cli.ts
# → http://localhost:3300
```

The `setup` step is also run lazily on first start, so you can skip it.

## Host camera

For Android Emulator targets, `serve-emu` can launch the AVD with the host webcam mapped to the emulator camera. Camera mapping must be configured when the emulator starts.

```sh
bun run packages/serve-emu/src/cli.ts --webcam-list
bun run packages/serve-emu/src/cli.ts --avd-list
bun run packages/serve-emu/src/cli.ts --running-avds
bun run packages/serve-emu/src/cli.ts --avd Pixel_10_Pro --camera-back webcam0 --restart-avd
bun run packages/serve-emu/src/cli.ts --avd Pixel_10_Pro --camera-front webcam0 --restart-avd
```

If macOS prompts for camera permission, grant it to the terminal or IDE process that launched `serve-emu`.

If the Camera app still shows the emulator's fake scene, it is probably using the other camera facing. Use `--camera-front webcam0` for the selfie camera, `--camera-back webcam0` for the rear camera, or switch camera inside the Android Camera app.

## CLI

```
serve-emu [-p <port>] [-s <serial>] [--max-fps N] [--bit-rate N] [--max-size N]
serve-emu --avd <name> [--camera-back webcam0] [--camera-front webcam0] [--restart-avd]
serve-emu --avd-list
serve-emu --running-avds
serve-emu --webcam-list
```

| flag | default | meaning |
|---|---|---|
| `-p, --port` | `3300` | HTTP port for the preview server |
| `-s, --serial` | auto | adb device serial (only required when multiple devices are attached) |
| `--max-fps` | `60` | cap source frame rate |
| `--bit-rate` | `8000000` | H.264 bit rate in bps |
| `--max-size` | `1920` | downscale longest edge to N pixels; `0` = native (encoders on many emulators reject above ~2560, so the default trims) |
| `--avd` | none | launch this Android Virtual Device before streaming |
| `--camera-back` | none | map a host webcam id, such as `webcam0`, to the emulator back camera |
| `--camera-front` | none | map a host webcam id, such as `webcam0`, to the emulator front camera |
| `--restart-avd` | false | stop a running matching AVD before launching it, useful because camera mapping only applies at emulator startup |
| `--avd-list` | false | list available Android Virtual Device names |
| `--running-avds` | false | list currently running emulator serials and AVD names |
| `--webcam-list` | false | list host webcam ids reported by Android Emulator |
| `--emulator` | auto | Android Emulator binary path; defaults to PATH or Android SDK env vars |
| `--emulator-port` | auto | emulator console port for `--avd`; must be an even port from 5554 through 5682 |

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
