# serve-emul

Host your Android emulator or attached Android device for agent workflows like Codex, Cursor, Claude Desktop, and browser-based QA. `serve-emul` streams the screen locally, over your LAN, or through your tunnel of choice, then accepts low-latency input and device-control commands over HTTP and WebSocket.



https://github.com/user-attachments/assets/5646d44c-7fd1-4e97-8705-b44b47c7fdc6



```sh
bunx serve-emul@latest
# or: npx serve-emul@latest
# -> Preview at http://localhost:3300
```

Use `@latest` for one-off runs so Bun/npm fetches the newest published version instead of reusing a cached or locally installed copy.

`serve-emul` starts the vendored scrcpy server on the device, opens an adb forward tunnel, forwards H.264 frames over WebSockets, and decodes them in the browser with WebCodecs. Input events are written directly to scrcpy's control socket instead of shelling out to `adb shell input`, keeping taps, swipes, text, and key events responsive enough for agents.

## Status

Current package version: see [`packages/serve-emul/package.json`](packages/serve-emul/package.json) and [`packages/serve-emul/CHANGELOG.md`](packages/serve-emul/CHANGELOG.md).

Working:

- Live H.264 video stream from device to WebCodecs canvas
- Tap, swipe, text, keyevent, Back, Home, Recents, and Power input
- Keyboard passthrough in the browser UI: editing/navigation keys, Ctrl/Cmd shortcuts (select all, copy, paste, cut, undo, redo), and IME composition for CJK text
- Multi-client streaming, so multiple browser tabs can share one device
- SPS/PPS replay and metadata headers for clients joining mid-stream
- Device discovery, current-device switching, and AVD start/stop controls
- Screenshot, foreground app, accessibility tree, and logcat APIs for agent inspection
- Orientation, dark/light mode, font scale, and network on/off controls
- Emulator GPS location control and route playback from GPX, GeoJSON, KML, or waypoint JSON
- Session recording and replay for REST, WebSocket, and location events
- APK install, app launch, clear data, force stop, permission grant, and media/file import helpers

Planned:

- Multi-device routing
- Embeddable Connect-style middleware (`serve-emul/middleware`)
- Compiled single binary

## Requirements

- Bun 1.1+
- `adb` on PATH from Android platform-tools
- A booted device/emulator from `adb devices`, or an AVD name passed with `--avd`
- Chrome, Edge, or Safari 16.4+ for the bundled WebCodecs UI

Node.js 18+ can invoke the published package through `npx`, but local development and server runtime use Bun.

## Quick Start

One-off run from npm:

```sh
bunx serve-emul@latest
# or
npx serve-emul@latest
```

Local development from this repository:

```sh
bun install
bun run --filter serve-emul setup
bun run packages/serve-emul/src/cli.ts
# -> http://localhost:3300
```

`setup` downloads the pinned `scrcpy-server-v4.0` into `packages/serve-emul/vendor/` and builds the browser UI. The CLI also runs the scrcpy setup lazily on first start, so you can skip the setup step for a quick local run.

## CLI

```text
serve-emul [-p <port>] [--host <addr>] [--token <secret>] [-s <serial>] [--max-fps N] [--bit-rate N] [--max-size N] [--key-frame-interval sec] [--repeat-frame-ms ms]
serve-emul --avd <name> [--gpu <mode>] [--restart-avd]
serve-emul --avd-list
serve-emul --running-avds
```

