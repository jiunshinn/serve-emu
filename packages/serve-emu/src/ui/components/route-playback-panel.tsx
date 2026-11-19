import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { RoutePlaybackSnapshot } from "../../shared/api-contracts";
import { apiErrorMessage, apiRequest } from "../lib/api-client";
import {
  deviceSessionStore,
  settledSessionKey,
  useDeviceSessionSnapshot,
} from "../lib/device-session-store";
import type { LocationPoint } from "../lib/route-map";
import { useRouteFileLoader } from "../lib/use-route-file-loader";
import { usePoll } from "../lib/use-poll";

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

export type RoutePlaybackPanelProps = {
  routePoints: LocationPoint[];
  /** How many points the map draws, when simplification drew fewer. */
  drawnPoints: number | null;
  followRoute: boolean;
  onFollowRouteChange: (follow: boolean) => void;
  /** Where Set Location would apply, for recentering when Follow is turned on. */
  draft: LocationPoint;
  /** True while a pointer is down on the map; a poll then does not recenter. */
  mapPointerActiveRef: MutableRefObject<boolean>;
  onRecenter: (location: LocationPoint) => void;
  onRouteLoaded: (points: LocationPoint[]) => void;
  /** The device's position on the route; `recenter` when Follow applies. */
  onRoutePosition: (location: LocationPoint, recenter: boolean) => void;
  onStatus: (text: string) => void;
};

/**
 * Loads a route file and plays it back on the device: start, pause, resume,
 * and stop, with the route's progress polled once a second.
 */
