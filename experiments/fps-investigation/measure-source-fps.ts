// Average frame rate serve-emu receives from scrcpy over a fixed window.
//
// Reads the cumulative `frames` counter from /health before and after the
// window, so the result is exact and needs no viewer. Run it with no browser
// attached: a connected client arms the recovery watchdog, which can restart
// the capture and change what is being measured.
//
// usage: bun measure-source-fps.ts [port=3300] [seconds=10]
// Set SERVE_EMU_TOKEN when the server runs with --token.

type Health = {
  frames: number;
  size: { width: number; height: number } | null;
  videoResetRequests: number;
  frameStats: {
    windowFrames: number;
    intervalMs: { p50: number; p95: number; max: number } | null;
    avgDeltaFrameBytes: number | null;
  } | null;
};

const port = Number(process.argv[2] ?? 3300);
const seconds = Number(process.argv[3] ?? 10);
const token = process.env.SERVE_EMU_TOKEN;

async function readHealth(): Promise<Health> {
  const res = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`/health returned HTTP ${res.status}`);
  return (await res.json()) as Health;
}

const before = await readHealth();
const startedAt = performance.now();
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
const after = await readHealth();
const elapsedS = (performance.now() - startedAt) / 1000;

const fps = (after.frames - before.frames) / elapsedS;
const size = after.size ? `${after.size.width}x${after.size.height}` : "unknown";
// frameStats is the server's rolling window over the most recent frames
// (240 at the time of writing), not exactly this measurement window.
const recent = after.frameStats?.intervalMs;
console.log(
  [
    `port=${port}`,
    `size=${size}`,
    `avgFps=${fps.toFixed(1)}`,
    recent
      ? `recentIntervalMs p50=${recent.p50} p95=${recent.p95} max=${recent.max}`
      : "recentIntervalMs=n/a",
    `avgDeltaBytes=${after.frameStats?.avgDeltaFrameBytes ?? "n/a"}`,
    `resetsDuringWindow=${after.videoResetRequests - before.videoResetRequests}`,
  ].join(" "),
);
