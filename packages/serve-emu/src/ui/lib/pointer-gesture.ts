type Point = { x: number; y: number };
type Position = { point: Point; clientX: number; clientY: number };

export type PointerGesture = Position & {
  pointerId: number;
  startPoint: Point;
  startClientX: number;
  startClientY: number;
  deferTap: boolean;
  forwarded: boolean;
};

export type PointerGestureEvent =
  | ({ type: "down"; pointerId: number; deferTap: boolean } & Position)
  | ({ type: "move" | "up"; pointerId: number } & Position)
  | { type: "cancel"; pointerId: number };

export type PointerGestureAction =
  | { type: "touch"; action: "down" | "move" | "up"; pointerId: number; x: number; y: number }
  | { type: "tap"; point: Point };

const DRAG_THRESHOLD_CSS_PX = 6;

/** Defers taps without losing the original DOWN when a gesture becomes a drag. */
export function reducePointerGesture(
  state: PointerGesture | null,
  event: PointerGestureEvent,
): { state: PointerGesture | null; actions: PointerGestureAction[] } {
  const touch = (action: "down" | "move" | "up", point: Point): PointerGestureAction =>
    ({ type: "touch", action, pointerId: event.pointerId, ...point });

  if (event.type === "down") {
    if (state) return { state, actions: [] };
    return {
      state: {
        pointerId: event.pointerId,
        point: event.point,
        clientX: event.clientX,
        clientY: event.clientY,
        startPoint: event.point,
        startClientX: event.clientX,
        startClientY: event.clientY,
        deferTap: event.deferTap,
        forwarded: !event.deferTap,
      },
      actions: event.deferTap ? [] : [touch("down", event.point)],
    };
  }
  if (!state || state.pointerId !== event.pointerId) return { state, actions: [] };
  if (event.type === "cancel") {
    return { state: null, actions: state.forwarded ? [touch("up", state.point)] : [] };
  }

  const startsDrag = !state.forwarded && Math.hypot(
    event.clientX - state.startClientX,
    event.clientY - state.startClientY,
  ) >= DRAG_THRESHOLD_CSS_PX;
  const next = { ...state, point: event.point, clientX: event.clientX, clientY: event.clientY,
    forwarded: state.forwarded || startsDrag };
  const actions: PointerGestureAction[] = startsDrag ? [touch("down", state.startPoint)] : [];
  if (event.type === "move") {
    if (next.forwarded) actions.push(touch("move", event.point));
    return { state: next, actions };
  }
  if (next.forwarded) {
    // A release can be the first observed event beyond the drag threshold.
    if (startsDrag) actions.push(touch("move", event.point));
    actions.push(touch("up", event.point));
  } else actions.push({ type: "tap", point: event.point });
  return { state: null, actions };
}
