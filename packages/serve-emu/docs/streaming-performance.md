# Streaming performance

Why emulator streams feel less smooth than
[serve-sim](https://github.com/EvanBacon/serve-sim)'s iOS Simulator streams,
which Android and emulator APIs can change that, and the recommended plan.

Research note from 2026-10-03. Measurements come from an Apple M1 Max
(10 cores, 32 GB) running Android Emulator 36.6.11 with `-gpu host`, an Android
17 arm64 system image, and the vendored scrcpy 4.0 server. Re-measure when any
of those change.

## Summary

- **The difference is where frames are encoded.** serve-sim reads the
  simulator's framebuffer on the Mac and encodes it with Apple's hardware
  encoder at native resolution. serve-emu runs scrcpy inside the Android VM.
  There, the only H.264 encoder is a software encoder with a hard size limit,
  and every frame is first copied from the host GPU into the VM.
- **Two serve-emu behaviors make it worse.** The recovery watchdog restarts the
  encoder on static screens, and nothing prevents two sessions from streaming
  one emulator.
- **The transport and the browser are not the bottleneck.** On localhost the
  WebSocket hop takes 0.4 ms, so WebRTC would not raise the frame rate.
- **Recommended direction:** keep scrcpy for input, physical devices, and other
  platforms. For emulators on macOS, capture frames on the host through the
  emulator's gRPC API and encode them with VideoToolbox.

## How each tool produces video

| | serve-sim (iOS Simulator) | serve-emu (Android Emulator) |
| --- | --- | --- |
| Where the app runs | macOS processes; rendering uses the host GPU directly | Inside a VM; GPU commands are relayed to the host GPU |
| Capture | A SimulatorKit frame callback provides the framebuffer IOSurface; one memory copy | scrcpy mirrors the screen to a second, virtual display inside Android |
| Encoder | VideoToolbox hardware H.264, High profile, low-latency rate control | `c2.android.avc.encoder`, a software encoder on the guest CPU |
| Resolution | Native | 576×1280 by default for a 1080×2400 screen; at most 920×2048 |
| Static screen | Re-encodes the last frame at 5 fps | No frames after about 1 s (see [Static screens](#static-screens-and-the-recovery-watchdog)) |
| Path to the browser | In-process helper → HTTP | Android's adb daemon → emulator pipe → adb server → TCP forward → Bun → WebSocket |

The iOS Simulator avoids a VM because iOS and macOS share a kernel, so
simulated apps run as ordinary Mac processes. Android needs a Linux kernel, so
on macOS it always runs in a VM.

## Why the in-VM path is limited

### The emulator has no hardware video encoder

AOSP emulator images declare hardware-backed **decoders** only
(`c2.goldfish.h264.decoder` and its HEVC, VP8, and VP9 siblings). Every encoder
is a software `c2.android.*` component. `c2.android.avc.encoder` declares:

| Limit | Value |
| --- | --- |
| Profile and level | Baseline, Level 4.1 |
| Size | at most 2048×2048 |
| Macroblocks per frame | at most 8,192 (2048×1024) |
| Macroblocks per second | at most 245,760 (about 1080p at 30 fps) |
| Bit rate | at most 12 Mbps |

scrcpy 4.0 clamps the capture size to these limits, which explains two sizes
seen during testing:

- **Pixel 8a (1080×2400), `max_size=0`:** the portrait limit is 1024×2048, so
  scrcpy produced 920×2048.
- **pixel_fold (2208×1840), `max_size=1280`:** the landscape limit is 2048×1024,
  so scrcpy produced 1228×1024 instead of about 1280×1066.

Native resolution is therefore impossible on this path. Anything above about
one megapixel at 60 fps also exceeds the encoder's declared throughput. That is
why `SCRCPY_DEFAULTS.maxSize` in [`scrcpy.ts`](../src/scrcpy.ts) is 1280. The
cost of that default is a softer picture than serve-sim's.

### Every frame does extra work inside the guest

For each mirrored frame:

1. SurfaceFlinger composites the screen a second time, into scrcpy's virtual
   display.
2. The software encoder locks that buffer for CPU access. The emulator's
   gralloc mapper then reads the pixels back from the host GPU
   (`readFromHost()` → `rcColorBufferCacheFlush` and `rcReadColorBufferDMA`).
3. The encoder converts RGBA to YUV in software (`ConvertRGBToPlanarYUV`).
4. libavc encodes the frame on up to four guest cores.
5. The bitstream crosses the guest's adb daemon and the emulator's adb pipe to
   reach the host.

All of this competes with the app for the same vCPUs. Even one session shows
uneven frame intervals, with a p95 of 20–22 ms and a maximum of up to 75 ms
where 16.7 ms is steady 60 fps. A second session makes it collapse, and it also
slows the app itself (see [Measurements](#measurements)).

### Static screens and the recovery watchdog

Android's `GraphicBufferSource` repeats the last frame at most 10 times
(`kRepeatLastFrameCount`). scrcpy asks for a repeat after 100 ms. A static
screen therefore produces about one second of frames, then silence.

[`session-recovery-watchdog.ts`](../src/session-recovery-watchdog.ts) treats
2.5 s without a frame as a stall whenever a client is connected
(`SOURCE_STALL_RESET_MS` in [`server.ts`](../src/server.ts)). It requests a video
reset, which produces a new keyframe burst, about a second of repeats, silence,
and then another reset. One viewer on a static home screen received these frame
counts per second, with 7 resets in 30 s:

```text
10,4,0,0,8,3,0,0,9,2,0,0,8,8,0,0,0,8,3,0,0,8,3,0,0,8,3,0,0
```

Silence is normal Android behavior here, not a stall. A larger
`--repeat-frame-ms` only stretches the burst, because the 10-repeat cap still
applies.

### Several sessions on one emulator

serve-emu does not check whether a device is already being streamed. An
orphaned `serve-emu --avd` process, or a second agent's server, attaches its own
scrcpy session. Each session repeats the composition, readback, and encoding
work described above.

## Measurements

Rates are per stream. The scrcpy rows used one session per emulator unless
noted. Sources: the FPS investigation
([#70](https://github.com/jiunshinn/serve-emu/pull/70)) and the native-capture
experiment ([#69](https://github.com/jiunshinn/serve-emu/pull/69)).

| Path | Stream size | Result |
| --- | --- | --- |
| scrcpy | 576×1280 | 60.1 fps; interval p95 20 ms, max 31 ms |
| scrcpy | 864×1920 | 60.0 fps; p95 21 ms, max 28 ms |
| scrcpy | 920×2048 | 59.8 fps; p95 22 ms, max 75 ms |
| scrcpy, two sessions on Pixel 8a | default | 17.1 and 20.8 fps; p95 143 and 125 ms |
| scrcpy, two sessions on pixel_fold, with resets | 1228×1024 | 5.7 fps, falling to 0.2 fps; the app's own frame rate fell from 60 to 7 fps |
| gRPC frames → VideoToolbox → browser | 864×1920 | 59.8 fps rendered |
| gRPC frames → VideoToolbox → browser | 1080×2400 | 56.7 fps rendered, minimum 52 |
| Browser, scrcpy stream | default | WebSocket transit 0.4 ms; decode p95 1.8 ms; server to canvas about 7 ms |
| VideoToolbox H.264 encode (ffmpeg, raw NV12) | 2208×1840 | about 102 fps |

The gRPC rows used the normal gRPC byte transport, and the frames were
displayed in the browser.

> [!WARNING]
> [#70](https://github.com/jiunshinn/serve-emu/pull/70) also reports 59.7 fps at
> 1080×2400 through gRPC shared memory (MMAP). That script counted frame
> notifications only and never checked pixels. The emulator 37.2.11 release
> notes (2026-09-29) say MMAP on Apple Silicon "crashes emulator engine /
> silently never writes frames", and the measurements used 36.6.11. Treat the
> MMAP result as unverified until it is re-measured on 37.2.11 or later with a
> per-frame pixel check.

## Options considered

| Option | Where frames are captured and encoded | Verdict |
| --- | --- | --- |
| MediaProjection (public API) | In the guest, with the same MediaCodec encoders | No gain. It also needs an installed app, user consent for every session on Android 14+, and a `mediaProjection` foreground service. |
| `screenrecord`, or scrcpy's display APIs | In the guest | Same limits as today. |
| **Emulator gRPC `EmulatorController.streamScreenshot`** | On the host, from the emulator's composited frame | **Recommended for emulators.** It sends a frame only when the display changes, and can scale server-side. It reports `seq` and `timestampUs` and offers a shared-memory transport. Android Studio's embedded emulator uses this RPC (RGB888, scaled to the view). |
| Emulator `-share-vid` flag | On the host, in POSIX shared memory `videmulator<port>` | No per-frame notification, so worse than gRPC. |
| Emulator WebRTC (video bridge) | On the host, software VP8 | Upstream's build enables it by default for Linux x86_64. Both RTC service versions returned `UNIMPLEMENTED` on 36.6.11 for Mac ARM. |
| Emulator `-vsync-rate` flag | Sets the guest refresh rate | A tuning knob, not a fix. |
| WebRTC instead of the WebSocket | Transport only | No localhost gain. Revisit only for remote viewing. |
| Physical Android devices | On the device, with its hardware encoder | scrcpy is already the right path. |

Google's own tools follow the same split. Android Studio shows emulators
through gRPC `streamScreenshot`. Its on-device MediaCodec agent is for device
mirroring, and when that agent targets an emulator, Studio caps the bit rate at
2 Mbps. Cuttlefish, Google's cloud Android VM, streams over WebRTC from
host-side capture.

## Can serve-emu avoid the VM?

Not for running Android on a Mac. Every option there is a VM: the Android
Emulator, Genymotion, and Docker-based images such as Redroid. Waydroid and
Redroid run Android in a container on a Linux host's own kernel. They need
binder support in that kernel and do not apply to macOS.

The VM itself is not what makes streaming slow. With `-gpu host`, the emulator
already draws every frame on the Mac's GPU, so the finished frame already
exists outside the VM. The in-VM capture in scrcpy re-composites that frame,
copies it back into the guest, and encodes it in software. Host capture takes
the frame the emulator already has:

| Job | Today | Proposed for macOS emulators |
| --- | --- | --- |
| Run Android and the app | VM | VM |
| Draw the screen | Host GPU | Host GPU |
| Capture | scrcpy, in the VM | Emulator gRPC, on the host |
| Encode | Software H.264, in the VM | VideoToolbox, on the host |
| Input | scrcpy control socket | scrcpy control socket with `video=false` |

## Recommended plan

### 1. Fix the current pipeline

- **Stop resetting on silence.** Request a video reset only when a client is
  waiting for a keyframe, with a cooldown. Do not reset only because frames
  stopped.
- **Allow one session per device.** Detect an existing serve-emu scrcpy session
  on the device, refuse or warn, and point to the existing server when known.

### 2. Add host capture for emulators on macOS

- **Launch:** for `--avd` launches, start the emulator with `-grpc <port>` and
  token or JWT authentication. Keep credentials out of `/health`, `/api`, logs,
  and URLs, following the existing access-control rules.
- **Capture:** call `streamScreenshot` at native size with MMAP transport on
  emulator 37.2.11 or later. Copy each frame out as soon as its message arrives,
  because the proto warns that MMAP can tear. Older emulators can use the byte
  transport, which costs 470–620 MB/s of copies at 1080×2400 and 60 fps.
- **Encode:** use a small Swift helper built on `VTCompressionSession`, modeled
  on serve-sim's encoder:
  - real-time mode with low-latency rate control and no frame reordering
    (serve-sim notes that without low-latency rate control the browser decoder
    buffers about 300 ms)
  - a forced keyframe when a viewer joins
  - an idle re-encode floor, such as 5 fps, so static screens never look
    stalled
- **Deliver:** feed encoded frames into the existing WebSocket and WebCodecs
  path. Update the [protocol reference](protocol.md) with any wire change.
- **Input:** keep scrcpy's control socket, starting scrcpy with `video=false`.
  gRPC input is possible later, but Home and Back were unreliable over gRPC in
  #69.
- **Fallback:** keep scrcpy for physical devices, other host platforms,
  emulators started without gRPC, and failed startup checks.

### 3. Other host platforms

Add hardware encoders for Linux and Windows hosts (VAAPI, NVENC, or Media
Foundation) only when there is demand. Until then they keep scrcpy.

## Measuring smoothness

Average frame rate hid every problem above. For each change, measure:

- **Presentation jitter:** p95, p99, and maximum intervals between frames
  presented in the browser.
- **Input-to-photon latency:** time from sending a tap to the first presented
  frame that shows its effect. Use a test page that changes color on touch.
- **App jank:** `adb shell dumpsys gfxinfo <package> framestats`, with streaming
  on and off, to see what capture costs the app.
- **Effective resolution and quality:** actual stream size, bit rate, and a
  visual check during fast scrolling.

Use one session per emulator. Check `adb forward --list` for other sessions
before measuring, and record the emulator and scrcpy versions with every result.

## Open questions

- Does MMAP on emulator 37.2.11 or later deliver correct pixels at 60 fps on
  Apple Silicon?
- Is copying each frame as soon as its message arrives enough to avoid torn
  frames?
- How should input coordinates follow rotation, folding, and display modes?
  `streamScreenshot` reports `rotation`, `foldedDisplay`, and `displayMode`.
- Should serve-emu offer to restart an emulator that was started without gRPC,
  or only fall back to scrcpy?
- What does copying frames at native resolution cost the host CPU?

## Sources

- serve-sim:
  [`FrameCapture.swift`](https://github.com/EvanBacon/serve-sim/blob/main/packages/serve-sim/Sources/SimNative/FrameCapture.swift),
  [`H264Encoder.swift`](https://github.com/EvanBacon/serve-sim/blob/main/packages/serve-sim/Sources/SimNative/H264Encoder.swift),
  [`CaptureEngine.swift`](https://github.com/EvanBacon/serve-sim/blob/main/packages/serve-sim/Sources/SimNative/CaptureEngine.swift)
- Emulator codecs:
  [goldfish `codecs.xml`](https://android.googlesource.com/device/generic/goldfish/+/refs/heads/main/codecs/media/codecs.xml),
  [goldfish `codecs_performance_c2_arm64.xml`](https://android.googlesource.com/device/generic/goldfish/+/refs/heads/main/codecs/media/codecs_performance_c2_arm64.xml),
  [`media_codecs_google_c2_video.xml`](https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/media/libstagefright/data/media_codecs_google_c2_video.xml)
- Guest frame path:
  [goldfish gralloc `mapper.cpp`](https://android.googlesource.com/device/generic/goldfish/+/refs/heads/main/hals/gralloc/mapper.cpp),
  [`C2SoftAvcEnc.cpp`](https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/media/codec2/components/avc/C2SoftAvcEnc.cpp),
  [`GraphicBufferSource.cpp`](https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/media/module/bqhelper/GraphicBufferSource.cpp)
- scrcpy:
  [`SurfaceEncoder.java` at v4.0](https://github.com/Genymobile/scrcpy/blob/v4.0/server/src/main/java/com/genymobile/scrcpy/video/SurfaceEncoder.java)
- Android Studio:
  [`EmulatorView.kt`](https://android.googlesource.com/platform/tools/adt/idea/+/refs/heads/mirror-goog-studio-main/streaming/src/com/android/tools/idea/streaming/emulator/EmulatorView.kt),
  [`DeviceClient.kt`](https://android.googlesource.com/platform/tools/adt/idea/+/refs/heads/mirror-goog-studio-main/streaming/src/com/android/tools/idea/streaming/device/DeviceClient.kt),
  [`display_streamer.cc`](https://android.googlesource.com/platform/tools/adt/idea/+/refs/heads/mirror-goog-studio-main/streaming/screen-sharing-agent/app/src/main/cpp/display_streamer.cc)
- Android Emulator:
  [release notes](https://developer.android.com/studio/releases/emulator),
  [WebRTC video bridge](https://android.googlesource.com/platform/external/qemu/+/refs/heads/emu-master-dev/android/android-webrtc/README.md),
  and the SDK's `emulator/lib/emulator_controller.proto`
- Platform:
  [MediaProjection](https://developer.android.com/media/grow/media-projection),
  [Cuttlefish WebRTC streaming](https://source.android.com/docs/devices/cuttlefish/webrtc)
- serve-emu measurements:
  [#70](https://github.com/jiunshinn/serve-emu/pull/70) and
  [#69](https://github.com/jiunshinn/serve-emu/pull/69)
