import { useDeviceSessionSnapshot } from "../lib/device-session-store";
import { memo, useEffect, useMemo, useRef } from "react";
import type { PointerEvent, RefObject } from "react";
import {
  createLatestAnimationFrameScheduler,
  findAccessibilityNodeAt,
  measureAccessibilityViewport,
  type AccessibilityViewport,
  type LatestAnimationFrameScheduler,
  type NormalizedPoint,
} from "../lib/accessibility-hover";
import type { Sender } from "../lib/use-stream";
import { canvasPoint } from "../lib/canvas-point";
import { reducePointerGesture, type PointerGesture, type PointerGestureAction } from "../lib/pointer-gesture";
import type { AccessibilityNode } from "./accessibility-panel";

type Props = {
  canvasRef: RefObject<HTMLCanvasElement>;
  send: Sender;
  accessibilityNodes?: AccessibilityNode[];
  accessibilityEnabled?: boolean;
  highlightedAccessibilityId?: string | null;
  onAccessibilityHover?: (id: string | null) => void;
  deviceSize?: { width: number; height: number } | null;
  keyboardProxyRef?: RefObject<HTMLInputElement>;
  keyboardActive?: boolean;
  resetKey?: string | number;
  inputEnabled?: boolean;
  canvasLabel?: string;
  onTap?: (point: NormalizedPoint) => void;
};

type Point = NormalizedPoint;
type PointerSample = { point: Point; pointerId: number };

