type CanvasBounds = { left: number; top: number; width: number; height: number };
type CanvasSize = { width: number; height: number };

/** Maps the visible canvas image, excluding centered object-fit padding. */
export function canvasPoint(
  clientX: number,
  clientY: number,
  bounds: CanvasBounds,
  size: CanvasSize,
  contain: boolean,
  clamp: boolean,
): { x: number; y: number } | null {
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  let { left, top, width, height } = bounds;
  if (contain && size.width > 0 && size.height > 0) {
    const scale = Math.min(width / size.width, height / size.height);
    const contentWidth = size.width * scale;
    const contentHeight = size.height * scale;
    left += (width - contentWidth) / 2;
    top += (height - contentHeight) / 2;
    width = contentWidth;
    height = contentHeight;
  }
  const x = (clientX - left) / width;
  const y = (clientY - top) / height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}
