# serve-emu Agent Notes

`serve-emu` is a Bun workspace package that streams an Android emulator or device through scrcpy, forwards H.264 over WebSockets, and decodes it in the browser with WebCodecs. Optimize changes for low latency, protocol correctness, and agent-friendly control APIs.

## Project Layout

- Root scripts delegate to the `serve-emu` workspace package.
- Main package: `packages/serve-emu`.
- CLI entry point: `packages/serve-emu/src/cli.ts`.
- HTTP entry point, access-control gate, WebSocket handlers, and `/health`: `packages/serve-emu/src/server.ts`.
- REST API routes: `packages/serve-emu/src/api/routes/*`, dispatched by `src/api/router.ts`; errors in `src/api/api-error.ts`.
- API routes and their methods: the `ApiRoute` lists in `src/api/routes/*`, collected by `src/api/routes/index.ts`; `src/api/router.ts` answers other methods with 405 and `Allow`. Request body limits (`MAX_*_BYTES`): `src/server.ts`. Slow-client frame decisions: `src/server/backpressure.ts`.
- Wire contracts shared by server and UI (API responses, control, frame metadata, WebSocket, worker messages): `packages/serve-emu/src/shared`.
- scrcpy process, adb forward tunnel, socket setup, and frame parsing: `packages/serve-emu/src/scrcpy.ts`.
- scrcpy control socket message encoding for taps, swipes, keys, text, and video reset: `packages/serve-emu/src/input.ts`.
- Android emulator discovery, launch, and host webcam/camera helpers: `packages/serve-emu/src/emulator.ts`.
- ADB helpers: `packages/serve-emu/src/adb.ts`.
- App install/launch/clear/grant/import helpers: `packages/serve-emu/src/app-management.ts`.
- Location and route playback: `packages/serve-emu/src/location.ts` and `packages/serve-emu/src/route-playback.ts`.
- Session recording/replay: `packages/serve-emu/src/session-recorder.ts`.
- React UI: `packages/serve-emu/src/ui`.
- Vendored scrcpy downloader and pinned version: `packages/serve-emu/scripts/fetch-scrcpy.ts`.

Prefer kebab-case for TypeScript and JavaScript filenames.

## Common Commands

```sh
bun install
bun run --filter serve-emu setup
bun run packages/serve-emu/src/cli.ts
bun run dev
bun run --filter serve-emu dev:ui
bun run --filter serve-emu test
bun run --filter serve-emu coverage
bun run --filter serve-emu typecheck
bun run --filter serve-emu typecheck:ui
bun run --filter serve-emu typecheck:tests
bun run --filter serve-emu build
bun run --filter serve-emu test:package
bun run --filter serve-emu test:browser
bun run docs:sync
bun run docs:check
bun run check
```

`setup` downloads the pinned scrcpy server into
`packages/serve-emu/vendor/` and builds the browser UI. The CLI also runs the
scrcpy setup lazily on first start.

`test:browser` runs the Playwright streaming suite in `tests/browser`; run
`bunx playwright install chromium` once first. The root `README.md` is
canonical: `packages/serve-emu/README.md` is generated from it, so edit the root
file and run `docs:sync`.

## Runtime Assumptions

- Bun is the primary runtime. Keep server-side code compatible with Bun APIs such as `Bun.serve`, `Bun.argv`, and `ServerWebSocket`.
- The package is ESM. Server-side code uses explicit `.ts` extensions for local TypeScript imports; `src/ui` and `src/shared` are also bundled by Vite and import without extensions. Follow the style of the directory you are in.
- Default device selection should remain the only booted device. If multiple devices are connected, require or pass `-s <serial>`.
- Do not shell out to `adb shell input` for input events. Write directly to scrcpy's control socket via `src/input.ts`; this keeps latency low enough for agent workflows.
- Location control is emulator-only and uses Android Emulator `geo fix`.
- WebCodecs support matters for the bundled UI, so test streaming changes in a browser that supports it.

## scrcpy Protocol Notes

The canonical [protocol reference](packages/serve-emu/docs/protocol.md) is the
source of truth for scrcpy v3/v4 framing, control packets, `SEMU` metadata,
golden bytes, and the scrcpy upgrade checklist. The server version remains
pinned in `packages/serve-emu/scripts/fetch-scrcpy.ts`; update that marker, the
reference, and parser fixtures together whenever it changes.

