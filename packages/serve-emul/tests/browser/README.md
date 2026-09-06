# Browser streaming tests

Run `bunx playwright install chromium` once, then
`bun run --filter serve-emul test:browser` from the repository root.

The suite builds the production UI and runs the real Bun server and WebSocket
handlers. Only the scrcpy/device transport is deterministic. Chromium decodes a
real Annex-B H.264 fixture with WebCodecs, renders it through OffscreenCanvas,
and verifies the rendered pixels. Other cases cover refresh, two-tab session
switches, pointer ownership/disconnect release, input-error delivery to React,
and latency recovery with a stalled decoder injected only into the test Worker.

The fixture server binds loopback port 33117 and is stopped by Playwright. Its
`/__test/*` endpoints live only in this test file; tests are not packaged. Unit
and server route tests remain under Bun (`bun test`); `.pw.ts` files run only
under Playwright. CI installs Chromium and preserves traces/screenshots on failure.

`red-frame.h264` is a generated 64×64 solid-red IDR frame, with no third-party
content. Regenerate with FFmpeg:

```sh
ffmpeg -f lavfi -i color=c=red:s=64x64:r=10 -frames:v 1 \
  -c:v libx264 -profile:v baseline -tune zerolatency -pix_fmt yuv420p \
  -f h264 red-frame.h264
```
