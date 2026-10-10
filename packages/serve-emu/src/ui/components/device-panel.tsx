import { useCallback, useMemo, useState } from "react";
import type {
  DeviceGridResponse,
  GridDevice,
  SessionStatus,
} from "../../shared/api-contracts";
import { apiErrorMessage, apiRequest } from "../lib/api-client";
import { DEVICE_SETTINGS, useDeviceSetting } from "../lib/device-setting";
import { deviceSessionStore, useDeviceSessionSnapshot } from "../lib/device-session-store";
import { usePoll } from "../lib/use-poll";

type BusyAction = "select" | "start" | "stop";
const FONT_SCALE_PRESETS = [0.85, 1, 1.15, 1.3, 1.5] as const;

export function DevicePanel() {
  const [devices, setDevices] = useState<GridDevice[]>([]);
  const [status, setStatus] = useState("Loading...");
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("streaming");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<Record<string, BusyAction | undefined>>({});
  const deviceSession = useDeviceSessionSnapshot();

  const loadDevices = useCallback(
    (signal?: AbortSignal) =>
      apiRequest("/api/device-grid", { method: "GET", cache: "no-store", signal }),
    [],
  );

  const applyDevices = useCallback((grid: DeviceGridResponse) => {
    setDevices(grid.devices);
    setSessionStatus(grid.sessionStatus);
    const running = grid.devices.filter((device) => device.serial && device.state === "device").length;
    setStatus(`${running}/${grid.devices.length} ready`);
  }, []);

  const applyDevicesError = useCallback((error: unknown) => {
    setDevices([]);
    setStatus(apiErrorMessage(error));
  }, []);

  const { refresh: refreshDevices } = usePoll({
    poll: ({ signal }) => loadDevices(signal),
    onResult: applyDevices,
    onError: applyDevicesError,
    intervalMs: null,
    pollKey: deviceSession.revision,
    enabled: !deviceSession.transitioning,
  });

  const runDeviceAction = useCallback(
    async (device: GridDevice, action: BusyAction) => {
      setBusy((current) => ({ ...current, [device.id]: action }));
      setStatus(action === "select" ? "Switching..." : action === "start" ? "Starting..." : "Stopping...");
      const changesSession = action === "select" || action === "start" || device.current;
      if (changesSession) {
        deviceSessionStore.beginTransition(action === "start" ? null : device.serial);
      }
      let nextSession: { serial?: string | null; generation?: number | null } | null = null;
      try {
        const result =
          action === "select"
            ? await apiRequest("/api/devices/select", {
                method: "POST",
                body: { serial: device.serial ?? "" },
              })
            : action === "start"
              ? await apiRequest("/api/avds/start", {
                  method: "POST",
                  body: { avd: device.avd ?? device.name },
                })
              : await apiRequest("/api/avds/stop", {
                  method: "POST",
                  body: { serial: device.serial ?? undefined, avd: device.avd ?? undefined },
                });
        if (changesSession) nextSession = result;
      } catch (err) {
        setStatus(apiErrorMessage(err));
      } finally {
        if (changesSession) {
          deviceSessionStore.endTransition();
          if (nextSession) deviceSessionStore.applyHealth(nextSession);
        }
        refreshDevices();
        setBusy((current) => {
          const next = { ...current };
          delete next[device.id];
          return next;
        });
      }
    },
    [refreshDevices],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().replace(/^\/+/, "").toLowerCase();
    if (!needle) return devices;
    return devices.filter((device) =>
      [device.name, device.serial ?? "", device.avd ?? "", device.kind, device.state]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [devices, query]);

  return (
    <section className="device-panel">
      <div className="panel-heading">
        <h2>Devices</h2>
        <div className="location-status">{status}</div>
      </div>

      <div className="device-search">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search devices and AVDs"
        />
        {query ? <button onClick={() => setQuery("")}>Clear</button> : null}
      </div>

      <div className="device-list android-grid-list">
        {filtered.length === 0 ? (
          <div className="device-empty">{query ? "No matching Android targets." : "No Android targets found."}</div>
        ) : (
          filtered.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              sessionStatus={sessionStatus}
              busy={busy[device.id]}
              onSelect={() => void runDeviceAction(device, "select")}
              onStart={() => void runDeviceAction(device, "start")}
              onStop={() => void runDeviceAction(device, "stop")}
            />
          ))
        )}
      </div>

      <button onClick={refreshDevices}>Refresh Devices</button>
    </section>
  );
}

