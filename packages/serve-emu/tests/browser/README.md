# Browser streaming tests

Run `bunx playwright install chromium` once, then
`bun run --filter serve-emu test:browser` from the repository root.

The suite builds the production UI and runs the real Bun server and WebSocket
handlers. Only the scrcpy/device transport is deterministic. Chromium decodes a
real Annex-B H.264 fixture with WebCodecs, renders it through OffscreenCanvas,
and verifies the rendered pixels. Other cases cover refresh, two-tab session
switches, pointer ownership/disconnect release, input-error delivery to React,
and latency recovery with a stalled decoder injected only into the test Worker.
The device overview cases also verify independent red/blue device previews,
unavailable-device handling, switching to control,
refresh, shared previews across tabs, and stream cleanup.
Synchronized QA cases capture the emitted scrcpy packets to verify source-only,
all-device, and selected-device targeting; coordinate scaling between 64×64 and
128×96 screens; text and hardware keys; per-device errors; and touch release
when targets change or one of multiple controlling tabs closes.
Element-matching cases use native accessibility viewports ten times the streamed
resolution, with the same labeled controls at different positions. They verify
resource-ID disambiguation, fresh snapshots, all-target rejection for missing or
ambiguous matches, pending-request exclusion, and position-based swipes.

The fixture server binds loopback port 33117 and is stopped by Playwright. Its
`/__test/*` endpoints live only in this test file; tests are not packaged. Unit
and server route tests remain under Bun (`bun test`); `.pw.ts` files run only
under Playwright. CI installs Chromium and preserves traces/screenshots on failure.

`red-frame.h264` and `blue-frame.h264` are generated 64×64 solid-color IDR
frames, with no third-party content. Regenerate with FFmpeg (substitute `blue`
for both occurrences of `red` for the blue fixture):

```sh
ffmpeg -f lavfi -i color=c=red:s=64x64:r=10 -frames:v 1 \
  -c:v libx264 -profile:v baseline -tune zerolatency -pix_fmt yuv420p \
  -f h264 red-frame.h264
```

`blue-large-frame.h264` uses the same command with `color=c=blue:s=128x96:r=10`
to verify normalized inputs across devices with different screen dimensions.
