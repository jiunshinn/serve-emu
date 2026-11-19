# Streaming FPS investigation

**Date:** 2026-10-02 · **Status:** findings and repro scripts; no product code changed.

Prompted by a report that streaming FPS was "way too slow" on the `pixel_fold`
AVD, and by the question of whether to move to WebRTC, gRPC, or a scrcpy
replacement.

## Summary

- **The current pipeline is not the bottleneck.** With one serve-emu session
  per emulator, scrcpy → WebSocket → WebCodecs delivered ~60 fps at stream
  sizes up to 920×2048, and the browser drew most of it with single-digit
  millisecond latency.
- **The slow streams had two causes around it:**
  1. Several serve-emu servers encoding the same emulator. Two sessions cut
     each stream to about a third (60 → 17–21 fps).
  2. The recovery watchdog restarting scrcpy's capture every few seconds
     whenever the screen is static and a viewer is connected.
- **The emulator's own gRPC frame stream is a viable emulator-only source.**
  `streamScreenshot` held 60 fps at native 1080×2400 with no dropped frames,
  and VideoToolbox encodes the Fold's native 2208×1840 at ~100 fps.
- **WebRTC would not raise FPS on localhost.** Transit over the existing
  WebSocket was 0.4 ms.

## Environment

| | |
| --- | --- |
| Host | Apple M1 Max, 10 cores, 32 GB |
| Emulator | 36.6.11.0, `-gpu host` |
| System image | `android-37.1` `google_apis_playstore_ps16k` arm64 (Android 17) |
| AVDs | `pixel_fold`: 2208×1840, two displays. `Pixel8a_API34`: 1080×2400. Both 4 vCPUs. |
| scrcpy server | 4.0 (vendored). serve-emu defaults: max-size 1280, 8 Mbps, max-fps 60. |
| Guest video encoders | Software only: `c2.android.avc.encoder` (H.264); HEVC and AV1 are software too. |

## Method

- **Load:** [`scroll-page.html`](scroll-page.html), opened in Chrome on the
  emulator, scrolls a long list every animation frame. Its corner HUD shows the
  page's own frame rate, which separates slow guest rendering from slow
  capture. It held 60 fps on an idle emulator.
- **Source FPS:** [`measure-source-fps.ts`](measure-source-fps.ts) reads
  serve-emu's cumulative `/health` frame counter over 10 s with no viewer
  attached.
- **Watchdog behavior:** [`count-ws-frames.ts`](count-ws-frames.ts) connects
  like the UI and counts frames per second while the screen is static.
- **Browser:** [`probe-ui-fps.ts`](probe-ui-fps.ts) samples the bundled UI's
  status bar in headless Chromium.
- **gRPC source:** [`measure-grpc-fps.ts`](measure-grpc-fps.ts) streams
  `EmulatorController/streamScreenshot` through shared memory (MMAP) and uses
  the emulator's per-frame timestamps.
- **Host encoder:** ffmpeg `h264_videotoolbox` (`-realtime 1 -bf 0`) on raw
  NV12 frames.

## Results

### Current pipeline, one session

Pixel8a, warmed up, no viewer attached:

| Stream size | Avg fps | Interval p95 | Max interval |
| --- | --- | --- | --- |
| 576×1280 (default max-size 1280) | 60.1 | 20 ms | 31 ms |
| 864×1920 (max-size 1920) | 60.0 | 21 ms | 28 ms |
| 920×2048 (max-size 0) | 59.8 | 22 ms | 75 ms |

The first run, about a minute after boot, measured 48.8 fps at 576×1280 while
the guest was still busy. Later runs held 60.

### Several sessions on one emulator

| Setup | Avg fps per stream | Interval p95 | Max interval |
| --- | --- | --- | --- |
| Pixel8a, 2 serve-emu sessions | 17.1 / 20.8 | 143 / 125 ms | 440 / 344 ms |
| `pixel_fold` (1228×1024), 2 sessions | 5.7 | 91 ms | 3.1 s |
| `pixel_fold`, same 2 sessions after a viewer attached and resets began | 0.2 / 0.2 | 2.9 s | 8.7 / 10.4 s |

On `pixel_fold`:

- **Guest rendering slowed too.** The scroll page fell from 60 to 7 fps.
- **Memory grew.** qemu's resident memory reached 9.8 GB, up from 5.6 GB.
- **No single guest thread was saturated.** Each H.264 encoder thread used
  8–16% of a core, and SurfaceFlinger's RenderEngine used 22%. The cost appears
  to be per-frame stalls in the guest capture path rather than encoder CPU.

How the extra sessions got there:

- An orphaned `serve-emu --avd pixel_fold`, started 8 days earlier, attached
  when the AVD booted.