type SettingOption<Next> = { value: Next; label: string };

/** A device setting's heading, status line, and one button per option. */
function SettingPanel<Value, Next extends Value>({
  title,
  className,
  rowClassName = "segmented-row",
  setting,
  options,
  isSelected = (value, option) => value === option,
}: {
  title: string;
  className: string;
  rowClassName?: string;
  setting: ReturnType<typeof useDeviceSetting<Value, Next>>;
  options: readonly SettingOption<Next>[];
  isSelected?: (value: Value, option: Next) => boolean;
}) {
  return (
    <section className={`tool-panel ${className}`}>
      <div className="panel-heading">
        <h2>{title}</h2>
        <div className="location-status">{setting.status}</div>
      </div>
      <div className={rowClassName}>
        {options.map((option) => (
          <button
            key={String(option.value)}
            className={isSelected(setting.value, option.value) ? "selected" : ""}
            onClick={() => void setting.apply(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  );
}

export function OrientationPanel() {
  return (
    <SettingPanel
      title="Orientation"
      className="orientation-panel"
      setting={useDeviceSetting(DEVICE_SETTINGS.orientation)}
      options={[
        { value: "portrait", label: "Portrait" },
        { value: "landscape", label: "Landscape" },
        { value: "auto", label: "Auto" },
      ]}
    />
  );
}

export function NightModePanel() {
  return (
    <SettingPanel
      title="Theme"
      className="night-mode-panel"
      setting={useDeviceSetting(DEVICE_SETTINGS.nightMode)}
      options={[
        { value: "dark", label: "Dark" },
        { value: "light", label: "Light" },
        { value: "auto", label: "Auto" },
      ]}
    />
  );
}

export function FontScalePanel() {
  return (
    <SettingPanel
      title="Font Size"
      className="font-scale-panel"
      rowClassName="font-scale-row"
      setting={useDeviceSetting(DEVICE_SETTINGS.fontScale)}
      options={FONT_SCALE_PRESETS.map((scale) => ({
        value: scale,
        label: `${Math.round(scale * 100)}%`,
      }))}
      isSelected={(value, option) => value !== null && Math.abs(value - option) < 0.01}
    />
  );
}

export function NetworkPanel() {
  return (
    <SettingPanel
      title="Network"
      className="network-panel"
      rowClassName="segmented-row network-row"
      setting={useDeviceSetting(DEVICE_SETTINGS.network)}
      options={[
        { value: true, label: "On" },
        { value: false, label: "Off" },
      ]}
    />
  );
}

function DeviceRow({
  device,
  sessionStatus,
  busy,
  onSelect,
  onStart,
  onStop,
}: {
  device: GridDevice;
  sessionStatus: SessionStatus;
  busy: BusyAction | undefined;
  onSelect: () => void;
  onStart: () => void;
  onStop: () => void;
}) {
  const isLiveCurrent = device.current && sessionStatus === "streaming";
  const status = device.current ? sessionStatus : device.state;
  const title = device.kind === "avd" ? "AVD" : device.kind === "emulator" ? "EMU" : "USB";

  return (
    <div className={device.current ? "device-row grid-device-row current" : "device-row grid-device-row"}>
      <button
        type="button"
        className="device-row-main"
        disabled={!device.canSelect || Boolean(busy) || isLiveCurrent}
        onClick={onSelect}
      >
        <span className="device-kind" title={device.kind}>{title}</span>
        <span className="device-name">{device.name}</span>
        <span className="device-subtitle">{device.serial ?? device.avd ?? "not running"}</span>
      </button>
      <div className="device-row-actions">
        <code>{busy ?? status}</code>
        {device.canStart ? (
          <button disabled={Boolean(busy)} onClick={onStart}>
            Start
          </button>
        ) : null}
        {device.canStop ? (
          <button disabled={Boolean(busy)} onClick={onStop}>
            Stop
          </button>
        ) : null}
      </div>
    </div>
  );
}
