import type { StreamStats, StreamWorkerEvent } from "../../packages/serve-emu/src/ui/lib/stream-worker.ts";

type Backend = "scrcpy" | "native";
type CaptureHealth = {
  backend: Backend;
  width: number;
  height: number;
  sourceFps: number;
  encodedFps: number;
  droppedFrames: number;
  clients: number;
  error: string | null;
};
type CaptureSample = {
  at: string;
  backend: Backend;
  run: number;
  elapsedMs: number;
  firstFrameMs: number | null;
  stats: StreamStats;
  health: CaptureHealth | null;
};

declare global {
  interface Window {
    __captureStats: StreamStats | null;
    __captureHistory: CaptureSample[];
    __captureHealth: CaptureHealth | null;
  }
}

const element = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing comparison element: ${id}`);
  return found as T;
};
const viewport = element("viewport");
const status = element("status");
const errorBox = element("error");
const sourceChoices = document.querySelectorAll<HTMLInputElement>('input[name="backend"]');
const requestedBackend = new URL(location.href).searchParams.get("backend");
let backend: Backend = requestedBackend === "native" ? "native" : "scrcpy";
let worker: Worker | null = null;
let canvas: HTMLCanvasElement | null = null;
let epoch = 0;
let runStartedAt = 0;
let firstFrameMs: number | null = null;
let sequence = 0;
let workerError: string | null = null;
let healthError: string | null = null;
let healthController: AbortController | null = null;
let healthTimer: ReturnType<typeof setTimeout> | null = null;
let activePointer: { id: number; x: number; y: number } | null = null;
let pendingMove: { x: number; y: number } | null = null;
let moveHandle = 0;

window.__captureStats = null;
window.__captureHistory = [];
window.__captureHealth = null;

const format = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: 1 })
    : "—";

function showError() {
  errorBox.textContent = workerError ?? healthError ?? "";
  errorBox.hidden = !errorBox.textContent;
}

function showSession() {
  const health = window.__captureHealth;
  const stats = window.__captureStats;
  element("session-detail").textContent = [
    health?.width && health.height ? `${health.width} × ${health.height}` : null,
    stats?.codec,
    firstFrameMs !== null ? `First frame ${format(firstFrameMs)} ms` : "Waiting for the first frame",
    stats ? `${stats.recoveries} recoveries · decode queue ${stats.decodeQueue}` : null,
  ].filter(Boolean).join(" · ");
}

function send(message: Record<string, unknown>, ack = true) {
  worker?.postMessage({
    type: "send",
    clientEpoch: epoch,
    text: JSON.stringify({ ...message, ack, requestId: `${epoch}:${++sequence}` }),
  });
}

function flushMove() {
  if (moveHandle) cancelAnimationFrame(moveHandle);
  moveHandle = 0;
  if (pendingMove && activePointer) {
    Object.assign(activePointer, pendingMove);
    send({ type: "touch", action: "move", ...pendingMove, pointerId: activePointer.id }, false);
  }
  pendingMove = null;
}

function stopPointer() {
  flushMove();
  if (activePointer) {
    const { id, x, y } = activePointer;
    send({ type: "touch", action: "up", x, y, pointerId: id });
    activePointer = null;
  }
}

function bindPointer(target: HTMLCanvasElement) {
  const point = (event: PointerEvent) => {
    const bounds = target.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    };
  };
  target.addEventListener("contextmenu", (event) => event.preventDefault());
  target.addEventListener("pointerdown", (event) => {
    if (activePointer || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    target.setPointerCapture(event.pointerId);
    activePointer = { id: event.pointerId, ...point(event) };
    send({ type: "touch", action: "down", ...point(event), pointerId: event.pointerId });
  });
  target.addEventListener("pointermove", (event) => {
    if (activePointer?.id !== event.pointerId) return;
    event.preventDefault();
    pendingMove = point(event);
    if (!moveHandle) moveHandle = requestAnimationFrame(flushMove);
  });
  const release = (event: PointerEvent) => {
    if (activePointer?.id !== event.pointerId) return;
    event.preventDefault();
    pendingMove = point(event);
    stopPointer();
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
  };
  target.addEventListener("pointerup", release);
  target.addEventListener("pointercancel", release);
  target.addEventListener("lostpointercapture", (event) => {
    if (activePointer?.id === event.pointerId) stopPointer();
  });
}

async function pollHealth(currentEpoch: number) {
  const controller = new AbortController();
  healthController = controller;
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch("/health", { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Health request failed: HTTP ${response.status}`);
    const health = await response.json() as CaptureHealth;
    if (currentEpoch !== epoch) return;
    if (health.backend !== backend) {
      healthError = "Waiting for the selected capture source to start.";
    } else {
      window.__captureHealth = health;
      healthError = health.error;
      element("source-fps").textContent = format(health.sourceFps);
      element("encoded-fps").textContent = format(health.encodedFps);
      element("drops").textContent = format(health.droppedFrames);
      showSession();
    }
  } catch (error) {
    if (currentEpoch !== epoch) return;
    healthError = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timeout);
    if (currentEpoch === epoch) {
      showError();
      healthTimer = setTimeout(() => void pollHealth(currentEpoch), 1000);
    }
  }
}