export function RoutePlaybackPanel({
  routePoints,
  drawnPoints,
  followRoute,
  onFollowRouteChange,
  draft,
  mapPointerActiveRef,
  onRecenter,
  onRouteLoaded,
  onRoutePosition,
  onStatus,
}: RoutePlaybackPanelProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const routeMutationCountRef = useRef(0);
  const [routeStatus, setRouteStatus] = useState<RoutePlaybackSnapshot | null>(null);
  const [speedKph, setSpeedKph] = useState("30");
  const [multiplier, setMultiplier] = useState("1");
  const [loop, setLoop] = useState(false);

  const loader = useRouteFileLoader({
    onStatus,
    onLoaded: (route) => onRouteLoaded(route.points),
  });
  const clearFileInput = () => {
    if (fileRef.current) fileRef.current.value = "";
  };

  // Read by the route poll; toggling Follow must not restart polling.
  const followRouteRef = useRef(followRoute);
  followRouteRef.current = followRoute;
  const onRoutePositionRef = useRef(onRoutePosition);
  onRoutePositionRef.current = onRoutePosition;
  const deviceSession = useDeviceSessionSnapshot();
  const { refresh: refreshRoute } = usePoll({
    pollKey: deviceSession.revision,
    enabled: !deviceSession.transitioning,
    intervalMs: 1_000,
    // The typed client rejects failures and malformed snapshots.
    poll: ({ signal }) => apiRequest("/api/route", { method: "GET", signal }),
    onResult: (route) => {
      // A start/stop in flight owns the route state until it settles.
      if (routeMutationCountRef.current > 0) return;
      setRouteStatus(route);
      if (route.currentLocation) {
        onRoutePositionRef.current(
          route.currentLocation,
          followRouteRef.current &&
            route.status === "running" &&
            !mapPointerActiveRef.current,
        );
      }
    },
    // Route state is auxiliary to video and input, so a failed poll keeps the
    // last good snapshot and the next tick retries.
  });

  // Route playback belongs to one device session, so its last snapshot (and
  // error line) must not outlive it. Clear it as soon as a switch starts, and
  // when /health settles on a different session without one (a switch made
  // by another tab or the REST API), rather than showing the old device's
  // route until the new session's first poll returns, or for good if that
  // poll fails.
  const sessionKey = settledSessionKey(deviceSession);
  const routeSessionKeyRef = useRef(sessionKey);
  useEffect(() => {
    if (deviceSession.transitioning) {
      routeSessionKeyRef.current = null;
      setRouteStatus(null);
      return;
    }
    if (sessionKey === null) return;
    const previous = routeSessionKeyRef.current;
    routeSessionKeyRef.current = sessionKey;
    if (previous !== null && previous !== sessionKey) {
      setRouteStatus(null);
    }
  }, [deviceSession.transitioning, sessionKey]);

  // Returns whether the device session is still the one the mutation began
  // in. A route start or stop that settles after a switch is the old
  // session's route; the refresh in endRouteMutation fetches the new one.
  const beginRouteMutation = useCallback(() => {
    routeMutationCountRef.current += 1;
    const revision = deviceSessionStore.getSnapshot().revision;
    return () => deviceSessionStore.getSnapshot().revision === revision;
  }, []);

  const endRouteMutation = useCallback(() => {
    routeMutationCountRef.current = Math.max(
      0,
      routeMutationCountRef.current - 1,
    );
    // Drops any poll that started before the mutation settled.
    refreshRoute();
  }, [refreshRoute]);

  const progress =
    routeStatus && routeStatus.totalMeters > 0
      ? Math.min(100, Math.round((routeStatus.progressMeters / routeStatus.totalMeters) * 100))
      : 0;

  const startRoute = async () => {
    if (routePoints.length < 1) {
      onStatus("Load a route first");
      return;
    }
    const speed = Number(speedKph);
    const rate = Number(multiplier);
    if (!Number.isFinite(speed) || speed <= 0) {
      onStatus("Speed must be positive");
      return;
    }
    if (!Number.isFinite(rate) || rate <= 0) {
      onStatus("Rate must be positive");
      return;
    }
    const sameSession = beginRouteMutation();
    onStatus("Starting route...");
    try {
      const data = await apiRequest("/api/route", {
        method: "POST",
        body: {
          waypoints: routePoints,
          speedKph: speed,
          multiplier: rate,
          intervalMs: 1000,
          loop,
        },
      });
      if (sameSession()) setRouteStatus(data.route);
      onStatus("Route running");
    } catch (err) {
      onStatus(apiErrorMessage(err));
    } finally {
      endRouteMutation();
    }
  };

  const controlRoute = async (action: "pause" | "resume" | "stop") => {
    const sameSession = beginRouteMutation();
    try {
      const data = await apiRequest("/api/route/control", {
        method: "POST",
        body: { action },
      });
      if (sameSession()) setRouteStatus(data.route);
      onStatus(action === "stop" ? "Route stopped" : `Route ${data.route.status}`);
    } catch (err) {
      onStatus(apiErrorMessage(err));
    } finally {
      endRouteMutation();
    }
  };

  return (
    <section className="route-panel">
      <div className="panel-heading">
        <h2>Route</h2>
        <div className="location-status">{routeStatus?.status ?? "idle"} {progress}%</div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".gpx,.geojson,.json,.kml,application/json,application/geo+json"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          if (file) loader.load(file);
          clearFileInput();
        }}
      />
      <button
        disabled={!loader.parsing}
        onClick={() => {
          loader.cancel();
          clearFileInput();
        }}
      >
        Cancel load
      </button>
      <div className="route-meta">
        {routePoints.length} pts
        {drawnPoints !== null && drawnPoints < routePoints.length
          ? ` • ${drawnPoints} drawn`
          : ""}
        {routeStatus ? ` • ${formatDistance(routeStatus.progressMeters)} / ${formatDistance(routeStatus.totalMeters)}` : ""}
      </div>
      {routeStatus?.lastError ? (
        // Its own line, so the panel status (e.g. "Applied …") is not
        // overwritten on every poll while a route error persists.
        <div className="route-error" role="status">
          {routeStatus.lastError}
        </div>
      ) : null}
      <div className="coordinate-grid">
        <label>
          km/h
          <input
            inputMode="decimal"
            onChange={(e) => setSpeedKph(e.currentTarget.value)}
            value={speedKph}
          />
        </label>
        <label>
          Rate
          <input
            inputMode="decimal"
            onChange={(e) => setMultiplier(e.currentTarget.value)}
            value={multiplier}
          />
        </label>
      </div>
      <label className="toggle-row">
        <input
          checked={loop}
          onChange={(e) => setLoop(e.currentTarget.checked)}
          type="checkbox"
        />
        Loop
      </label>
      <label className="toggle-row">
        <input
          checked={followRoute}
          onChange={(e) => {
            const follow = e.currentTarget.checked;
            onFollowRouteChange(follow);
            if (follow) onRecenter(routeStatus?.currentLocation ?? draft);
          }}
          type="checkbox"
        />
        Follow route (panning turns this off)
      </label>
      <div className="route-actions">
        <button onClick={startRoute}>Play</button>
        <button
          onClick={() => {
            void controlRoute(routeStatus?.status === "paused" ? "resume" : "pause");
          }}
        >
          {routeStatus?.status === "paused" ? "Resume" : "Pause"}
        </button>
        <button
          onClick={() => {
            void controlRoute("stop");
          }}
        >
          Stop
        </button>
      </div>
    </section>
  );
}
