import { describe, expect, test } from "bun:test";
import { canvasPoint } from "../src/ui/lib/canvas-point.ts";

describe("canvas input coordinates", () => {
  const bounds = { left: 20, top: 30, width: 400, height: 400 };

  test("maps portrait content independently of side padding", () => {
    expect(canvasPoint(145, 130, bounds, { width: 100, height: 200 }, true, false))
      .toEqual({ x: 0.125, y: 0.25 });
    expect(canvasPoint(100, 230, bounds, { width: 100, height: 200 }, true, false)).toBeNull();
  });

  test("maps landscape content independently of top padding", () => {
    expect(canvasPoint(320, 180, bounds, { width: 200, height: 100 }, true, false))
      .toEqual({ x: 0.75, y: 0.25 });
    expect(canvasPoint(220, 80, bounds, { width: 200, height: 100 }, true, false)).toBeNull();
  });

  test("clamps captured drags at the visible image edge", () => {
    expect(canvasPoint(-100, 500, bounds, { width: 100, height: 200 }, true, true))
      .toEqual({ x: 0, y: 1 });
  });

  test("preserves full-element coordinates without object-fit contain", () => {
    expect(canvasPoint(120, 130, bounds, { width: 100, height: 200 }, false, false))
      .toEqual({ x: 0.25, y: 0.25 });
  });

  test("rejects empty canvas bounds and invalid pointer coordinates", () => {
    expect(canvasPoint(0, 0, { ...bounds, width: 0 }, { width: 100, height: 200 }, true, true)).toBeNull();
    expect(canvasPoint(NaN, 0, bounds, { width: 100, height: 200 }, true, true)).toBeNull();
  });
});
