# Native emulator capture experiment

Compare scrcpy with Android Emulator gRPC capture and macOS VideoToolbox encoding.
Both sources use the existing serve-emu WebSocket framing, WebCodecs decoder, and
OffscreenCanvas worker. The main package and its default backend are unchanged.

This experiment tests whether moving H.264 encoding out of Android helps. It is
not a WebRTC implementation. An authenticated probe of both native RTC service
versions returned `UNIMPLEMENTED` on Android Emulator 36.6.11 for Mac ARM.
Upstream's [build configuration](https://android.googlesource.com/platform/external/qemu/+/emu-master-dev/CMakeLists.txt)
enables WebRTC by default for Linux x86_64. Google's
[native RTC gateway](https://github.com/google/android-emulator-container-scripts/blob/master/gateway/DEMO.md)
is a separate experiment for a build that actually provides those services.

## Run on macOS

Requires Bun, Android Emulator with its installed `lib/emulator_controller.proto`,
ADB, and FFmpeg built with `h264_videotoolbox`. Hardware encoding is required;
the experiment does not silently fall back to a software encoder.

From the repository root, start an unused AVD in a separate terminal. Replace
`Pixel8a_API34` and the SDK path for your installation. The read-only launch does
not save device data or snapshots. Some emulator builds refuse a read-only copy
of an AVD already running writable; choose a different installed AVD in that case.

```sh
~/Library/Android/sdk/emulator/emulator @Pixel8a_API34 \
  -read-only -no-snapshot-save -no-window -gpu host -port 5556 \
  -grpc 8554 -grpc-use-jwt \
  -grpc-allowlist "$PWD/experiments/native-capture/grpc-access.json"
```

Then start the comparison server:

```sh
cd experiments/native-capture
bun install --frozen-lockfile
bun run start --serial emulator-5556 --max-size 1920
```

Open <http://127.0.0.1:3302>. Select a source, interact with the screen, and inspect
FPS and source drops. Only one viewer is supported; a second viewer is rejected
without interrupting the first. Only one capture/encoder pipeline runs at a time.

Options: `--port`, `--max-size`, `--fps`, `--bit-rate`, `--emulator-dir`,
`--discovery`, and `--probe`. Defaults are port 3302, longest edge 1280,
60 FPS, and 8 Mbps. `--fps` configures the scrcpy cap and the host encoder's
nominal rate; native screenshot delivery follows emulator updates.
Use the default 60 for comparisons on a 60 Hz emulator.

Discovery automatically matches the explicit emulator serial. To inspect native
capture and RTC availability without starting the web server:

```sh
bun run start --serial emulator-5556 --probe
```

The server registers a temporary public JWK, signs short-lived JWTs with a private
key held in memory, and removes its JWK when stopped. The custom allowlist grants
only capture, input, and non-allocating RTC probes. Tokens stay on the server.
The web server binds to loopback and checks Host and Origin; it is not a remote
hosting mode.

Stop the server with Ctrl+C. Stop only the disposable emulator when finished:

```sh
adb -s emulator-5556 emu kill
```

## Compare moving content

With the server running, open the included animation inside the disposable AVD:

```sh
adb -s emulator-5556 shell am start \
  -a android.intent.action.VIEW -d http://10.0.2.2:3302/motion
```

Dismiss any Chrome onboarding dialog. Keep the desktop browser visible and run
one source at a time. Warm up for five seconds, then collect at least 30 seconds
per source. Repeat for the actual app that feels slow: a synthetic animation does
not reproduce every app's rendering or encoding load.

The page exports JSON measurements with **Download results**. Compare actual
decoded dimensions, because scrcpy can downsize automatically. `sourceFps` counts
frames arriving at the server, `encodedFps` counts output sent to the viewer, and
rendered FPS is the production worker's presentation count. Source drops for
native capture count frames rejected by the bounded encoder input queue; startup
drops should be separated from steady-state drops.

The worker's latency numbers start at server send time. They exclude capture and
encoding, so they are not glass-to-glass latency and cannot establish that one
capture backend has lower input latency.

Initial local measurements are in [benchmark-results.json](benchmark-results.json).
They are short smoke measurements on an M1 Max, with other emulator instances
running, not a controlled performance guarantee. At 864×1920 both paths were
near 60 FPS. At the requested 2400px limit, scrcpy produced 920×2048 while native
capture produced 1080×2400; those results are a resolution tradeoff, not a fair
same-resolution speed comparison. Both requested 8 Mbps, but their H.264 profiles
and resulting image quality differ.

## Implementation and limits

- gRPC delivers scaled RGBA frames. At 1080×2400 and 60 FPS this is about
  622 MB/s of raw pixels before serialization and copies. Shared-memory capture
  is the next useful experiment if this transfer becomes limiting; it is not
  implemented here.
- FFmpeg uses VideoToolbox with B-frames disabled and low-delay settings. A
  bounded fragmented-MP4 reader extracts complete H.264 samples and caches SPS/PPS
  for keyframes. The encoder input queue allows at most four pending frames.
- FFmpeg flushes a fragment when the next packet arrives. After 75 ms without
  source updates, one duplicate raw frame flushes the final changed frame.
  This avoids leaving static screens blank or one frame behind indefinitely.
  It adds up to that idle delay, plus processing time, after motion stops.
- A source resize requires reconnecting. Native input maps normalized pointer
  positions to the startup device dimensions; restart the experiment after
  rotation or folding. Pointer, Home, Back, Recents, Power, and text are the
  supported native input subset. Session recording, replay, screenshots as an
  HTTP API, and the main application's other REST routes are not implemented.
- Native input parity remains open: the mouse/key RPCs returned success during
  the headless Android 17 test, but Home/Back did not reliably change the active
  app. Treat the native mode as a capture experiment until interaction is
  verified on the target AVD. The scrcpy baseline uses its existing control socket.
- Slow viewers reconnect rather than retaining a backlog. The native encoder
  emits periodic keyframes; its reset-video message does not force an IDR.

## Validate

```sh
bun test
bun run typecheck
```

Run `bun run check` from the repository root for the existing application's
aggregate validation. Live validation should include both sources, a static
first frame, refresh, source switching, pointer input, Home/Back, and cleanup.