| flag | default | meaning |
| --- | --- | --- |
| `-p, --port` | `3300` | HTTP port for the preview server |
| `--host` | `127.0.0.1` | Address to bind. Defaults to loopback so the device is not exposed. Set `0.0.0.0` to serve over the LAN — see [Access control](#access-control) |
| `--token` | none | Shared secret required on every request. Auto-generated for non-loopback binds if omitted |
| `--unsafe-no-auth` | false | Allow a non-loopback bind with **no** authentication (dangerous) |
| `-s, --serial` | auto | adb device serial; required when multiple devices are online |
| `--max-fps` | `60` | Cap source frame rate |
| `--bit-rate` | `8000000` | H.264 bit rate in bps |
| `--max-size` | `1280` | Downscale the longest edge to N pixels; `0` keeps native size. The emulator's software H.264 encoder sustains 60fps only below ~1 megapixel, hence the 1280 default |
| `--key-frame-interval` | `10` | Ask the encoder for regular keyframes; `0` disables this codec option. Late joiners get keyframes on demand, so a long interval avoids periodic keyframe bursts |
| `--repeat-frame-ms` | `0` | Re-encode the previous frame after N ms without screen changes (`16` ≈ steady 60fps on static screens, at extra CPU/bandwidth cost); `0` keeps the encoder default of one repeat per 100ms |
| `--avd` | none | Launch this Android Virtual Device before streaming |
| `--gpu` | `host` | Emulator GPU mode for `--avd` launches. `host` renders on the real GPU for smooth ~60fps; see [Smooth Emulator Playback](#smooth-emulator-playback) |
| `--restart-avd` | false | Stop a running matching AVD before launching it |
| `--avd-list` | false | List available Android Virtual Device names |
| `--running-avds` | false | List currently running emulator serials and AVD names |
| `--emulator` | auto | Android Emulator binary path; defaults to PATH or Android SDK env vars |
| `--emulator-port` | auto | Emulator console port for `--avd`; must be an even port from 5554 through 5682 |

By default, `serve-emul` attaches to the only online device. If more than one device is online, pass `-s <serial>` or select another running device later through the HTTP API/UI.

## Access control

`serve-emul` grants full control of the connected device — input, screenshots, APK installation, file import, app-data clearing, logcat, and session controls. Treat access to the port as access to the device.

**Default (loopback).** With no flags the server binds to `127.0.0.1`, so only processes on the same machine can reach it. No authentication is required, and local CLI/agent workflows keep working with no setup. Cross-origin browser requests and WebSocket upgrades are still rejected (the Origin must match the host), so a random web page cannot drive your device through the local port.

**Exposing over the LAN or a tunnel.** Pass `--host 0.0.0.0` (or a specific interface address). A non-loopback bind **requires authentication**:

- If you pass `--token <secret>`, that secret is required on every request.
- If you omit `--token`, a random token is generated and printed once at startup.

The startup line prints a ready-to-use URL with the token, for example:

```text
serve-emul → http://localhost:3300/?token=qNEvGN1TSgqRc3NHeZiXOfX2tkQUnv68  (device: emulator-5554)
```

How clients authenticate:

- **Browser (bundled UI):** open the printed `?token=` URL once. The server exchanges the token for a `HttpOnly; SameSite=Strict` session cookie and redirects to a clean URL, so the secret is not kept in local storage or the address bar. Same-origin API, SSE, and WebSocket calls then carry the cookie automatically.
- **Agents / CLI (`curl`, HTTP clients):** send `Authorization: Bearer <token>`, or append `?token=<token>` to the URL.

Requests without a valid token get `401`; WebSocket upgrades and state-changing requests from a mismatched `Origin` get `403` before any work is done.

**Unauthenticated LAN exposure.** `--host 0.0.0.0 --unsafe-no-auth` binds to all interfaces with no authentication. Anyone who can reach the port can control the device. Only use this on a trusted, isolated network; the CLI prints a warning at startup.

**Token handling.** The token is never included in `/health`, `/api` responses, error payloads, or reconnect URLs — only in the one-time startup line. Rotate it by restarting with a new `--token` (or letting a fresh one be generated); existing cookies stop working immediately. When exposing beyond your machine, prefer an SSH tunnel or an authenticating reverse proxy over a raw `0.0.0.0` bind.

## Smooth Emulator Playback

The single biggest factor for stutter-free emulator streaming is the **emulator GPU mode**, not the bit rate or the transport. Many AVDs default to `auto`, which on some hosts (notably Apple Silicon) falls back to a **software Vulkan compositor** (`llvmpipe`/`lavapipe`). That caps the guest at a janky ~20fps with dropped frames, so the stream stutters no matter how high you set `--max-fps` or `--bit-rate`.

`serve-emul` launches `--avd` emulators with **`-gpu host`** by default, which renders on the real GPU (Metal/Vulkan) for smooth ~60fps playback (measured: guest jank dropped from 10–19% to 0%). Override with `--gpu <mode>` when needed:

```sh
# default — real GPU, smooth
serve-emul --avd Pixel_8

# headless host without a usable GPU
serve-emul --avd Pixel_8 --gpu swiftshader_indirect
```

If you start the emulator yourself (or attach to a pre-booted one with `-s`), `serve-emul` can't set its GPU mode — launch it with `-gpu host` directly:

```sh
emulator @Pixel_8 -gpu host
```

You can confirm the mode in the emulator log (`vulkan_mode_selected:host` = good; `lavapipe`/`llvmpipe` = software fallback) or via `adb shell dumpsys gfxinfo <pkg>` (look for a low "Janky frames" percentage while scrolling). For an extra fps margin, lower `--max-size` to stream at a smaller resolution.

## Browser UI

Open `http://localhost:3300` after starting the CLI. The UI streams the device into a canvas and exposes controls for:

- Pointer input, keyboard passthrough (typing, navigation keys, shortcuts, IME composition), hardware buttons, and screenshots
- Device selection plus AVD start/stop
- Orientation, night mode, font scale, network, GPS location, and route playback
- Logcat filtering, pause/copy controls, app management, file import, and session replay

## HTTP API

All examples assume the default port:

```sh
BASE=http://localhost:3300
```

### Health And Discovery

```sh
curl "$BASE/health"
curl "$BASE/api"
curl "$BASE/api/devices"
curl "$BASE/api/device-grid"
curl -X POST "$BASE/api/devices/select" \
  -H 'Content-Type: application/json' \
  -d '{"serial":"emulator-5554"}'
```

AVD lifecycle helpers:

```sh
curl -X POST "$BASE/api/avds/start" \
  -H 'Content-Type: application/json' \
  -d '{"avd":"Pixel_8","select":true}'

curl -X POST "$BASE/api/avds/stop" \
  -H 'Content-Type: application/json' \
  -d '{"serial":"emulator-5554"}'
```

### Input

Coordinates are normalized from `0` to `1` and converted to screen pixels by the server.

```sh
curl -X POST "$BASE/api/tap" \
  -H 'Content-Type: application/json' \
  -d '{"x":0.5,"y":0.5}'

curl -X POST "$BASE/api/swipe" \
  -H 'Content-Type: application/json' \
  -d '{"x1":0.5,"y1":0.8,"x2":0.5,"y2":0.2,"durationMs":350}'

curl -X POST "$BASE/api/text" \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello"}'

curl -X POST "$BASE/api/key" \
  -H 'Content-Type: application/json' \
  -d '{"key":"back"}'
```

Arbitrary keycodes accept an optional `action` (`"down"` or `"up"`; omit for an immediate press) and an optional `metaState` bitmask using Android's `AMETA_*` values (`0x1` shift, `0x2` alt, `0x1000` ctrl):

```sh
# Ctrl+A (select all)
curl -X POST "$BASE/api/key" \
  -H 'Content-Type: application/json' \
  -d '{"keycode":29,"metaState":4096}'

# Hold DPAD_DOWN down, then release it later
curl -X POST "$BASE/api/key" -H 'Content-Type: application/json' -d '{"keycode":20,"action":"down"}'
curl -X POST "$BASE/api/key" -H 'Content-Type: application/json' -d '{"keycode":20,"action":"up"}'
```

### Inspection

```sh
curl "$BASE/api/screenshot" --output screen.png
curl "$BASE/api/screenshot?format=base64"
curl "$BASE/api/foreground"
curl "$BASE/api/accessibility"
curl -X POST "$BASE/api/accessibility/tap" \
  -H 'Content-Type: application/json' \
  -d '{"selector":{"resourceId":"com.example:id/login"}}'
curl -X POST "$BASE/api/accessibility/tap" \
  -H 'Content-Type: application/json' \
  -d '{"selector":{"textContains":"Continue","clickable":true}}'
curl -N "$BASE/api/logcat?package=com.example.app&search=error"
```

### Device Settings

```sh
curl "$BASE/api/orientation"
curl -X POST "$BASE/api/orientation" \
  -H 'Content-Type: application/json' \
  -d '{"orientation":"landscape"}'

curl "$BASE/api/night-mode"
curl -X POST "$BASE/api/night-mode" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"dark"}'

curl "$BASE/api/font-scale"
curl -X POST "$BASE/api/font-scale" \
  -H 'Content-Type: application/json' \
  -d '{"scale":1.2}'

curl "$BASE/api/network"
curl -X POST "$BASE/api/network" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}'
```

### Location And Routes

Location control uses the Android Emulator `geo fix` command and is currently emulator-only.

```sh
curl "$BASE/api/location"
curl -X POST "$BASE/api/location" \
  -H 'Content-Type: application/json' \
  -d '{"latitude":37.5665,"longitude":126.978}'
```

Start route playback from waypoints:

```sh
curl -X POST "$BASE/api/route" \
  -H 'Content-Type: application/json' \
  -d '{"speedKph":30,"multiplier":1,"loop":false,"waypoints":[{"latitude":37.5665,"longitude":126.978},{"latitude":37.5651,"longitude":126.98955}]}'
```

Read, pause, resume, or stop playback:

```sh
curl "$BASE/api/route"
curl -X POST "$BASE/api/route/control" \
  -H 'Content-Type: application/json' \
  -d '{"action":"pause"}'
curl -X DELETE "$BASE/api/route"
```

### Sessions

REST and WebSocket input events are recorded by default. Add `"record":false` to supported input payloads when an event should not be saved.

```sh
curl "$BASE/api/session"
curl -X POST "$BASE/api/session/replay" \
  -H 'Content-Type: application/json' \
  -d '{"multiplier":2}'
curl -X POST "$BASE/api/session/replay/stop"
curl -X DELETE "$BASE/api/session"
```

### Apps And Files

```sh
curl -X POST "$BASE/api/apps/install" \
  -F apk=@/path/to/app.apk

curl -X POST "$BASE/api/apps/launch" \
  -H 'Content-Type: application/json' \
  -d '{"packageName":"com.example.app","activity":".MainActivity"}'

curl -X POST "$BASE/api/apps/clear" \
  -H 'Content-Type: application/json' \
  -d '{"packageName":"com.example.app"}'

curl -X POST "$BASE/api/apps/force-stop" \
  -H 'Content-Type: application/json' \
  -d '{"packageName":"com.example.app"}'

curl -X POST "$BASE/api/apps/grant" \
  -H 'Content-Type: application/json' \
  -d '{"packageName":"com.example.app","permission":"android.permission.POST_NOTIFICATIONS"}'

curl -X POST "$BASE/api/files/import" \
  -F file=@/path/to/image.png
```

## WebSocket API

Connect to `/ws` for the raw Annex-B H.264 stream. Send JSON control messages over the same socket:

```json
{"type":"tap","x":0.5,"y":0.5}
{"type":"swipe","x1":0.5,"y1":0.8,"x2":0.5,"y2":0.2,"durationMs":350}
{"type":"text","text":"hello"}
{"type":"key","keycode":66}
{"type":"key","keycode":29,"metaState":4096}
{"type":"key","keycode":20,"action":"down"}
{"type":"back"}
{"type":"reset-video"}
```

Use `/ws?frame-meta=1` to receive a 24-byte `SEMU` v2 frame metadata header before each H.264 access unit: magic `SEMU` (4B), version=2 (1B), flags (1B, bit 0 = keyframe), reserved (2B), PTS (8B BE, µs), and the server send time (8B BE, epoch µs). Same-host clients can compare the send time against their own clock to measure transit and glass-to-glass latency. The bundled UI uses this mode to avoid per-frame NAL scans and to track PTS/keyframe/latency state.

## How It Works

```text
+------------------+ adb forward  +-------------+  H.264 / WS   +---------+
| scrcpy-server.jar| <----------> | serve-emul  | ------------> | Browser |
| on device        | TCP tunnel   |   (Bun)     |  WebCodecs    | <canvas>|
|  - video socket  |              |             | <------------ |         |
|  - control socket|              |             |  input JSON   |         |
+------------------+              +-------------+               +---------+
```

1. The CLI pushes `scrcpy-server-v4.0` to `/data/local/tmp/scrcpy-server.jar`.
2. It opens `adb forward tcp:<localPort> localabstract:scrcpy_<scid>`.
3. It spawns `app_process` with the scrcpy server class on the device, then connects video and control sockets through the tunnel.
4. The Bun server reads scrcpy's framed H.264 stream and forwards each access unit as a binary WebSocket message. Raw `/ws` clients receive Annex-B payloads unchanged; the built-in browser UI opts into the 24-byte frame metadata header.
5. The browser configures a `VideoDecoder` from SPS/PPS data and draws decoded frames to a `<canvas>`. Pointer events are normalized to unit coordinates and encoded as scrcpy control socket packets.

## Development

```sh
bun install
bun run --filter serve-emul setup
bun run --filter serve-emul dev
bun run --filter serve-emul typecheck
bun run --filter serve-emul typecheck:ui
bun run --filter serve-emul build
```

For runtime or protocol changes, test with a booted emulator or device:

```sh
adb devices
bun run packages/serve-emul/src/cli.ts
```

Useful manual checks include first video frame, browser refresh recovery, multiple tabs, tap/swipe/text/key input, screenshots, logcat SSE, app management, location, route playback, and session replay.

## Package Rename

The npm package name is `serve-emul`. npm package names cannot be renamed in place, so releases under this name should be published as a new package:

```sh
npm publish --workspace packages/serve-emul
npm deprecate serve-emu "Package renamed to serve-emul. Use: npm install serve-emul"
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development setup, validation steps, scrcpy protocol notes, and pull request guidelines.

## License

Apache-2.0. Bundles the upstream [scrcpy](https://github.com/Genymobile/scrcpy) server binary (Apache-2.0) at runtime.