- A second agent started its own server on the same emulator.

serve-emu does not check whether a device is already being streamed.

### Watchdog resets on a static screen

With one viewer connected and the home screen static, the server requested 7
video resets in 30 s, all with reason "video source stalled". The client
received this many frames per second:

```text
10,4,0,0,8,3,0,0,9,2,0,0,8,8,0,0,0,8,3,0,0,8,3,0,0,8,3,0,0
```

Each reset produces a short burst, then 2.5 s of silence, then another reset.
A later re-run counted 7 resets in 20 s.

Cause: the emulator emits no frames while the screen is unchanged. But
`SessionRecoveryWatchdog.tick()` in
[`session-recovery-watchdog.ts`](../../packages/serve-emu/src/session-recovery-watchdog.ts)
treats 2.5 s without a frame as a stall whenever any client is connected. The
threshold is `SOURCE_STALL_RESET_MS` in
[`server.ts`](../../packages/serve-emu/src/server.ts).

The effect depended on contention:

- **Contended `pixel_fold`:** one server reached 51 resets, and another reached
  15 before scrcpy exited with code 255.
- **Uncontended Pixel8a:** a single session returned to 60 fps after the
  resets.

### Browser

Pixel8a, one session, same 10 s window:

- **Server:** received 59.6 fps.
- **UI:** drew 48–60 fps, mostly 53–58.

Status-bar detail from an earlier probe run on the same setup:

| Metric | Value |
| --- | --- |
| Transit | 0.4 ms |
| Estimated server→canvas | 6.9 ms |
| Decode p95 | 1.8 ms |
| Presentation wait p95 | 16.8 ms |
| Decode queue | 0 |
| Recoveries | 0 |

The gap comes from the worker drawing only the newest decoded frame each
animation frame. Two frames arriving within one 16.7 ms interval show as one.
These numbers are from headless Chromium, which paces at 60 Hz; a headed
browser on a 120 Hz display coalesces fewer frames.

### Alternative source: emulator gRPC + host encoder

| Measurement | Result |
| --- | --- |
| `streamScreenshot` RGB888 via MMAP, 576×1280 | 60.0 fps, p95 17.9 ms, max 24 ms, 0 seq gaps |
| `streamScreenshot` RGB888 via MMAP, native 1080×2400 | 59.7 fps, p95 17.7 ms, max 44 ms, 0 seq gaps |
| VideoToolbox H.264 from raw NV12, 2208×1840 | ~102 fps |
| VideoToolbox H.264 from raw NV12, 1228×1024 | ~160 fps |

The VideoToolbox numbers include ffmpeg reading raw frames from disk.

This experiment did not measure the chained gRPC → VideoToolbox path cleanly.
The one attempt ran while other emulators loaded the host and the guest itself
had dropped to ~5 fps.

A separate capture-lab prototype measured the full chain at 864×1920. That lab
is the uncommitted `experiments/native-capture`, built in parallel. Its chain
was emulator framebuffer → gRPC → host H.264 → production player. Results:

- 60 rendered, source, and encoded fps
- decode p95 1.6 ms
- presentation wait p95 3.9 ms
- 0 recoveries
- 43 source drops (its own counter, not defined here)

## What this means for the options

- **WebSocket:** keep it. It is not the bottleneck on localhost.
- **WebRTC:** no FPS gain on localhost. It helps over real networks
  (congestion control, loss recovery, adaptive bitrate) and is a large
  addition to a Bun server. Revisit only for remote viewing.
- **gRPC emulator source:** the largest available upgrade for emulators:
  native resolution at the display rate, no encoding inside the guest, and no
  sensitivity to guest load. Encode on the host and the browser pipeline stays
  unchanged. Costs:
  - the emulator must run with `-grpc` and token auth;
  - the host encoder is platform-specific (VideoToolbox, VAAPI, NVENC, or a
    software fallback);
  - raw frames are large, about 470 MB/s at 1080×2400 RGB888 and 60 fps
    (shared memory avoids most copies);
  - the MMAP buffer can tear without synchronization.

  It is emulator-only: physical devices keep scrcpy, and input can stay on
  scrcpy's control socket.
- **Replacing scrcpy:** not supported by the data. scrcpy reaches 60 fps when
  it is the only session. It also remains the right path for physical devices,
  which have hardware encoders.

## Recommended follow-ups

1. **Single-session guard.** Refuse or warn when the device already runs a
   scrcpy server, and point to the existing serve-emu instance when it is known.
2. **No stall resets on static screens.** Reset only when a client is waiting
   for a keyframe, or back off between attempts.
