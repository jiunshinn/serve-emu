import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MutableRefObject, PointerEvent } from "react";
import {
  MAP_TILE_SIZE,
  nearestWrappedWorldX,
  projectLocation,
  routeViewportTransform,
  unprojectLocation,
  worldSizeAtZoom,
  type LocationPoint,
  type ProjectedDisplayRoute,
} from "../lib/route-map";

type Point = { x: number; y: number };
type Tile = { key: string; x: number; y: number; left: number; top: number; wrappedX: number };
type MapDrag = {
  pointerId: number;
  start: Point;
  center: Point;
  zoom: number;
  dx: number;
  dy: number;
  moved: boolean;
};

const TILE_SIZE = MAP_TILE_SIZE;
const TILE_OVERSCAN = 1;
const DEFAULT_SIZE = { width: 320, height: 220 };

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function normalizedTileX(x: number, zoom: number): number {
  const count = 2 ** zoom;
  return ((x % count) + count) % count;
}

function tileUrl(tile: Tile, zoom: number): string {
  return `https://tile.openstreetmap.org/${zoom}/${tile.wrappedX}/${tile.y}.png`;
}

export type LocationMapProps = {
  center: LocationPoint;
  zoom: number;
  /** Where the marker sits: the location that Set Location would apply. */
  marker: LocationPoint;
  route: ProjectedDisplayRoute | null;
  /** A drag ended: the map is now centered here. */
  onCenterChange: (center: LocationPoint) => void;
  /** A click without a drag picked this location. */
  onPick: (location: LocationPoint) => void;
  /** A drag moved the map, which turns route following off. */
  onPan: () => void;
  /** True while a pointer is down on the map, so a route poll does not recenter under it. */
  pointerActiveRef: MutableRefObject<boolean>;
};

/**
 * An OpenStreetMap tile viewport with a marker and a route overlay. A drag
 * pans it with a CSS transform and commits the new center once, on release;
 * a click picks a location.
 */
