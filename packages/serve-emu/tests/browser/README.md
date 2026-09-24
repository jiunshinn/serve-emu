# Browser streaming tests

Run `bunx playwright install chromium` once, then
`bun run --filter serve-emu test:browser` from the repository root.

The suite builds the production UI and runs the real Bun server and WebSocket
handlers. Only the scrcpy/device transport is replaced: `FakeEncoder`
(`fake-encoder.ts`) streams a real H.264 GOP as scrcpy v4 packets, which the
production `FramedReader`/`readFrame` parse as they would for a real device. It
answers `reset-video` packets with a new session and key frame; per test,
`/__test/control` can make it ignore resets or change its key frame interval. Chromium
decodes the stream with WebCodecs, renders it through OffscreenCanvas, and the
tests check the rendered pixels. Other cases cover refresh, late joiners,
two-tab session switches, pointer ownership and disconnect release, input-error
delivery to React, tool panels across device switches, hidden-tab polling, and
latency recovery with a stalled decoder injected only into the test Worker.
That decoder reports each key chunk it is given to `/__test/decoded`, so a
recovery that must end on a periodic key frame (resets ignored) can assert the
key frame was decoded rather than dropped.
The device overview cases also verify independent red/blue `/d/<serial>/` previews,
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

Playwright starts two fixture servers on loopback: one on `FIXTURE_PORT`
(default 33117, or `SERVE_EMU_FIXTURE_PORT`) and one on the next port that
requires the token from `fixture-env.ts` (`auth.pw.ts`). Their `/__test/*`
endpoints live only in `server-fixture.ts`; tests are not packaged. Unit and
server route tests remain under Bun (`bun test`); `.pw.ts` files run only under
Playwright. CI installs Chromium and preserves traces/screenshots on failure.

`gop-red-green.h264` is a generated 64×64 baseline GOP of 300 frames with a
single IDR: red for the first 15 frames and green after, so a green picture can
only come from decoding P frames. It has no third-party content. Regenerate it
with GStreamer and x264 by running `make-gop-fixture.sh`.

`blue-frame.h264` is a generated 64×64 solid-blue IDR frame, and
`blue-large-frame.h264` the same at 128×96, used to verify normalized inputs
across devices with different screen dimensions. Neither has third-party
content. Regenerate with FFmpeg (use `s=128x96` for the large frame):

```sh
ffmpeg -f lavfi -i color=c=blue:s=64x64:r=10 -frames:v 1 \
  -c:v libx264 -profile:v baseline -tune zerolatency -pix_fmt yuv420p \
  -f h264 blue-frame.h264
```