function connect() {
  stopPointer();
  worker?.terminate();
  worker = null;
  epoch++;
  const currentEpoch = epoch;
  healthController?.abort();
  if (healthTimer) clearTimeout(healthTimer);
  window.__captureStats = null;
  window.__captureHealth = null;
  firstFrameMs = null;
  workerError = healthError = null;
  status.textContent = "Connecting…";
  status.dataset.ready = "false";
  for (const id of ["rendered-fps", "source-fps", "encoded-fps", "decode-p95", "present-p95", "drops"]) element(id).textContent = "—";
  element("pipeline").textContent = backend === "scrcpy"
    ? "Android screen → scrcpy H.264 → production player"
    : "Emulator framebuffer → gRPC → host H.264 → production player";
  sourceChoices.forEach((input) => { input.checked = input.value === backend; });
  const pageUrl = new URL(location.href);
  pageUrl.searchParams.set("backend", backend);
  history.replaceState(null, "", pageUrl);
  canvas = document.createElement("canvas");
  canvas.width = 432;
  canvas.height = 960;
  canvas.setAttribute("aria-label", "Interactive Android device screen");
  viewport.replaceChildren(canvas);
  showError();
  showSession();
  if (typeof Worker !== "function" || typeof canvas.transferControlToOffscreen !== "function") {
    workerError = "This browser needs Web Workers and OffscreenCanvas to run the production player.";
    showError();
    return;
  }
  bindPointer(canvas);
  const nextWorker = new Worker("/worker.js", { type: "module" });
  worker = nextWorker;
  runStartedAt = performance.now();
  nextWorker.addEventListener("error", (event) => {
    if (currentEpoch !== epoch) return;
    workerError = event.message || "The video worker failed.";
    showError();
  });
  nextWorker.addEventListener("message", (event: MessageEvent<StreamWorkerEvent>) => {
    const message = event.data;
    if (currentEpoch !== epoch || message.clientEpoch !== currentEpoch) return;
    if (message.type === "status") {
      status.textContent = message.status;
      status.dataset.ready = String(message.status === "streaming");
    } else if (message.type === "rendered" && firstFrameMs === null) {
      firstFrameMs = Math.round(performance.now() - runStartedAt);
      showSession();
    } else if (message.type === "control-error") {
      workerError = message.error;
      showError();
    } else if (message.type === "control-dropped") {
      workerError = "Connection unavailable. Input was not sent.";
      showError();
    } else if (message.type === "stats") {
      window.__captureStats = message.stats;
      element("rendered-fps").textContent = format(message.stats.fps);
      element("decode-p95").textContent = format(message.stats.decodeMsP95);
      element("present-p95").textContent = format(message.stats.presentMsP95);
      const sample: CaptureSample = {
        at: new Date().toISOString(), backend, run: currentEpoch,
        elapsedMs: Math.round(performance.now() - runStartedAt), firstFrameMs,
        stats: message.stats, health: window.__captureHealth,
      };
      window.__captureHistory.push(sample);
      if (window.__captureHistory.length > 3600) window.__captureHistory.shift();
      element("sample-detail").textContent = `${window.__captureHistory.length} samples collected · run ${currentEpoch}`;
      showSession();
    }
  });
  const socketUrl = new URL("/ws", location.href);
  socketUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socketUrl.searchParams.set("backend", backend);
  socketUrl.searchParams.set("frame-meta", "1");
  const offscreen = canvas.transferControlToOffscreen();
  nextWorker.postMessage({ type: "init", clientEpoch: currentEpoch, canvas: offscreen, url: socketUrl.href }, [offscreen]);
  void pollHealth(currentEpoch);
}

sourceChoices.forEach((input) => input.addEventListener("change", () => {
  if (!input.checked) return;
  backend = input.value === "native" ? "native" : "scrcpy";
  connect();
}));
element("reconnect").addEventListener("click", connect);
element("home").addEventListener("click", () => send({ type: "home" }));
element("back").addEventListener("click", () => send({ type: "back" }));
element("download").addEventListener("click", () => {
  const content = JSON.stringify({
    experiment: "native-capture", exportedAt: new Date().toISOString(),
    userAgent: navigator.userAgent, samples: window.__captureHistory,
  }, null, 2);
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `capture-comparison-${new Date().toISOString().replaceAll(":", "-")}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener("blur", stopPointer);
window.addEventListener("pagehide", () => {
  stopPointer();
  epoch++;
  worker?.terminate();
  healthController?.abort();
  if (healthTimer) clearTimeout(healthTimer);
});
connect();
