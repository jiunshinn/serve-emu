import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { StreamQuality } from "../../shared/api-contracts";
import { apiErrorMessage, apiRequest, createApiClient } from "../lib/api-client";
import { deviceBase } from "../lib/base-path";

// Background tiles run cheap so the emulators keep CPU for the device in use.
const TILE_QUALITY = {
  low: { maxSize: 480, maxFps: 15 },
  medium: { maxSize: 720, maxFps: 30 },
} as const;
type TileQuality = keyof typeof TILE_QUALITY | "device";

const sameQuality = (current: StreamQuality, target: Partial<StreamQuality>) =>
  (target.maxSize === undefined || current.maxSize === target.maxSize) &&
  (target.maxFps === undefined || current.maxFps === target.maxFps) &&
  (target.bitRate === undefined || current.bitRate === target.bitRate);

/** Live tiles of every online device, each streamed under `/d/<serial>/`. */
export function DeviceGrid() {
  const [serials, setSerials] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tileQuality, setTileQuality] = useState<TileQuality>("low");
  const [ready, setReady] = useState<ReadonlySet<string>>(new Set());
  const [tileErrors, setTileErrors] = useState<Record<string, string>>({});
  // Each device's quality before the grid changed it, and its quality now.
  const original = useRef(new Map<string, StreamQuality>());
  const current = useRef(new Map<string, StreamQuality>());

  useEffect(() => {
    const controller = new AbortController();
    apiRequest("/api/devices", { method: "GET", cache: "no-store", signal: controller.signal }).then(
      (list) => setSerials(list.devices.filter((d) => d.state === "device").map((d) => d.serial)),
      (err: unknown) => {
        if (!controller.signal.aborted) setError(apiErrorMessage(err));
      },
    );
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!serials) return;
    let cancelled = false;
    for (const serial of serials) {
      const request = createApiClient(globalThis.fetch, deviceBase(serial));
      void (async () => {
        try {
          if (!original.current.has(serial)) {
            const read = await request("/api/stream-quality", { method: "GET", cache: "no-store" });
            original.current.set(serial, read.quality);
            current.current.set(serial, read.quality);
          }
          const target = tileQuality === "device" ? original.current.get(serial)! : TILE_QUALITY[tileQuality];
          if (!sameQuality(current.current.get(serial)!, target)) {
            const set = await request("/api/stream-quality", { method: "POST", body: target });
            current.current.set(serial, set.quality);
          }
          if (cancelled) return;
          setReady((prev) => new Set(prev).add(serial));
          setTileErrors(({ [serial]: _cleared, ...rest }) => rest);
        } catch (err) {
          if (!cancelled) setTileErrors((prev) => ({ ...prev, [serial]: apiErrorMessage(err) }));
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [serials, tileQuality]);

  // Leaving the grid gives every device its own quality back.
  useEffect(() => {
    const restore = () => {
      for (const [serial, saved] of original.current) {
        const now = current.current.get(serial);
        if (!now || sameQuality(saved, now)) continue;
        void createApiClient(globalThis.fetch, deviceBase(serial))("/api/stream-quality", {
          method: "POST",
          body: saved,
          keepalive: true,
        }).catch(() => {});
        current.current.set(serial, saved);
      }
    };
    window.addEventListener("pagehide", restore);
    return () => window.removeEventListener("pagehide", restore);
  }, []);

  // The opened device gets its own quality back before its full UI loads.
  const open = (serial: string) => async (event: MouseEvent<HTMLAnchorElement>) => {
    // A new-tab click keeps the grid, and its tiles, open.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const saved = original.current.get(serial);
    const now = current.current.get(serial);
    if (!saved || !now || sameQuality(saved, now)) return;
    event.preventDefault();
    const href = event.currentTarget.href;
    try {
      await createApiClient(globalThis.fetch, deviceBase(serial))("/api/stream-quality", {
        method: "POST",
        body: saved,
      });
      current.current.set(serial, saved);
    } finally {
      location.assign(href);
    }
  };

  return (
    <div className="grid-page">
      <header>
        <h1>serve-emu devices</h1>
        <label className="grid-quality">
          Tile quality{" "}
          <select value={tileQuality} onChange={(e) => setTileQuality(e.target.value as TileQuality)}>
            <option value="low">Low (480p, 15 fps)</option>
            <option value="medium">Medium (720p, 30 fps)</option>
            <option value="device">Device setting</option>
          </select>
        </label>
        <a href="/">Selected device</a>
      </header>
      {error && <p className="grid-message">{error}</p>}
      {serials?.length === 0 && <p className="grid-message">No devices are online.</p>}
      <div className="grid-tiles">
        {serials?.map((serial) => (
          <section key={serial} className="grid-tile" aria-label={serial}>
            <header>
              <span>{serial}</span>
              <a href={`${deviceBase(serial)}/`} onClick={open(serial)}>
                Open
              </a>
            </header>
            {tileErrors[serial] ? (
              <p className="grid-message">{tileErrors[serial]}</p>
            ) : ready.has(serial) ? (
              <iframe title={serial} src={`${deviceBase(serial)}/?tile=1`} />
            ) : (
              <p className="grid-message">Starting…</p>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
