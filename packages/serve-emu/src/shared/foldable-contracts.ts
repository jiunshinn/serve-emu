export const FOLD_POSTURES = ["folded", "half-open", "unfolded"] as const;
export type FoldPosture = (typeof FOLD_POSTURES)[number];
export type FoldableState = {
  supported: boolean;
  posture: FoldPosture | "unknown";
  reason?: string;
};
export function isFoldPosture(value: unknown): value is FoldPosture {
  return typeof value === "string" && FOLD_POSTURES.includes(value as FoldPosture);
}
