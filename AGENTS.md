# serve-emul Agent Notes

`serve-emul` is a Bun workspace package that streams an Android emulator or device through scrcpy, forwards H.264 over WebSockets, and decodes it in the browser with WebCodecs. Optimize changes for low latency, protocol correctness, and agent-friendly control APIs.

## Project Layout

- Root scripts delegate to the `serve-emul` workspace package.
- Main package: `packages/serve-emul`.
- CLI entry point: `packages/serve-emul/src/cli.ts`.
- HTTP, WebSocket, health, and REST APIs: `packages/serve-emul/src/server.ts`.
- scrcpy process, adb forward tunnel, socket setup, and frame parsing: `packages/serve-emul/src/scrcpy.ts`.
- scrcpy control socket message encoding for taps, swipes, keys, text, and video reset: `packages/serve-emul/src/input.ts`.
- Android emulator discovery and launch helpers: `packages/serve-emul/src/emulator.ts`.
- ADB helpers: `packages/serve-emul/src/adb.ts`.
- App install/launch/clear/grant/import helpers: `packages/serve-emul/src/app-management.ts`.
- Location and route playback: `packages/serve-emul/src/location.ts` and `packages/serve-emul/src/route-playback.ts`.
- Session recording/replay: `packages/serve-emul/src/session-recorder.ts`.
- React UI: `packages/serve-emul/src/ui`.
- Vendored scrcpy downloader and pinned version: `packages/serve-emul/scripts/fetch-scrcpy.ts`.

Prefer kebab-case for TypeScript and JavaScript filenames.

## Common Commands

```sh
bun install
bun run --filter serve-emul setup
bun run packages/serve-emul/src/cli.ts
bun run dev
bun run --filter serve-emul dev:ui
bun run --filter serve-emul typecheck
bun run --filter serve-emul typecheck:ui
bun run --filter serve-emul build
```

`setup` downloads the pinned scrcpy server into `vendor/` and builds the browser UI. The CLI also runs the scrcpy setup lazily on first start.

## Runtime Assumptions

- Bun is the primary runtime. Keep server-side code compatible with Bun APIs such as `Bun.serve`, `Bun.argv`, and `ServerWebSocket`.
- The package is ESM. Use explicit `.ts` extensions for local TypeScript imports, following the existing style.
- Default device selection should remain the only booted device. If multiple devices are connected, require or pass `-s <serial>`.
- Do not shell out to `adb shell input` for input events. Write directly to scrcpy's control socket via `src/input.ts`; this keeps latency low enough for agent workflows.
- Location control is emulator-only and uses Android Emulator `geo fix`.
- WebCodecs support matters for the bundled UI, so test streaming changes in a browser that supports it.

## scrcpy Protocol Notes

Streaming runs through the vendored scrcpy server (`vendor/scrcpy-server-v<VERSION>`). The version is pinned in `packages/serve-emul/scripts/fetch-scrcpy.ts`. The wire protocol drifts between scrcpy majors, so bumping the version requires re-validating `packages/serve-emul/src/scrcpy.ts` and `packages/serve-emul/src/input.ts`.

Current server protocol shape:

- Open two sockets through `adb forward tcp:<port> localabstract:scrcpy_<scid>`.
- Both sockets may include a 1-byte dummy prefix; `src/scrcpy.ts` detects video preamble alignment instead of assuming one fixed offset.
- The video socket yields a 64-byte device name, then 12 bytes of codec metadata: codec id, width, height, all big-endian.
- Frames are `[8B PTS BE, 4B size BE, N B Annex-B NALUs]`.
- PTS high bits mark config and key frames. Keep `PACKET_FLAG_CONFIG` and `PACKET_FLAG_KEY_FRAME` handling in sync with scrcpy.
- Cache SPS/PPS config packets and prepend them to keyframes so clients joining mid-stream can initialize their decoder.
- Control socket packets are binary messages described in `packages/serve-emul/src/input.ts`.

## Server and API Guidance

- Keep HTTP API inputs bounded. Follow existing `MAX_*_BYTES` limits and explicit payload validation patterns.
- Gesture API coordinates are normalized unit values from `0` to `1`; convert to screen pixels only in `dispatch`.
- Preserve session recording behavior. REST and WebSocket actions should record by default unless payloads explicitly set `record: false`.
- For slow WebSocket clients, keep the backpressure strategy: drop until the next keyframe, request video reset with cooldown, and close clients with excessive buffered bytes.
- Maintain `/health` as the best machine-readable snapshot for agents: include status, stream metadata, client metrics, route/session state, and last error details when relevant.
- Prefer structured JSON errors with `ok: false` for API endpoints rather than throwing raw responses.
- Access control lives in `server.ts` (the `fetch` gate) and `cli.ts` (policy). Defaults bind to loopback (`DEFAULT_HOST`); non-loopback binds require a token unless `--unsafe-no-auth`. Every request passes the token gate when auth is on (bearer header, `semu_session` HttpOnly cookie, or `?token=`); WS upgrades and non-GET requests also require a matching `Origin`. The browser bootstraps by exchanging a `?token=` URL for the cookie, so the bundled UI needs no per-request token wiring. Never leak the token into `/health`, `/api`, error bodies, or reconnect URLs, and keep new endpoints behind the same gate (it runs before routing, so new routes are covered automatically).

## UI Guidance

- The UI lives under `packages/serve-emul/src/ui` and is built by Vite.
- Keep streaming decode logic in `src/ui/lib/use-stream.ts` and H.264 helpers in `src/ui/lib/h264.ts`.
- Device controls should call the local REST/WebSocket APIs instead of duplicating server-side adb or scrcpy logic in the UI.
- When changing the stream protocol, update both the server frame metadata writer and the UI reader together.

## Validation

Run the checks that match the touched area:

```sh
bun run --filter serve-emul typecheck
bun run --filter serve-emul typecheck:ui
bun run --filter serve-emul build
```

For runtime or protocol changes, also test manually with a booted emulator or device:

```sh
adb devices
bun run packages/serve-emul/src/cli.ts
```

Verify relevant flows: first video frame, browser refresh recovery, multiple tabs, tap/swipe/text/key input, `/api/screenshot`, changed REST APIs, logcat SSE, app management, location, route playback, and session replay when touched.
