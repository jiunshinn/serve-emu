import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RouteProjectionCache,
  wrapLongitude,
  type LocationPoint,
} from "../lib/route-map";
import { apiErrorMessage, apiRequest } from "../lib/api-client";
import { settledSessionKey, useDeviceSessionSnapshot } from "../lib/device-session-store";
import { LocationMap } from "./location-map";
import { RoutePlaybackPanel } from "./route-playback-panel";

const MIN_ZOOM = 2;
const MAX_ZOOM = 18;
const DEFAULT_LOCATION: LocationPoint = { latitude: 37.5665, longitude: 126.978 };

const PRESETS: (LocationPoint & { label: string })[] = [
  { label: "Seoul", latitude: 37.5665, longitude: 126.978 },
  { label: "London", latitude: 51.5072, longitude: -0.1276 },
  { label: "SF", latitude: 37.7749, longitude: -122.4194 },
];

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function formatCoord(n: number): string {
  return n.toFixed(6);
}

export function LocationPanel() {
  const mapPointerActiveRef = useRef(false);
  const routeProjectionCache = useMemo(() => new RouteProjectionCache(), []);
  const [zoom, setZoom] = useState(12);
  const [center, setCenter] = useState<LocationPoint>(DEFAULT_LOCATION);
  const [draft, setDraft] = useState<LocationPoint>(DEFAULT_LOCATION);
  const [latText, setLatText] = useState(formatCoord(DEFAULT_LOCATION.latitude));
  const [lngText, setLngText] = useState(formatCoord(DEFAULT_LOCATION.longitude));
  const [status, setStatus] = useState("Ready");
  const [routePoints, setRoutePoints] = useState<LocationPoint[]>([]);
  const [followRoute, setFollowRoute] = useState(true);

  const syncDraft = useCallback((next: LocationPoint, recenter = false) => {
    const normalized = {
      latitude: clamp(next.latitude, -85.05112878, 85.05112878),
      longitude: wrapLongitude(next.longitude),
    };
    setDraft(normalized);
    setLatText(formatCoord(normalized.latitude));
    setLngText(formatCoord(normalized.longitude));
    if (recenter) setCenter(normalized);
  }, []);

  // The panel stays mounted across device switches. Load the location on
  // mount, and once a different session has settled, drop the previous
  // device's fix and status before loading the new device's location.
  const sessionKey = settledSessionKey(useDeviceSessionSnapshot());
  const locationSessionRef = useRef<string | null | undefined>(undefined);
  const locationRequestRef = useRef(0);
  useEffect(() => {
    const previous = locationSessionRef.current;
    if (previous !== undefined) {
      if (sessionKey === null || sessionKey === previous) return;
      locationSessionRef.current = sessionKey;
      // The mount fetch already covered the first settled session.
      if (previous === null) return;
      setStatus("Ready");
      syncDraft(DEFAULT_LOCATION, true);
    } else {
      locationSessionRef.current = sessionKey;
    }
    const request = ++locationRequestRef.current;
    apiRequest("/api/location", { method: "GET" })
      .then((data) => {
        if (request !== locationRequestRef.current) return;
        if (data.location) syncDraft(data.location, true);
      })
      .catch(() => {});
  }, [sessionKey, syncDraft]);

  const displayRoute = useMemo(
    () => routePoints.length > 0
      ? routeProjectionCache.get(routePoints, routePoints, zoom)
      : null,
    [routePoints, routeProjectionCache, zoom],
  );

  const applyLocation = async (location = draft) => {
    setStatus("Setting...");
    try {
      await apiRequest("/api/location", {
        method: "POST",
        body: {
          latitude: location.latitude,
          longitude: location.longitude,
        },
      });
      setStatus(`Applied ${formatCoord(location.latitude)}, ${formatCoord(location.longitude)}`);
    } catch (err) {
      setStatus(apiErrorMessage(err));
    }
  };

  const applyText = () => {
    const latitude = Number(latText);
    const longitude = Number(lngText);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      setStatus("Coordinates must be numbers");
      return;
    }
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      setStatus("Coordinates are out of range");
      return;
    }
    const next = { latitude, longitude };
    syncDraft(next, true);
    void applyLocation(next);
  };

  return (
    <aside className="location-panel">
      <div className="panel-heading">
        <h2>Location</h2>
        <div className="location-status">{status}</div>
      </div>
      <LocationMap
        center={center}
        zoom={zoom}
        marker={draft}
        route={displayRoute}
        onCenterChange={setCenter}
        onPick={(location) => syncDraft(location)}
        onPan={() => setFollowRoute(false)}
        pointerActiveRef={mapPointerActiveRef}
      />
      <div className="map-controls">
        <button onClick={() => setZoom((z) => clamp(z + 1, MIN_ZOOM, MAX_ZOOM))}>+</button>
        <button onClick={() => setZoom((z) => clamp(z - 1, MIN_ZOOM, MAX_ZOOM))}>-</button>
        <button onClick={() => setCenter(draft)}>Center</button>
      </div>
      <div className="coordinate-grid">
        <label>
          Lat
          <input
            inputMode="decimal"
            onChange={(e) => setLatText(e.currentTarget.value)}
            value={latText}
          />
        </label>
        <label>
          Lng
          <input
            inputMode="decimal"
            onChange={(e) => setLngText(e.currentTarget.value)}
            value={lngText}
          />
        </label>
      </div>
      <div className="preset-row">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            onClick={() => {
              syncDraft(preset, true);
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <button className="primary-action" onClick={applyText}>
        Set Location
      </button>
      <RoutePlaybackPanel
        routePoints={routePoints}
        drawnPoints={displayRoute?.points.length ?? null}
        followRoute={followRoute}
        onFollowRouteChange={setFollowRoute}
        draft={draft}
        mapPointerActiveRef={mapPointerActiveRef}
        onRecenter={setCenter}
        onRouteLoaded={(points) => {
          routeProjectionCache.clear();
          setRoutePoints(points);
          syncDraft(points[0]!, true);
        }}
        onRoutePosition={syncDraft}
        onStatus={setStatus}
      />
    </aside>
  );
}
