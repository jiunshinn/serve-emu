import { useEffect, useRef, useState } from "react";
import type {
  SessionEvent,
  SessionPage,
  SessionSummary,
} from "../../shared/api-contracts";
import { apiErrorMessage, apiRequest } from "../lib/api-client";
import { useDeviceSessionSnapshot } from "../lib/device-session-store";
import { usePoll } from "../lib/use-poll";

const RECENT_EVENT_LIMIT = 6;
const POLL_INTERVAL_MS = 1_000;

function labelForEvent(event: SessionEvent): string {
  if (event.kind === "gesture") {
    return `${event.gesture.type} • ${event.source}`;
  }
  const lat = event.location.latitude.toFixed(5);
  const lng = event.location.longitude.toFixed(5);
  return `location ${lat}, ${lng}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return apiErrorMessage(error) || fallback;
}

export function SessionPanel() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const actionGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [multiplier, setMultiplier] = useState("1");
  const [status, setStatus] = useState("Ready");
  // Poll only while the section is on screen; usePoll also pauses while the
  // tab is hidden and refreshes as soon as either condition clears.
  const [onScreen, setOnScreen] = useState(false);
  const deviceSession = useDeviceSessionSnapshot();

  const { refresh } = usePoll<SessionPage, number>({
    pollKey: deviceSession.revision,
    enabled: onScreen && !deviceSession.transitioning,
    intervalMs: POLL_INTERVAL_MS,
    poll: ({ signal }) =>
      apiRequest("/api/session", {
        method: "GET",
        query: { limit: RECENT_EVENT_LIMIT },
        signal,
      }),
    onResult: (page) => {
      setSession(page.session);
      setEvents(page.events.slice(-RECENT_EVENT_LIMIT));
      setStatus((current) => {
        if (current === "Session unavailable") return "Ready";
        if (current === "Replaying" && !page.session.replaying) {
          return "Ready";
        }
        return current;
      });
    },
    onError: () => setStatus("Session unavailable"),
  });

  useEffect(() => {
    mountedRef.current = true;
    const section = sectionRef.current;
    let observer: IntersectionObserver | null = null;
    if (section && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => {
        const entry = entries.find((candidate) => candidate.target === section);
        if (entry) setOnScreen(entry.isIntersecting);
      });
      observer.observe(section);
    } else {
      // Older embedded browsers cannot report viewport intersection. Keep the
      // tab-visibility guard, but allow the panel to remain usable there.
      setOnScreen(true);
    }

    return () => {
      mountedRef.current = false;
      actionGenerationRef.current++;
      observer?.disconnect();
    };
  }, []);

  // Replay responses carry the full snapshot and clear carries the summary;
  // the poll that follows every mutation refreshes the summary either way.
  const mutate = async (
    request: () => Promise<{ session: { replaying: boolean } & Partial<SessionSummary> }>,
    successStatus: string,
    failureStatus: string,
    clearEvents = false,
  ) => {
    const generation = ++actionGenerationRef.current;
    try {
      const data = await request();
      if (!mountedRef.current || generation !== actionGenerationRef.current) {
        return;
      }
      setSession((current) =>
        current ? { ...current, ...data.session } : current,
      );
      if (clearEvents) setEvents([]);
      setStatus(successStatus);
    } catch (error) {
      if (mountedRef.current && generation === actionGenerationRef.current) {
        setStatus(errorMessage(error, failureStatus));
      }
    } finally {
      if (generation === actionGenerationRef.current) {
        // Discard any poll that started before the mutation finished, so a
        // pre-mutation page cannot win the race, and fetch a fresh one now.
        refresh();
      }
    }
  };

  const replay = async () => {
    const rate = Number(multiplier);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
      setStatus("Rate must be between 0 and 100");
      return;
    }
    await mutate(
      () =>
        apiRequest("/api/session/replay", {
          method: "POST",
          body: { multiplier: rate },
        }),
      "Replaying",
      "Replay failed",
    );
  };

  const stopReplay = async () => {
    await mutate(
      () => apiRequest("/api/session/replay/stop", { method: "POST" }),
      "Replay stopped",
      "Stop failed",
    );
  };

  const clear = async () => {
    await mutate(
      () => apiRequest("/api/session", { method: "DELETE" }),
      "Cleared",
      "Clear failed",
      true,
    );
  };

  const copy = async () => {
    setStatus("Copying");
    try {
      const data = await apiRequest("/api/session/export", { method: "GET" });
      await navigator.clipboard.writeText(
        JSON.stringify(data.events, null, 2),
      );
      if (mountedRef.current) setStatus("Copied");
    } catch (error) {
      if (mountedRef.current) setStatus(errorMessage(error, "Copy failed"));
    }
  };

  const recent = events.slice(-RECENT_EVENT_LIMIT).reverse();

  return (
    <section ref={sectionRef} className="tool-panel session-panel">
      <div className="panel-heading">
        <h2>Session</h2>
        <div className="location-status">
          {session?.replaying ? "Replaying" : status} • {session?.eventCount ?? 0}
        </div>
      </div>
      <div className="coordinate-grid">
        <label>
          Rate
          <input
            inputMode="decimal"
            onChange={(event) => setMultiplier(event.currentTarget.value)}
            value={multiplier}
          />
        </label>
        <label>
          Mode
          <input readOnly value={session?.recording ? "Recording" : "Paused"} />
        </label>
      </div>
      <div className="panel-actions">
        <button
          disabled={!session || session.replaying || session.eventCount === 0}
          onClick={() => void replay()}
        >
          Replay
        </button>
        <button
          disabled={!session?.replaying}
          onClick={() => void stopReplay()}
        >
          Stop
        </button>
        <button onClick={() => void clear()}>Clear</button>
        <button onClick={() => void copy()}>Copy</button>
      </div>
      <div className="session-list">
        {recent.length
          ? recent.map((event) => (
              <div key={event.id}>
                <span>+{Math.round(event.delayMs)}ms</span>
                {labelForEvent(event)}
              </div>
            ))
          : <div>No recorded events</div>}
      </div>
      {session?.lastError && (
        <div className="route-meta">{session.lastError}</div>
      )}
    </section>
  );
}
