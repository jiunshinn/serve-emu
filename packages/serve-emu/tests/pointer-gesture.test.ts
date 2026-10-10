import { describe, expect, test } from "bun:test";
import { reducePointerGesture, type PointerGestureEvent } from "../src/ui/lib/pointer-gesture.ts";

const down = (deferTap = true): PointerGestureEvent => ({
  type: "down", pointerId: 1, deferTap, point: { x: 0.25, y: 0.5 }, clientX: 100, clientY: 200,
});
const sample = (type: "move" | "up", clientX: number, clientY: number): PointerGestureEvent => ({
  type, pointerId: 1, point: { x: clientX / 400, y: clientY / 400 }, clientX, clientY,
});

describe("deferred pointer taps", () => {
  test("a tap with mouse jitter emits no raw touch packets", () => {
    const start = reducePointerGesture(null, down());
    expect(start.actions).toEqual([]);
    const jitter = reducePointerGesture(start.state, sample("move", 103, 203));
    expect(jitter.actions).toEqual([]);
    const end = reducePointerGesture(jitter.state, sample("up", 101, 202));
    expect(end.state).toBeNull();
    expect(end.actions).toEqual([{ type: "tap", point: { x: 0.2525, y: 0.505 } }]);
  });

  test("crossing six CSS pixels emits the original down before the first drag move", () => {
    const start = reducePointerGesture(null, down());
    const drag = reducePointerGesture(start.state, sample("move", 106, 200));
    expect(drag.state!.forwarded).toBe(true);
    expect(drag.actions).toEqual([
      { type: "touch", action: "down", pointerId: 1, x: 0.25, y: 0.5 },
      { type: "touch", action: "move", pointerId: 1, x: 0.265, y: 0.5 },
    ]);
  });

  test("uses CSS distance rather than normalized device coordinates", () => {
    const start = reducePointerGesture(null, down());
    const tinyDeviceMovement = reducePointerGesture(start.state, {
      type: "move", pointerId: 1, point: { x: 0.2501, y: 0.5 }, clientX: 106, clientY: 200,
    });
    expect(tinyDeviceMovement.actions.map((action) => action.type === "touch" && action.action))
      .toEqual(["down", "move"]);
    const largeDeviceMovement = reducePointerGesture(start.state, {
      type: "move", pointerId: 1, point: { x: 0.9, y: 0.9 }, clientX: 101, clientY: 201,
    });
    expect(largeDeviceMovement.actions).toEqual([]);
  });

  test("returning to the start remains a drag, including coalesced excursions", () => {
    const start = reducePointerGesture(null, down());
    const away = reducePointerGesture(start.state, sample("move", 150, 250));
    const back = reducePointerGesture(away.state, sample("move", 100, 200));
    expect(back.actions).toEqual([{ type: "touch", action: "move", pointerId: 1, x: 0.25, y: 0.5 }]);
    const end = reducePointerGesture(back.state, sample("up", 100, 200));
    expect(end.actions).toEqual([{ type: "touch", action: "up", pointerId: 1, x: 0.25, y: 0.5 }]);
  });

  test("a release beyond the threshold without a move still produces a complete drag", () => {
    const start = reducePointerGesture(null, down());
    const end = reducePointerGesture(start.state, sample("up", 140, 200));
    expect(end.actions).toEqual([
      { type: "touch", action: "down", pointerId: 1, x: 0.25, y: 0.5 },
      { type: "touch", action: "move", pointerId: 1, x: 0.35, y: 0.5 },
      { type: "touch", action: "up", pointerId: 1, x: 0.35, y: 0.5 },
    ]);
    expect(end.state).toBeNull();
  });

  test("cancellation never creates a tap and releases an already forwarded drag", () => {
    const start = reducePointerGesture(null, down());
    expect(reducePointerGesture(start.state, { type: "cancel", pointerId: 1 }))
      .toEqual({ state: null, actions: [] });
    const drag = reducePointerGesture(start.state, sample("move", 140, 240));
    expect(reducePointerGesture(drag.state, { type: "cancel", pointerId: 1 }))
      .toEqual({ state: null, actions: [{ type: "touch", action: "up", pointerId: 1, x: 0.35, y: 0.6 }] });
  });

  test("ignores other pointers without replacing the active gesture", () => {
    const start = reducePointerGesture(null, down());
    for (const event of [
      { ...down(), pointerId: 2 },
      { ...sample("move", 150, 250), pointerId: 2 },
      { ...sample("up", 150, 250), pointerId: 2 },
      { type: "cancel", pointerId: 2 } as const,
    ]) {
      const next = reducePointerGesture(start.state, event);
      expect(next.state).toBe(start.state);
      expect(next.actions).toEqual([]);
    }
  });

  test("default mode preserves immediate normalized touch forwarding", () => {
    const start = reducePointerGesture(null, down(false));
    expect(start.actions).toEqual([{ type: "touch", action: "down", pointerId: 1, x: 0.25, y: 0.5 }]);
    const move = reducePointerGesture(start.state, sample("move", 101, 201));
    expect(move.actions).toEqual([{ type: "touch", action: "move", pointerId: 1, x: 0.2525, y: 0.5025 }]);
    const end = reducePointerGesture(move.state, sample("up", 100, 200));
    expect(end.actions).toEqual([{ type: "touch", action: "up", pointerId: 1, x: 0.25, y: 0.5 }]);
  });
});
