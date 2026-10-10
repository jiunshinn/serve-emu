import type { RunningAvd } from "./emulator.ts";
import type {
  Device,
  DeviceGridResponse,
  GridDevice,
  SessionStatus,
} from "./shared/api-contracts.ts";

export type DeviceGridDependencies = {
  listAllDevices: () => Promise<Device[]>;
  listAvds: () => Promise<string[]>;
  resolveRunningAvds: (
    devices: readonly Device[],
  ) => Promise<RunningAvd[]>;
};

/**
 * Build one device-grid snapshot. Device discovery is launched exactly once
 * and its result is passed into running-AVD resolution; the dynamic AVD list is
 * fetched in parallel.
 */
export async function loadDeviceGrid(
  currentSerial: string,
  sessionStatus: SessionStatus,
  dependencies: DeviceGridDependencies,
): Promise<DeviceGridResponse> {
  const devicesPromise = dependencies.listAllDevices();
  const avdsPromise = dependencies.listAvds();
  const runningPromise = devicesPromise.then((devices) =>
    dependencies.resolveRunningAvds(devices),
  );
  const [adbDevices, runningAvds, avds] = await Promise.all([
    devicesPromise,
    runningPromise,
    avdsPromise,
  ]);

  const runningBySerial = new Map(
    runningAvds.map((running) => [running.serial, running]),
  );
  const runningByAvd = new Map(
    runningAvds.map((running) => [running.avd, running]),
  );
  const rows: GridDevice[] = adbDevices.map((device) => {
    const running = runningBySerial.get(device.serial);
    const isEmulator = /^emulator-\d+$/.test(device.serial);
    return {
      id: device.serial,
      kind: isEmulator ? "emulator" : "physical",
      serial: device.serial,
      avd: running?.avd ?? null,
      name: running?.avd ?? device.serial,
      state: device.state,
      current: device.serial === currentSerial,
      canSelect: device.state === "device",
      canStart: false,
      canStop: isEmulator,
    };
  });

  for (const avd of avds) {
    const running = runningByAvd.get(avd);
    if (running) continue;
    rows.push({
      id: `avd:${avd}`,
      kind: "avd",
      serial: null,
      avd,
      name: avd,
      state: "stopped",
      current: false,
      canSelect: false,
      canStart: true,
      canStop: false,
    });
  }

  return { ok: true, currentSerial, sessionStatus, devices: rows };
}