Keep protocol-sensitive behavior low-latency and join-safe: detect the video
preamble alignment, bound packet and reader sizes, cache SPS/PPS configuration
for key frames, and encode input directly onto the control socket. Do not add a
second byte-layout description here that can drift from the tested reference.

## Server and API Guidance

- Keep HTTP API inputs bounded. Follow existing `MAX_*_BYTES` limits and explicit payload validation patterns.
- To add an endpoint, add an `ApiRoute` (path, method, handler) to the matching module under `src/api/routes/`, add its wrong-method case to the HTTP-surface table in `tests/server-request-gates.test.ts`, add a response parser to `src/shared/api-contracts.ts` for the UI client, and exercise it against a real response in `tests/api-contracts-live.test.ts`. Server payload types (session, route, location, logcat events, `/health`) come from `src/shared`, so a shape change must update the contract.
- Gesture API coordinates are normalized unit values from `0` to `1`; convert to screen pixels only in `compileGesture` (`src/input.ts`), which the control queue calls.
- Preserve session recording behavior. REST and WebSocket actions should record by default unless payloads explicitly set `record: false`.
- For slow WebSocket clients, keep the backpressure strategy: drop until the next keyframe, request video reset with cooldown, and close clients with excessive buffered bytes.
- Maintain `/health` as the best machine-readable snapshot for agents: include status, stream metadata, client metrics, route/session state, and last error details when relevant.
- API failures are structured JSON with `ok: false` and a stable code from `API_ERROR_CODES`. In routes, throw `ApiError` (`src/api/api-error.ts`) rather than building raw responses; keep its message free of command output or other internal details, and pass the original error as `cause`.
- Access control lives in `server.ts` (the `fetch` gate) and `cli.ts` (policy). Defaults bind to loopback (`DEFAULT_HOST`); non-loopback binds require a token unless `--unsafe-no-auth`. Every request passes the token gate when auth is on (bearer header, `semu_session` HttpOnly cookie, or `?token=`); WS upgrades and non-GET requests also require a matching `Origin`. Without a token, only rebinding-safe `Host` names are served (IP literals, `localhost`, `--host`, `--allowed-host`), and cross-site requests other than navigations to the UI are rejected via Fetch Metadata; the pure policy lives in `src/server/request-policy.ts`. The browser bootstraps by exchanging a `?token=` URL for the cookie, so the bundled UI needs no per-request token wiring. Never leak the token into `/health`, `/api`, error bodies, or reconnect URLs, and keep new endpoints behind the same gate (it runs before routing, so new routes are covered automatically).

## UI Guidance

- The UI lives under `packages/serve-emu/src/ui` and is built by Vite.
- The stream pipeline (WebSocket → WebCodecs decode → present) runs in a Worker: `src/ui/lib/stream-worker.ts`, with state in `stream-lifecycle.ts` and latency tracking in `stream-performance.ts`. `src/ui/lib/use-stream.ts` is the React hook that owns the worker; keep decode work off the main thread. H.264 helpers live in `src/ui/lib/h264.ts`.
- Device controls should call the local REST/WebSocket APIs instead of duplicating server-side adb or scrcpy logic in the UI.
- When changing the stream protocol or any wire message, change the shared contract in `src/shared` (for example `frame-meta.ts`) rather than separate server and UI copies.

## Validation

Run the aggregate check before handing off a change:

```sh
bun run check
```

`check` also enforces per-file line-coverage floors from
`scripts/check-coverage.ts` on critical files such as `server.ts`, `scrcpy.ts`,
and `input.ts`; add tests rather than lowering a floor.

`check` also runs `check:unused:prod` (`knip --production --include files`),
which fails when a source file is reachable only from tests. Wire a new module
into the CLI, server, UI, or a worker, or delete it, rather than adding it to
the `ignore` list in `knip.jsonc`. It also runs `check:unused` (`knip`), which
fails on unused exports: export a value only when another module imports it,
and do not add production code that only tests call.

For runtime or protocol changes, also test manually with a booted emulator or device:

```sh
adb devices
bun run packages/serve-emu/src/cli.ts
```

Verify relevant flows: first video frame, browser refresh recovery, multiple tabs, tap/swipe/text/key input, `/api/screenshot`, changed REST APIs, logcat SSE, app management, location, route playback, session replay, and `--avd` camera flags when touched.
