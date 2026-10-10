// Connects to /ws the way the bundled UI does and prints video messages
// received per second, plus the video resets the server requested meanwhile.
//
// A connected client arms the server's recovery watchdog, so running this on a
// static screen shows the "video source stalled" reset cadence directly.
//
// usage: bun count-ws-frames.ts [port=3300] [seconds=30]
// Bun-only: it passes headers to the WebSocket constructor, which the
// standard API does not allow. Set SERVE_EMU_TOKEN when the server uses --token.

const port = Number(process.argv[2] ?? 3300);
const seconds = Number(process.argv[3] ?? 30);
const token = process.env.SERVE_EMU_TOKEN;
const origin = `http://127.0.0.1:${port}`;
const authHeaders: Record<string, string> = token
  ? { authorization: `Bearer ${token}` }
  : {};

async function resetCount(): Promise<number> {
  const res = await fetch(`${origin}/health`, { headers: authHeaders });
  const health = (await res.json()) as { videoResetRequests: number };
  return health.videoResetRequests;
}

const resetsBefore = await resetCount();
// Origin is required for WebSocket upgrades when the server has auth enabled.
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?frame-meta=1`, {
  headers: { ...authHeaders, origin },
} as unknown as string[]);
ws.binaryType = "arraybuffer";

let thisSecond = 0;
let total = 0;
const perSecond: number[] = [];
ws.onmessage = (event) => {
  if (typeof event.data === "string") return;
  thisSecond++;
  total++;
};
ws.onerror = () => console.error("WebSocket error");

const sampler = setInterval(() => {
  perSecond.push(thisSecond);
  thisSecond = 0;
}, 1000);

setTimeout(async () => {
  clearInterval(sampler);
  ws.close();
  const resets = (await resetCount()) - resetsBefore;
  console.log(`frames/sec: [${perSecond.join(",")}]`);
  console.log(`total=${total} resetsDuringWindow=${resets}`);
  process.exit(0);
}, seconds * 1000);
