import { useRef, useState } from "react";
import type { CameraResponse } from "../../shared/api-contracts";
import { apiErrorMessage, apiRequest } from "../lib/api-client";
import { deviceSessionStore, useDeviceSessionSnapshot } from "../lib/device-session-store";
import { usePoll } from "../lib/use-poll";
import { ToolSection } from "./tool-section";

async function imagePng(file: File): Promise<Blob> {
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 4096 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion is unavailable.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not convert image to PNG.")), "image/png"));
  } finally { image.close(); }
}

export function CameraTool() {
  const session = useDeviceSessionSnapshot();
  const [result, setResult] = useState<{ revision: number; state: CameraResponse } | null>(null);
  usePoll({
    poll: ({ signal }) => apiRequest("/api/camera", { method: "GET", signal, cache: "no-store" }),
    onResult: (state, context) => setResult({ revision: context.key, state }),
    onError: () => setResult(null),
    intervalMs: 3_000, pollKey: session.revision, enabled: !session.transitioning,
  });
  const state = result?.revision === session.revision ? result.state : null;
  if (state?.back !== "uploaded" && state?.front !== "uploaded") return null;
  return <ToolSection id="camera-tool" title="Camera"><CameraPanel key={session.revision} state={state} /></ToolSection>;
}

function CameraPanel({ state }: { state: CameraResponse }) {
  const session = useDeviceSessionSnapshot();
  const [restartApp, setRestartApp] = useState(true);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function upload(camera: "back" | "front", file: File) {
    if (inFlight.current || session.transitioning) return;
    inFlight.current = true;
    setBusy(true); setError(""); setMessage("");
    const revision = session.revision;
    try {
      const png = await imagePng(file);
      if (deviceSessionStore.getSnapshot().revision !== revision) return;
      const result = await apiRequest("/api/camera/image", { method: "PUT", query: { camera, restartApp: String(restartApp) }, body: png });
      if (deviceSessionStore.getSnapshot().revision !== revision) return;
      setMessage(`${result.width} × ${result.height} PNG uploaded.${result.restartedApp ? ` Restarted ${result.restartedApp}.` : " Reopen the app's camera to apply."}`);
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <section className="tool-panel camera-panel" aria-label="Camera image controls" aria-busy={busy}>
    <p className="device-empty">Images apply when the app reopens its camera.</p>
    {(["back", "front"] as const).filter((camera) => state[camera] === "uploaded").map((camera) => <label key={camera}>
      {camera === "back" ? "Back" : "Front"} camera image
      <input type="file" accept="image/*" disabled={busy || session.transitioning} onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (file) void upload(camera, file);
      }} />
    </label>)}
    <label><input type="checkbox" checked={restartApp} disabled={busy} onChange={(event) => setRestartApp(event.target.checked)} /> Restart app to apply</label>
    <p role="status">{busy ? "Uploading…" : message}</p>
    {error && <p role="alert">{error}</p>}
  </section>;
}
