// Server-cost benchmark: spawns one serve-emu per device serial, attaches N
// headless WebSocket clients to each, drives motion with /api/swipe, and
// reports host CPU/RSS per server, /health responsiveness (an event-loop
// proxy), and the frames each client received.
//
//   bun run bench:server -- --serials emulator-5554,emulator-5556 --clients 1,5,10
import { parseArgs } from "node:util";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { parseFramePacket, epochNowMs } from "../src/shared/frame-meta.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    serials: { type: "string" },
    clients: { type: "string", default: "1,5,10,25" },
    duration: { type: "string", default: "20" },
    warmup: { type: "string", default: "5" },
    "base-port": { type: "string", default: "3400" },
    motion: { type: "string", default: "swipe" },
    "server-args": { type: "string", default: "" },
    out: { type: "string" },
  },
});

if (!values.serials) {
  console.error("usage: bench-server --serials <s1,s2,...> [--clients 1,5,10,25] [--duration 20] [--warmup 5] [--motion swipe|none] [--out report.json]");
  process.exit(2);
}
const serials = values.serials.split(",").map((s) => s.trim()).filter(Boolean);
const clientSteps = values.clients.split(",").map(Number).filter((n) => n > 0);
const durationMs = Number(values.duration) * 1000;
const warmupMs = Number(values.warmup) * 1000;
const basePort = Number(values["base-port"]);
const extraServerArgs = values["server-args"].split(" ").filter(Boolean);
const CLK_TCK = 100;

const pct = (sorted: number[], q: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]! : null;
const round = (n: number | null, d = 1) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: round(pct(sorted, 0.5)), p95: round(pct(sorted, 0.95)), max: round(sorted.at(-1) ?? null) };
};

function procTree(root: number): number[] {
  const parents = new Map<number, number>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      parents.set(Number(name), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch {}
  }
  const tree = [root];
  for (let i = 0; i < tree.length; i++)
    for (const [pid, ppid] of parents) if (ppid === tree[i]) tree.push(pid);
  return tree;
}

function cpuTicks(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(fields[11]) + Number(fields[12]);
  } catch {
    return 0;
  }
}

function rssMb(pid: number): number {
  try {
    const m = readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/);
    return m ? Number(m[1]) / 1024 : 0;
  } catch {
    return 0;
  }
}

const findPids = (pattern: RegExp) =>
  readdirSync("/proc")
    .filter((n) => /^\d+$/.test(n))
    .map(Number)
    .filter((pid) => {
      try {
        return pattern.test(readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "));
      } catch {
        return false;
      }
    });

type Server = { serial: string; port: number; base: string; proc: ReturnType<typeof Bun.spawn> };

async function startServer(serial: string, port: number): Promise<Server> {
  const proc = Bun.spawn(
    ["bun", "run", new URL("../src/cli.ts", import.meta.url).pathname, "-p", String(port), "-s", serial, ...extraServerArgs],
    { stdout: "ignore", stderr: "ignore", env: { ...process.env, SERVE_EMU_UPDATE_CHECK: "0" } },
  );
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const health = (await (await fetch(`${base}/health`)).json()) as { status?: string; frames?: number };
      if (health.status === "streaming") return { serial, port, base, proc };
    } catch {}
    await Bun.sleep(500);
  }
  proc.kill();
  throw new Error(`serve-emu for ${serial} did not reach streaming on :${port}`);
}

type ClientStat = { frames: number; bytes: number; intervals: number[]; transit: number[]; last: number; closed: string | null };

function openClients(server: Server, count: number) {
  const stats: ClientStat[] = [];
  const sockets: WebSocket[] = [];
  for (let i = 0; i < count; i++) {
    const stat: ClientStat = { frames: 0, bytes: 0, intervals: [], transit: [], last: 0, closed: null };
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?frame-meta=1`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (event) => {
      if (typeof event.data === "string") return;
      const now = performance.now();
      const packet = parseFramePacket(event.data as ArrayBuffer);
      if (stat.last > 0) stat.intervals.push(now - stat.last);
      stat.last = now;
      stat.frames++;
      stat.bytes += (event.data as ArrayBuffer).byteLength;
      if (packet.serverTsMs !== null) stat.transit.push(epochNowMs() - packet.serverTsMs);
    };
    ws.onclose = (event) => {
      stat.closed = `${event.code} ${event.reason}`;
    };
    stats.push(stat);
    sockets.push(ws);
  }
  return { stats, close: () => sockets.forEach((ws) => ws.close()) };
}

async function driveMotion(server: Server, until: number) {
  let down = true;
  while (Date.now() < until) {
    const [y1, y2] = down ? [0.75, 0.3] : [0.3, 0.75];
    down = !down;
    try {
      const res = await fetch(`${server.base}/api/swipe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x1: 0.5, y1, x2: 0.5, y2, durationMs: 300, record: false }),
      });
      if (!res.ok) throw new Error(`/api/swipe ${res.status}: ${await res.text()}`);
    } catch (err) {
      console.error(String(err));
    }
    await Bun.sleep(400);
  }
}