export function DeviceStream({
  canvasRef,
  send,
  accessibilityNodes = [],
  accessibilityEnabled = false,
  highlightedAccessibilityId = null,
  onAccessibilityHover,
  deviceSize = null,
  keyboardProxyRef,
  keyboardActive = true,
  resetKey,
  inputEnabled = true,
  canvasLabel,
  onTap,
}: Props) {
  const deviceSession = useDeviceSessionSnapshot();
  const pointerResetKey = resetKey ?? deviceSession.revision;
  const activeRef = useRef<PointerGesture | null>(null);
  const tapMode = onTap !== undefined;
  const hoverContextRef = useRef({
    enabled: accessibilityEnabled,
    nodes: accessibilityNodes,
    size: deviceSize as AccessibilityViewport | null,
    onHover: onAccessibilityHover,
    send,
    onTap,
  });
  const lastReportedHoverRef = useRef(highlightedAccessibilityId);
  const pointerMoveSchedulerRef = useRef<LatestAnimationFrameScheduler<PointerSample> | null>(null);
  const accessibilitySize = useMemo(
    () => measureAccessibilityViewport(accessibilityNodes, deviceSize),
    [accessibilityNodes, deviceSize],
  );

  hoverContextRef.current = {
    enabled: accessibilityEnabled,
    nodes: accessibilityNodes,
    size: accessibilitySize,
    onHover: onAccessibilityHover,
    send,
    onTap,
  };

  const reportAccessibilityHover = (id: string | null) => {
    if (id === lastReportedHoverRef.current) return;
    lastReportedHoverRef.current = id;
    hoverContextRef.current.onHover?.(id);
  };

  if (!pointerMoveSchedulerRef.current) {
    pointerMoveSchedulerRef.current = createLatestAnimationFrameScheduler(({ point, pointerId }) => {
      const active = activeRef.current;
      if (active && pointerId === active.pointerId) {
        if (!active.forwarded) return;
        hoverContextRef.current.send(
          { type: "touch", action: "move", x: point.x, y: point.y, pointerId: active.pointerId },
          false,
        );
        return;
      }

      const { enabled, nodes, size } = hoverContextRef.current;
      const hovered = enabled && size ? findAccessibilityNodeAt(nodes, point, size) : null;
      reportAccessibilityHover(hovered?.id ?? null);
    });
  }

  useEffect(() => {
    lastReportedHoverRef.current = highlightedAccessibilityId;
  }, [highlightedAccessibilityId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    activeRef.current = null;
    pointerMoveSchedulerRef.current?.cancel();
    return () => {
      pointerMoveSchedulerRef.current?.cancel();
      const active = activeRef.current;
      activeRef.current = null;
      // Explicitly scoped grid inputs keep their control sockets across view
      // changes. Release their held touch before hiding or disabling a card.
      // The default stream changes its server-side session on reset instead.
      if (active) {
        if (resetKey !== undefined || active.deferTap) {
          for (const action of reducePointerGesture(active, { type: "cancel", pointerId: active.pointerId }).actions) {
            if (action.type === "touch") hoverContextRef.current.send(action);
          }
        }
        try { canvas?.releasePointerCapture(active.pointerId); } catch {}
      }
    };
  }, [pointerResetKey, inputEnabled, tapMode]);

  useEffect(() => {
    if (accessibilityEnabled) return;
    if (!activeRef.current) pointerMoveSchedulerRef.current?.cancel();
    reportAccessibilityHover(null);
  }, [accessibilityEnabled]);

  const pointFromClient = (clientX: number, clientY: number): Point | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return canvasPoint(
      clientX, clientY, r, deviceSize ?? canvas,
      getComputedStyle(canvas).objectFit === "contain",
      activeRef.current !== null,
    );
  };

  const norm = (e: PointerEvent<HTMLCanvasElement>): Point | null =>
    pointFromClient(e.clientX, e.clientY);

  const dispatchPointerActions = (actions: PointerGestureAction[], scheduleMoves = true) => {
    for (const action of actions) {
      if (action.type === "tap") hoverContextRef.current.onTap?.(action.point);
      else if (action.action === "move" && scheduleMoves) {
        pointerMoveSchedulerRef.current?.schedule({ point: action, pointerId: action.pointerId });
      } else hoverContextRef.current.send(action, action.action !== "move");
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!inputEnabled) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (activeRef.current) return;
    const p = norm(e);
    if (!p) return;
    e.preventDefault();
    keyboardProxyRef?.current?.focus({ preventScroll: true });
    pointerMoveSchedulerRef.current?.cancel();
    reportAccessibilityHover(null);
    try { canvasRef.current?.setPointerCapture(e.pointerId); } catch {}
    const next = reducePointerGesture(null, {
      type: "down", pointerId: e.pointerId, point: p,
      clientX: e.clientX, clientY: e.clientY, deferTap: tapMode,
    });
    activeRef.current = next.state;
    dispatchPointerActions(next.actions);
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!inputEnabled) return;
    const active = activeRef.current;
    if (active && e.pointerId !== active.pointerId) return;
    const native = e.nativeEvent;
    const coalesced =
      typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : null;
    if (active) {
      e.preventDefault();
      // Classify every coalesced sample before reducing moves to one per frame.
      // An excursion past the threshold stays a drag even if it returns home.
      for (const sample of coalesced?.length ? coalesced : [e]) {
        const point = pointFromClient(sample.clientX, sample.clientY);
        if (!point) continue;
        const next = reducePointerGesture(activeRef.current, {
          type: "move", pointerId: e.pointerId, point,
          clientX: sample.clientX, clientY: sample.clientY,
        });
        activeRef.current = next.state;
        dispatchPointerActions(next.actions);
      }
      return;
    }
    const latest = coalesced && coalesced.length > 0 ? coalesced[coalesced.length - 1] : e;
    const point = pointFromClient(latest.clientX, latest.clientY);
    if (point) pointerMoveSchedulerRef.current?.schedule({ point, pointerId: e.pointerId });
    else reportAccessibilityHover(null);
  };

  const stopPointer = (e: PointerEvent<HTMLCanvasElement>, cancelled = false) => {
    const active = activeRef.current;
    if (!active || e.pointerId !== active.pointerId) return;
    cancelled ||= !inputEnabled;
    e.preventDefault();
    if (cancelled) pointerMoveSchedulerRef.current?.cancel();
    else pointerMoveSchedulerRef.current?.flush();
    const up = norm(e);
    const next = reducePointerGesture(active, cancelled || !up
      ? { type: "cancel", pointerId: active.pointerId }
      : { type: "up", pointerId: active.pointerId, point: up, clientX: e.clientX, clientY: e.clientY });
    activeRef.current = null;
    try {
      canvasRef.current?.releasePointerCapture(active.pointerId);
    } catch {}
    dispatchPointerActions(next.actions, false);
  };

  const onPointerLeave = () => {
    if (!activeRef.current) pointerMoveSchedulerRef.current?.cancel();
    reportAccessibilityHover(null);
  };

  return (
    <div className="stream-surface">
      <canvas
        ref={canvasRef}
        aria-label={canvasLabel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onPointerUp={(event) => stopPointer(event)}
        onPointerCancel={(event) => stopPointer(event, true)}
        onLostPointerCapture={(event) => stopPointer(event, true)}
        onContextMenu={(e) => e.preventDefault()}
      />
      {inputEnabled && !keyboardActive && (
        <button
          type="button"
          className="keyboard-hint"
          onClick={() => keyboardProxyRef?.current?.focus({ preventScroll: true })}
        >
          Click to resume keyboard input
        </button>
      )}
      {accessibilityEnabled && accessibilitySize && (
        <AccessibilityOverlay
          nodes={accessibilityNodes}
          size={accessibilitySize}
          highlightedId={highlightedAccessibilityId}
        />
      )}
    </div>
  );
}

const AccessibilityOverlay = memo(function AccessibilityOverlay({
  nodes,
  size,
  highlightedId,
}: {
  nodes: readonly AccessibilityNode[];
  size: AccessibilityViewport;
  highlightedId: string | null;
}) {
  const boundsPath = useMemo(
    () =>
      nodes
        .map(({ bounds }) =>
          `M${bounds.left} ${bounds.top}H${bounds.right}V${bounds.bottom}H${bounds.left}Z`)
        .join(""),
    [nodes],
  );
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const highlighted = highlightedId ? nodesById.get(highlightedId) : undefined;

  return (
    <svg
      className="ax-overlay"
      viewBox={`0 0 ${size.width} ${size.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path className="ax-bounds" d={boundsPath} />
      {highlighted ? (
        <rect
          className="ax-bound-active"
          x={highlighted.bounds.left}
          y={highlighted.bounds.top}
          width={highlighted.bounds.right - highlighted.bounds.left}
          height={highlighted.bounds.bottom - highlighted.bounds.top}
        />
      ) : null}
    </svg>
  );
});