3. **Opt-in emulator source.** Prototype gRPC `streamScreenshot` → host H.264,
   keeping scrcpy for physical devices and for control.
4. **Optional smooth pacing.** Add a frame-pacing mode in the UI that presents
   queued frames in order, at about one frame of added latency.

## Side findings

- **Corrupt screenshots on multi-display AVDs.** `/api/screenshot` returns a
  corrupt PNG on AVDs such as `pixel_fold`. `screencapPng()` in
  [`adb.ts`](../../packages/serve-emu/src/adb.ts) runs `screencap -p` without
  `-d`, and screencap writes a "Multiple displays were found" warning to
  stdout ahead of the PNG.
- **Unexpected scrcpy stream sizes.** On `pixel_fold`, scrcpy chose 1228×1024
  for `max_size=1280` instead of the expected ~1280×1066. With `max_size=0`
  on Pixel8a it capped at 920×2048. Not investigated.
- **One emulator crash.** One validation emulator crashed (SIGSEGV on its
  `GLImageWork` thread) seconds after a `streamScreenshot` request with a 0×0
  ("native") size. Every run with explicit sizes was stable, so
  `measure-grpc-fps.ts` requires them. The crash was not reproduced.

## Caveats

- **`pixel_fold` was never measured with a single clean session.** Another
  agent was using it. Pixel8a held 60 fps at 920×2048, more pixels than
  `pixel_fold`'s 1228×1024 stream, so resolution alone is unlikely to explain
  6 fps there. That is not proven.
- **Narrow scope.** One machine, one emulator version, one scrcpy version.
  Other agents' emulators shared the host during some runs; the clean numbers
  above come from runs without that contention.
- **Busier-host re-run.** When the scripts were re-run on a busier host to
  validate them, scrcpy measured 50 fps at 576×1280 and gRPC 59 fps at native
  1080×2400. Conditions were not controlled, so treat that only as a hint that
  the host-side path tolerates contention better.

## Reproducing

Prerequisites:

- Android SDK emulator and adb
- Bun
- `grpcurl`, for the gRPC measurement
- ffmpeg with VideoToolbox, for the encoder measurement
- Playwright's Chromium, for the UI probe: run `bunx playwright install
  chromium` in `packages/serve-emu`

Each emulator uses 4–10 GB of memory. Run one at a time and tear down between
runs.

1. Boot an emulator with gRPC enabled, read-only so the AVD is not modified:

   ```sh
   emulator -avd Pixel8a_API34 -read-only -no-snapshot-save -port 5558 -gpu host -grpc 8558 -grpc-use-token
   ```

   The log prints `Advertising in: …/pid_<pid>.ini`. That discovery file holds
   the gRPC port and token.

2. Serve the load page and open it in Chrome on the emulator. The emulator
   reaches the host as `10.0.2.2`. Skipping Chrome's first-run screens needs
   the debug-app setting, which a read-only AVD discards on exit.

   ```sh
   python3 -m http.server 8765 --bind 127.0.0.1 --directory experiments/fps-investigation
   adb -s emulator-5558 shell 'echo "_ --disable-fre --no-default-browser-check --no-first-run" > /data/local/tmp/chrome-command-line'
   adb -s emulator-5558 shell am set-debug-app --persistent com.android.chrome
   adb -s emulator-5558 shell am start -a android.intent.action.VIEW -d http://10.0.2.2:8765/scroll-page.html com.android.chrome
   ```

   Dismiss Chrome's notification prompt if it appears. Give the guest about a
   minute after boot before measuring.

3. Start serve-emu against the emulator, then measure from
   `experiments/fps-investigation`:

   ```sh
   bun run packages/serve-emu/src/cli.ts -s emulator-5558 -p 3312
   bun measure-source-fps.ts 3312 10
   bun probe-ui-fps.ts 3312 15
   bun measure-grpc-fps.ts <pid_*.ini> 1080 2400 10
   ```

4. **Contention:** start a second server on the same emulator (`-p 3313`). Run
   `measure-source-fps.ts` against both ports at the same time.

5. **Reset storm:** press Home so the screen is static, then:

   ```sh
   bun count-ws-frames.ts 3312 30
   ```

6. **Host encoder:**

   ```sh
   ffmpeg -f lavfi -i testsrc2=size=2208x1840:rate=60 -frames:v 120 -f rawvideo -pix_fmt nv12 -y raw.yuv
   time ffmpeg -f rawvideo -pix_fmt nv12 -s 2208x1840 -r 60 -stream_loop 4 -i raw.yuv \
     -c:v h264_videotoolbox -realtime 1 -bf 0 -b:v 8M -f h264 -y out.h264
   ```

   600 frames divided by the elapsed time gives the encode rate.