async function probeHealth(server: Server, until: number) {
  const latencies: number[] = [];
  while (Date.now() < until) {
    const started = performance.now();
    try {
      await (await fetch(`${server.base}/health`)).arrayBuffer();
      latencies.push(performance.now() - started);
    } catch {}
    await Bun.sleep(250);
  }
  return latencies;
}

const health = async (server: Server) => (await (await fetch(`${server.base}/health`)).json()) as Record<string, any>;

async function runStep(servers: Server[], clientsPerServer: number) {
  const groups = servers.map((s) => ({ server: s, ...openClients(s, clientsPerServer) }));
  const motionUntil = Date.now() + warmupMs + durationMs;
  const motion = values.motion === "swipe" ? servers.map((s) => driveMotion(s, motionUntil)) : [];
  await Bun.sleep(warmupMs);

  for (const g of groups) for (const s of g.stats) Object.assign(s, { frames: 0, bytes: 0, intervals: [], transit: [] });
  const trees = servers.map((s) => procTree(s.proc.pid));
  const adbPids = findPids(/^adb .*fork-server/);
  const emuPids = findPids(/qemu-system/);
  const ticks = (pids: number[]) => pids.reduce((sum, pid) => sum + cpuTicks(pid), 0);
  const before = {
    servers: trees.map(ticks),
    adb: ticks(adbPids),
    emulators: ticks(emuPids),
    bench: process.cpuUsage(),
    health: await Promise.all(servers.map(health)),
  };
  const rssSamples: number[][] = servers.map(() => []);
  const started = performance.now();
  const end = Date.now() + durationMs;
  const sampler = (async () => {
    while (Date.now() < end) {
      trees.forEach((tree, i) => rssSamples[i]!.push(tree.reduce((sum, pid) => sum + rssMb(pid), 0)));
      await Bun.sleep(1000);
    }
  })();
  const probes = await Promise.all(servers.map((s) => probeHealth(s, end)));
  await sampler;
  const elapsedS = (performance.now() - started) / 1000;
  const after = {
    servers: trees.map(ticks),
    adb: ticks(adbPids),
    emulators: ticks(emuPids),
    bench: process.cpuUsage(before.bench),
    health: await Promise.all(servers.map(health)),
  };
  const closedDuringRun = groups.map((g) => g.stats.filter((s) => s.closed).length);
  for (const g of groups) g.close();
  await Promise.all(motion);
  const cpuPct = (delta: number) => round((delta / CLK_TCK / elapsedS) * 100);

  return {
    clientsPerServer,
    servers: groups.map((g, i) => {
      const fps = g.stats.map((s) => s.frames / elapsedS);
      const h0 = before.health[i]!;
      const h1 = after.health[i]!;
      return {
        serial: g.server.serial,
        cpuPct: cpuPct(after.servers[i]! - before.servers[i]!),
        rssMbMax: round(Math.max(...rssSamples[i]!)),
        sourceFps: round((h1.frames - h0.frames) / elapsedS),
        clientFps: summary(fps),
        clientMbps: round(g.stats.reduce((sum, s) => sum + s.bytes, 0) * 8 / 1e6 / elapsedS / clientsPerServer, 2),
        frameIntervalMs: summary(g.stats.flatMap((s) => s.intervals)),
        transitMs: summary(g.stats.flatMap((s) => s.transit)),
        healthLatencyMs: summary(probes[i]!),
        droppedFrames: h1.droppedFrames - h0.droppedFrames,
        backpressureEvents: h1.backpressureEvents - h0.backpressureEvents,
        videoResets: h1.videoResetRequests - h0.videoResetRequests,
        closedClients: closedDuringRun[i]!,
      };
    }),
    adbCpuPct: cpuPct(after.adb - before.adb),
    emulatorsCpuPct: cpuPct(after.emulators - before.emulators),
    benchCpuPct: round(((after.bench.user + after.bench.system) / 1e6 / elapsedS) * 100),
  };
}

const servers: Server[] = [];
const cleanup = () => servers.forEach((s) => s.proc.kill());
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

try {
  servers.push(...(await Promise.all(serials.map((serial, i) => startServer(serial, basePort + i)))));
  const steps = [];
  for (const n of clientSteps) {
    const step = await runStep(servers, n);
    steps.push(step);
    for (const s of step.servers)
      console.log(
        `clients=${n} ${s.serial}: cpu ${s.cpuPct}% rss ${s.rssMbMax}MB src ${s.sourceFps}fps client p50 ${s.clientFps.p50}fps ` +
          `interval p95 ${s.frameIntervalMs.p95}ms transit p95 ${s.transitMs.p95}ms /health p95 ${s.healthLatencyMs.p95}ms ` +
          `drops ${s.droppedFrames} bp ${s.backpressureEvents} resets ${s.videoResets} closed ${s.closedClients}`,
      );
    console.log(`clients=${n} adb ${step.adbCpuPct}% emulators ${step.emulatorsCpuPct}% bench ${step.benchCpuPct}%`);
  }
  const report = {
    at: new Date().toISOString(),
    host: { cpus: cpus().length, model: cpus()[0]?.model ?? null },
    config: { serials, clientSteps, durationMs, warmupMs, motion: values.motion, extraServerArgs },
    steps,
  };
  if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2));
  else console.log(JSON.stringify(report, null, 2));
} finally {
  cleanup();
}