export function LocationMap({
  center,
  zoom,
  marker,
  route,
  onCenterChange,
  onPick,
  onPan,
  pointerActiveRef,
}: LocationMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapWorldRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<MapDrag | null>(null);
  const dragFrameRef = useRef(0);
  const [size, setSize] = useState(DEFAULT_SIZE);

  useEffect(() => {
    const node = mapRef.current;
    if (!node) return;
    const updateSize = () => {
      const rect = node.getBoundingClientRect();
      setSize({
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const centerPixel = useMemo(
    () => projectLocation(center, zoom),
    [center, zoom],
  );
  const markerPixel = useMemo(
    () => projectLocation(marker, zoom),
    [marker, zoom],
  );

  const tiles = useMemo<Tile[]>(() => {
    const maxTile = 2 ** zoom - 1;
    const leftWorld = centerPixel.x - size.width / 2;
    const topWorld = centerPixel.y - size.height / 2;
    const startX = Math.floor(leftWorld / TILE_SIZE) - TILE_OVERSCAN;
    const endX =
      Math.floor((leftWorld + size.width) / TILE_SIZE) + TILE_OVERSCAN;
    const startY = clamp(
      Math.floor(topWorld / TILE_SIZE) - TILE_OVERSCAN,
      0,
      maxTile,
    );
    const endY = clamp(
      Math.floor((topWorld + size.height) / TILE_SIZE) + TILE_OVERSCAN,
      0,
      maxTile,
    );
    const out: Tile[] = [];
    for (let y = startY; y <= endY; y++) {
      for (let x = startX; x <= endX; x++) {
        out.push({
          key: `${zoom}-${x}-${y}`,
          x,
          y,
          wrappedX: normalizedTileX(x, zoom),
          left: x * TILE_SIZE - leftWorld,
          top: y * TILE_SIZE - topWorld,
        });
      }
    }
    return out;
  }, [centerPixel, size.height, size.width, zoom]);

  const routeTransform = useMemo(
    () => route ? routeViewportTransform(route, centerPixel, size) : null,
    [centerPixel, route, size],
  );

  const locationFromClient = (clientX: number, clientY: number): LocationPoint | null => {
    const node = mapRef.current;
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return unprojectLocation(
      {
        x: centerPixel.x + clientX - rect.left - rect.width / 2,
        y: centerPixel.y + clientY - rect.top - rect.height / 2,
      },
      zoom,
    );
  };

  const markerWorldX = nearestWrappedWorldX(
    markerPixel.x,
    centerPixel.x,
    worldSizeAtZoom(zoom),
  );
  const markerLeft = markerWorldX - centerPixel.x + size.width / 2;
  const markerTop = markerPixel.y - centerPixel.y + size.height / 2;

  useLayoutEffect(() => {
    if (!dragRef.current && mapWorldRef.current) {
      mapWorldRef.current.style.transform = "";
    }
  }, [centerPixel.x, centerPixel.y]);

  useEffect(() => {
    return () => {
      if (dragFrameRef.current) cancelAnimationFrame(dragFrameRef.current);
    };
  }, []);

  const endDrag = () => {
    dragRef.current = null;
    pointerActiveRef.current = false;
    if (dragFrameRef.current) {
      cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = 0;
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (dragRef.current) return;
    e.preventDefault();
    mapRef.current?.setPointerCapture(e.pointerId);
    pointerActiveRef.current = true;
    dragRef.current = {
      pointerId: e.pointerId,
      start: { x: e.clientX, y: e.clientY },
      center: centerPixel,
      zoom,
      dx: 0,
      dy: 0,
      moved: false,
    };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const coalesced = typeof e.nativeEvent.getCoalescedEvents === "function"
      ? e.nativeEvent.getCoalescedEvents()
      : [];
    const latest = coalesced[coalesced.length - 1] ?? e;
    drag.dx = latest.clientX - drag.start.x;
    drag.dy = latest.clientY - drag.start.y;
    if (Math.abs(drag.dx) + Math.abs(drag.dy) > 4 && !drag.moved) {
      drag.moved = true;
    }
    if (!drag.moved) return;
    if (!dragFrameRef.current) {
      dragFrameRef.current = requestAnimationFrame(() => {
        dragFrameRef.current = 0;
        const active = dragRef.current;
        if (!active || !mapWorldRef.current) return;
        onPan();
        mapWorldRef.current.style.transform =
          `translate3d(${active.dx}px, ${active.dy}px, 0)`;
      });
    }
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.dx = e.clientX - drag.start.x;
    drag.dy = e.clientY - drag.start.y;
    if (Math.abs(drag.dx) + Math.abs(drag.dy) > 4) drag.moved = true;
    if (drag.moved) onPan();
    endDrag();
    try {
      mapRef.current?.releasePointerCapture(e.pointerId);
    } catch {}
    if (drag.moved) {
      if (mapWorldRef.current) mapWorldRef.current.style.transform = "";
      onCenterChange(
        unprojectLocation(
          { x: drag.center.x - drag.dx, y: drag.center.y - drag.dy },
          drag.zoom,
        ),
      );
      return;
    }
    const next = locationFromClient(e.clientX, e.clientY);
    if (next) onPick(next);
  };

  const cancelPointer = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    endDrag();
    if (mapWorldRef.current) mapWorldRef.current.style.transform = "";
  };

  return (
    <div
      className="map"
      ref={mapRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancelPointer}
      onLostPointerCapture={cancelPointer}
    >
      <div className="map-world" ref={mapWorldRef}>
        {tiles.map((tile) => (
          <img
            alt=""
            className="map-tile"
            decoding="async"
            draggable={false}
            key={tile.key}
            loading="lazy"
            src={tileUrl(tile, zoom)}
            style={{
              left: tile.left,
              top: tile.top,
            }}
          />
        ))}
        {route && routeTransform && (
          <svg
            className="route-overlay"
            viewBox={`0 0 ${size.width} ${size.height}`}
          >
            <polyline
              points={route.svgPoints}
              transform={
                `translate(${routeTransform.translateX} ${routeTransform.translateY})`
              }
            />
          </svg>
        )}
        <div
          className="map-marker"
          style={{
            transform: `translate(${markerLeft}px, ${markerTop}px)`,
          }}
        />
      </div>
      <div className="map-attribution">© OpenStreetMap</div>
    </div>
  );
}
