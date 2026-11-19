import type { DeviceSize, StreamStats } from "../lib/use-stream";

type Props = {
  controlError?: string | null;
  onDismissError?: () => void;
  status: string;
  deviceSize: DeviceSize | null;
  fps: number;
  stats?: StreamStats | null;
  otherScrcpySessions?: number;
};

export function StatusBar({
  status,
  deviceSize,
  fps,
  stats,
  controlError,
  onDismissError,
  otherScrcpySessions = 0,
}: Props) {
  const frameRate = status === "streaming" && fps === 0 ? "idle" : `${fps} fps`;
  const latency = stats?.e2eMs != null ? ` • ${Math.round(stats.e2eMs)}ms` : "";
  const meta =
    status +
    (deviceSize
      ? ` • ${deviceSize.width}×${deviceSize.height} • ${frameRate}${latency}`
      : "");
  const detail = stats
    ? [
        stats.transitMs != null ? `transit ${stats.transitMs}ms` : null,
        stats.e2eMs != null ? `estimated server→canvas ${stats.e2eMs}ms` : null,
        `decode queue ${stats.decodeQueue} • pending ${stats.decodePendingMs}ms`,
        `skipped ${stats.skippedFrames}`,
        stats.decodeMsP95 !== null ? `decode p95 ${stats.decodeMsP95}ms` : null,
        stats.presentMsP95 !== null
          ? `presentation wait p95 ${stats.presentMsP95}ms`
          : null,
        `recoveries ${stats.recoveries}`,
        stats.clockUncertaintyMs !== null
          ? `clock estimate ±${stats.clockUncertaintyMs.toFixed(1)}ms`
          : null,
        stats.codec,
      ]
        .filter(Boolean)
        .join(" • ")
    : undefined;
  return (
    <header>
      <h1>serve-emu</h1>
      {controlError && (
        <span role="alert">
          Input failed: {controlError}{" "}
          <button onClick={onDismissError} aria-label="Dismiss input error">
            Dismiss
          </button>
        </span>
      )}
      {otherScrcpySessions > 0 && (
        <span
          className="contention"
          role="status"
          title="Every scrcpy session encodes the screen again, so each stream gets slower. Stop the other server or scrcpy client."
        >
          {otherScrcpySessions === 1
            ? "Another scrcpy session is streaming this device"
            : `${otherScrcpySessions} other scrcpy sessions are streaming this device`}
        </span>
      )}
      <div className="meta" title={detail}>
        {meta}
      </div>
    </header>
  );
}
