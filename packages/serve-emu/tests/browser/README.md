# Browser streaming tests

Run `bunx playwright install chromium` once, then
`bun run --filter serve-emu test:browser` from the repository root.

The suite builds the production UI and runs the real Bun server and WebSocket
handlers. Only the scrcpy/device transport is replaced: `FakeEncoder`
(`fake-encoder.ts`) streams a real H.264 GOP as scrcpy v4 packets, which the
production `FramedReader`/`readFrame` parse as they would for a real device. It
answers `reset-video` packets with a new session and key frame, and its key
frame interval can be changed per test through `/__test/control`. Chromium
decodes the stream with WebCodecs, renders it through OffscreenCanvas, and the
tests check the rendered pixels. Other cases cover refresh, late joiners,
two-tab session switches, pointer ownership and disconnect release, input-error
delivery to React, tool panels across device switches, hidden-tab polling, and
latency recovery with a stalled decoder injected only into the test Worker.

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
