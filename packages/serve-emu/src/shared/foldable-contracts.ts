export const FOLD_POSTURES = ["folded", "half-open", "unfolded"] as const;
export type FoldPosture = (typeof FOLD_POSTURES)[number];
export type FoldableState = {
  supported: boolean;
  posture: FoldPosture | "unknown";
  reason?: string;
  /**
   * Set after folding: whether the display size
   * changed. `false` means Android switched posture on a single display.
   */
  displayChanged?: boolean;
};
export function isFoldPosture(value: unknown): value is FoldPosture {
  return typeof value === "string" && FOLD_POSTURES.includes(value as FoldPosture);
}
