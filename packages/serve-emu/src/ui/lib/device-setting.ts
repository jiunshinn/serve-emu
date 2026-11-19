import { useCallback, useMemo, useRef, useState } from "react";
import type {
  NetworkStatus,
  NightMode,
  OrientationMode,
} from "../../shared/api-contracts";
import { apiErrorMessage, apiRequest } from "./api-client";
import { useDeviceSessionSnapshot } from "./device-session-store";
import { usePoll } from "./use-poll";

export type DeviceSettingView<Value> = { value: Value; status: string };

/** How one device setting is read and written; see DEVICE_SETTINGS. */
export type DeviceSettingSpec<Value, Next extends Value = Value> = {
  /** The value shown when the setting is unknown or failed to load. */
  unknown: Value;
  load(signal: AbortSignal): Promise<DeviceSettingView<Value>>;
  save(next: Next): Promise<DeviceSettingView<Value>>;
};

const LOADING_STATUS = "Loading...";
export const APPLYING_STATUS = "Applying...";

/**
 * The settings panels' load/apply/error flow, without React: a load failure
 * resets the value; an apply shows "Applying...", then the saved value (and
 * refreshes), or the error with the value left as it was.
 */
export function createDeviceSettingFlow<Value, Next extends Value>(
  spec: DeviceSettingSpec<Value, Next>,
  update: (patch: Partial<DeviceSettingView<Value>>) => void,
  refresh: () => void,
) {
  return {
    loaded: (view: DeviceSettingView<Value>) => update(view),
    loadFailed: (error: unknown) =>
      update({ value: spec.unknown, status: apiErrorMessage(error) }),
    async apply(next: Next) {
      update({ status: APPLYING_STATUS });
      try {
        update(await spec.save(next));
        refresh();
      } catch (error) {
        update({ status: apiErrorMessage(error) });
      }
    },
  };
}

/** Loads a device setting for the current device session and applies changes. */
export function useDeviceSetting<Value, Next extends Value>(
  spec: DeviceSettingSpec<Value, Next>,
): DeviceSettingView<Value> & { apply: (next: Next) => Promise<void> } {
  const [view, setView] = useState<DeviceSettingView<Value>>({
    value: spec.unknown,
    status: LOADING_STATUS,
  });
  const deviceSession = useDeviceSessionSnapshot();
  const update = useCallback(
    (patch: Partial<DeviceSettingView<Value>>) =>
      setView((current) => ({ ...current, ...patch })),
    [],
  );
  const refreshRef = useRef(() => {});
  const flow = useMemo(
    () => createDeviceSettingFlow(spec, update, () => refreshRef.current()),
    [spec, update],
  );
  const { refresh } = usePoll({
    poll: ({ signal }) => spec.load(signal),
    onResult: flow.loaded,
    onError: flow.loadFailed,
    intervalMs: null,
    pollKey: deviceSession.revision,
    enabled: !deviceSession.transitioning,
  });
  refreshRef.current = refresh;
  return { ...view, apply: flow.apply };
}

function networkLabel(network: NetworkStatus): string {
  const state = network.enabled === true ? "on" : network.enabled === false ? "off" : "unknown";
  const wifi = network.wifi && network.wifi !== "unknown" ? `wifi ${network.wifi}` : "wifi ?";
  const mobileData =
    network.mobileData && network.mobileData !== "unknown" ? `data ${network.mobileData}` : "data ?";
  return `${state} (${wifi}, ${mobileData})`;
}

/** The four device settings, built on `request` (the API client by default). */
export function deviceSettings(request: typeof apiRequest = apiRequest) {
  const orientation: DeviceSettingSpec<OrientationMode | "unknown", OrientationMode> = {
    unknown: "unknown",
    load: async (signal) =>
      readOrientation(await request("/api/orientation", { method: "GET", cache: "no-store", signal })),
    save: async (next) =>
      readOrientation(await request("/api/orientation", { method: "POST", body: { orientation: next } })),
  };
  function readOrientation(json: { orientation: { orientation: OrientationMode | "unknown"; raw: string } }) {
    const value = json.orientation.orientation;
    return { value, status: value === "unknown" ? json.orientation.raw || "Unknown" : value };
  }

  const nightMode: DeviceSettingSpec<NightMode | "unknown", NightMode> = {
    unknown: "unknown",
    load: async (signal) =>
      readNightMode(await request("/api/night-mode", { method: "GET", cache: "no-store", signal })),
    save: async (next) =>
      readNightMode(await request("/api/night-mode", { method: "POST", body: { mode: next } })),
  };
  function readNightMode(json: { nightMode: { mode: NightMode | "unknown"; raw: string } }) {
    const value = json.nightMode.mode;
    return { value, status: value === "unknown" ? json.nightMode.raw || "Unknown" : value };
  }

  const fontScale: DeviceSettingSpec<number | null, number> = {
    unknown: null,
    load: async (signal) =>
      readFontScale(await request("/api/font-scale", { method: "GET", cache: "no-store", signal })),
    save: async (next) =>
      readFontScale(await request("/api/font-scale", { method: "POST", body: { scale: next } })),
  };
  function readFontScale(json: { fontScale: { scale: number } }) {
    return { value: json.fontScale.scale, status: `${Math.round(json.fontScale.scale * 100)}%` };
  }

  const network: DeviceSettingSpec<boolean | null, boolean> = {
    unknown: null,
    load: async (signal) =>
      readNetwork(await request("/api/network", { method: "GET", cache: "no-store", signal })),
    save: async (next) =>
      readNetwork(await request("/api/network", { method: "POST", body: { enabled: next } })),
  };
  function readNetwork(json: { network: NetworkStatus }) {
    return { value: json.network.enabled, status: networkLabel(json.network) };
  }

  return { orientation, nightMode, fontScale, network };
}

/** Module-level so each spec keeps one identity across renders. */
export const DEVICE_SETTINGS = deviceSettings();
