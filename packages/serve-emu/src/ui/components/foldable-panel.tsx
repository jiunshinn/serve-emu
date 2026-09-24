import { useRef, useState } from "react";
import { apiRequest } from "../lib/api-client";
import { deviceSessionStore, useDeviceSessionSnapshot } from "../lib/device-session-store";
import { usePoll } from "../lib/use-poll";
import type { FoldPosture, FoldableState } from "../../shared/foldable-contracts";

const LABELS = { folded: "Folded", "half-open": "Half-open", unfolded: "Unfolded", unknown: "Unknown posture" };
const ACTIONS = [["folded", "Fold"], ["half-open", "Half-open"], ["unfolded", "Unfold"]] as const;

export function FoldablePanel() {
  const session = useDeviceSessionSnapshot();
  const [result, setResult] = useState<{ revision: number; state: FoldableState } | null>(null);
  const [error, setError] = useState<{ revision: number; message: string } | null>(null);
  const [actionError, setActionError] = useState<{ revision: number; message: string } | null>(null);
  const [busy, setBusy] = useState<FoldPosture | null>(null);
  const inFlight = useRef(false);
  const state = result?.revision === session.revision ? result.state : null;
  const actionMessage = actionError?.revision === session.revision ? actionError.message : null;
  const message = error?.revision === session.revision ? error.message : null;
  const { refresh } = usePoll({
    poll: ({ signal }) => apiRequest("/api/foldable", { method: "GET", signal, cache: "no-store" }),
    onResult: (json, context) => { setResult({ revision: context.key, state: json.foldable }); setError(null); },
    onError: (err, context) => setError({ revision: context.key, message: err instanceof Error ? err.message : String(err) }),
    intervalMs: 2_000,
    pollKey: session.revision,
    enabled: !session.transitioning && !busy,
  });

  async function change(posture: FoldPosture) {
    if (inFlight.current || !state?.supported || session.transitioning) return;
    inFlight.current = true;
    const revision = session.revision;
    setBusy(posture);
    setActionError(null);
    try {
      const json = await apiRequest("/api/foldable", { method: "POST", body: { posture } });
      if (deviceSessionStore.getSnapshot().revision === revision) setResult({ revision, state: json.foldable });
    } catch (err) {
      setActionError({ revision, message: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight.current = false;
      setBusy(null);
      refresh();
    }
  }

  return <section className="tool-panel foldable-panel" aria-label="Foldable controls" aria-busy={!!busy}>
    <div className="panel-heading">
      <h2>Foldable</h2>
      <div className="location-status" role="status">{busy ? `Changing to ${LABELS[busy].toLowerCase()}…` : state?.supported ? LABELS[state.posture] : state ? "Not supported" : "Checking…"}</div>
    </div>
    {state?.supported ? <p className="device-empty">{state.posture === "half-open"
      ? "Android is half-open. The stream stays flat and uses the full inner display; apps decide whether to rearrange their layout. For tabletop testing, use Orientation to turn the hinge horizontally."
      : "Switch between the cover screen, half-open posture, and inner display. Actions are recorded for replay."}</p>
      : state && <p className="device-empty">{state.reason}</p>}
    {(actionMessage || message) && <p role="alert">{actionMessage || message}</p>}
    <div className="segmented-row">
      {ACTIONS.map(([posture, label]) => <button key={posture} type="button"
        aria-pressed={state?.posture === posture}
        className={state?.posture === posture ? "selected" : ""}
        disabled={!state?.supported || !!busy || session.transitioning}
        onClick={() => void change(posture)}>{label}</button>)}
    </div>
    <button type="button" disabled={!!busy || session.transitioning} onClick={refresh}>Refresh posture</button>
  </section>;
}
