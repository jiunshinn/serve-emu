import { epochNowMs, parseFramePacket } from "../src/shared/frame-meta.ts";

const STEADY_MS = 2_000;
const WARMUP_MS = 250;
const FIRST_FRAME_TIMEOUT_MS = 12_000;
const JOIN_SAMPLES = 6;

type Sample = { at: number; age: number | null; bytes: number };

function viewer(url: string) {
  const started = epochNowMs();
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const frames: Sample[] = [];
  const sessions: number[] = [];

  const firstKeyFrame = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for the viewer's first keyframe"));
    }, FIRST_FRAME_TIMEOUT_MS);
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      reject(new Error("Viewer closed before its first keyframe"));
    }, { once: true });
    socket.addEventListener("message", ({ data }) => {
      const at = epochNowMs();
      if (typeof data === "string") {
        if (JSON.parse(data).type === "video-session") sessions.push(at);
        return;
      }
      const packet = parseFramePacket(data);
      frames.push({
        at,
        age: packet.serverTsMs === null ? null : at - packet.serverTsMs,
        bytes: data.byteLength,
      });
      if (packet.isKey) {
        clearTimeout(timer);
        resolve(at - started);
      }
    });
  });

  return { socket, firstKeyFrame, frames, sessions };
}

const round = (value: number) => Math.round(value * 10) / 10;

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return null;
  values.sort((left, right) => left - right);
  return round(values[Math.ceil(values.length * fraction) - 1]!);
}

function frameGaps(frames: Sample[]) {
  return frames.slice(1).map((frame, index) => frame.at - frames[index]!.at);
}

async function measure(url: string, count: number) {
  const active = Array.from({ length: count }, () => viewer(url));
  try {
    await Promise.all(active.map((client) => client.firstKeyFrame));
    // Keep the startup burst out of the steady delivery measurements.
    await Bun.sleep(WARMUP_MS);
    const steadyStart = epochNowMs();
    await Bun.sleep(STEADY_MS);
    const churnStart = epochNowMs();
    const joins: number[] = [];
    for (let i = 0; i < JOIN_SAMPLES; i++) {
      // Space joins past the server's reset cooldown and sample different
      // offsets within the fixture's 30-frame GOP.
      await Bun.sleep(575 + i * 31);
      const joining = viewer(url);
      try {
        joins.push(await joining.firstKeyFrame);
      } finally {
        joining.socket.close();
      }
    }
    if (active.some(({ socket }) => socket.readyState !== WebSocket.OPEN)) {
      throw new Error("A steady viewer disconnected during the benchmark");
    }
    const steady = active.map(({ frames }) =>
      frames.filter(({ at }) => at >= steadyStart && at < churnStart));
    const churn = active.map(({ frames }) => frames.filter(({ at }) => at >= churnStart));
    if (steady.some((frames) => frames.length < 2)) {
      throw new Error("A steady viewer did not receive enough frames to measure");
    }
    return {
      steadyViewers: count,
      minSteadyFps: round(Math.min(...steady.map((frames) => frames.length * 1000 / (churnStart - steadyStart)))),
      steadyAggregateMbps: round(steady.flat().reduce((sum, frame) => sum + frame.bytes * 8, 0) / (churnStart - steadyStart) / 1000),
      steadyReceiveAgeP95Ms: percentile(steady.flatMap((frames) =>
        frames.flatMap(({ age }) => age === null ? [] : [age])), 0.95),
      steadyFrameGapP95Ms: percentile(steady.flatMap(frameGaps), 0.95),
      churnFrameGapP95Ms: percentile(churn.flatMap(frameGaps), 0.95),
      churnMaxFrameGapMs: percentile(churn.flatMap(frameGaps), 1),
      joins: joins.length,
      joinKeyframeP95Ms: percentile(joins, 0.95),
      existingViewerVideoSessionEvents: active.reduce(
        (sum, { sessions }) => sum + sessions.filter((at) => at >= churnStart).length, 0),
    };
  } finally {
    for (const { socket } of active) socket.close();
  }
}

let receivePort!: (port: number) => void;
const port = new Promise<number>((resolve) => { receivePort = resolve; });
const fixture = Bun.spawn([process.execPath, "../tests/browser/server-fixture.ts"], {
  cwd: import.meta.dir,
  env: {
    ...process.env,
    SERVE_EMU_FIXTURE_BENCHMARK: "1",
    SERVE_EMU_FIXTURE_PORT: "0",
    SERVE_EMU_FIXTURE_TOKEN: "",
  },
  stdout: "ignore",
  stderr: "inherit",
  ipc: (message: unknown) => {
    if (typeof message === "number" && message > 0) receivePort(message);
  },
});

const startupTimeout = setTimeout(() => fixture.kill(), 10_000);
try {
  const listeningPort = await Promise.race([
    port,
    fixture.exited.then((code) => { throw new Error(`Benchmark fixture exited (${code})`); }),
  ]);
  clearTimeout(startupTimeout);
  const url = `ws://127.0.0.1:${listeningPort}/ws?frame-meta=1`;
  const results = [];
  for (const count of [1, 4, 10]) results.push(await measure(url, count));
  console.log(JSON.stringify({ workload: "30 fps H.264 fixture, loopback WebSockets", results }, null, 2));
} finally {
  clearTimeout(startupTimeout);
  if (fixture.exitCode === null) fixture.kill();
  await fixture.exited;
}
