import { describe, expect, test } from "bun:test";
import { createApiClient, type FetchLike } from "../src/ui/lib/api-client.ts";
import {
  APPLYING_STATUS,
  createDeviceSettingFlow,
  deviceSettings,
  type DeviceSettingSpec,
  type DeviceSettingView,
} from "../src/ui/lib/device-setting.ts";

type Reply = { status?: number; body: unknown };

/** A fake server: each request gets the next scripted reply. */
function fakeServer(replies: Reply[]) {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const fetcher: FetchLike = async (input, init = {}) => {
    requests.push({
      url: String(input),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const reply = replies.shift() ?? { status: 500, body: { ok: false, error: { code: "internal_error", message: "no reply" } } };
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { requests, settings: deviceSettings(createApiClient(fetcher)) };
}

/** Runs a spec's flow the way useDeviceSetting does, recording what it shows. */
function harness<Value, Next extends Value>(spec: DeviceSettingSpec<Value, Next>) {
  let view: DeviceSettingView<Value> = { value: spec.unknown, status: "Loading..." };
  const shown: string[] = [];
  let refreshes = 0;
  const flow = createDeviceSettingFlow(
    spec,
    (patch) => {
      view = { ...view, ...patch };
      shown.push(view.status);
    },
    () => {
      refreshes++;
    },
  );
  const load = async () => {
    try {
      flow.loaded(await spec.load(new AbortController().signal));
    } catch (error) {
      flow.loadFailed(error);
    }
  };
  return { flow, load, view: () => view, shown, refreshes: () => refreshes };
}

const orientation = (value: string, raw = `lock ${value}`) => ({
  body: { ok: true, orientation: { mode: "lock", rotation: 0, orientation: value, raw } },
});

describe("device setting flow", () => {
  test("reads, applies, and refreshes a setting", async () => {
    const server = fakeServer([orientation("portrait"), orientation("landscape")]);
    const h = harness(server.settings.orientation);
    await h.load();
    expect(h.view()).toEqual({ value: "portrait", status: "portrait" });

    await h.flow.apply("landscape");
    expect(h.shown.slice(-2)).toEqual([APPLYING_STATUS, "landscape"]);
    expect(h.view().value).toBe("landscape");
    expect(h.refreshes()).toBe(1);
    expect(server.requests.map((r) => [r.method, r.url, r.body])).toEqual([
      ["GET", "/api/orientation", undefined],
      ["POST", "/api/orientation", { orientation: "landscape" }],
    ]);
  });

  test("shows the raw value when the device reports an unknown state", async () => {
    const server = fakeServer([orientation("unknown", "free ?")]);
    const h = harness(server.settings.orientation);
    await h.load();
    expect(h.view()).toEqual({ value: "unknown", status: "free ?" });
  });

  test("an apply failure shows its message and keeps the value", async () => {
    const body = {
      ok: false,
      error: {
        code: "downstream_failure",
        message: "cmd window user-rotation failed",
        reason: "adb-failed",
      },
    };
    const server = fakeServer([orientation("portrait"), { status: 502, body }]);
    const h = harness(server.settings.orientation);
    await h.load();
    await h.flow.apply("landscape");
    expect(h.view()).toEqual({
      value: "portrait",
      status: "cmd window user-rotation failed",
    });
    expect(h.refreshes()).toBe(0);
  });

  test("a load failure resets the value", async () => {
    const server = fakeServer([
      { status: 503, body: { ok: false, error: { code: "service_unavailable", message: "device offline" } } },
    ]);
    const h = harness(server.settings.network);
    await h.load();
    expect(h.view()).toEqual({ value: null, status: "device offline" });
  });

  test("night mode, font scale, and network read their own fields", async () => {
    const server = fakeServer([
      { body: { ok: true, nightMode: { mode: "dark", raw: "Night mode: yes" } } },
      { body: { ok: true, fontScale: { scale: 1.15, raw: "1.15" } } },
      {
        body: {
          ok: true,
          network: { enabled: true, wifi: "enabled", mobileData: "disabled", raw: { wifi: "1", mobileData: "0" } },
        },
      },
    ]);
    const night = harness(server.settings.nightMode);
    const font = harness(server.settings.fontScale);
    const network = harness(server.settings.network);
    await night.load();
    await font.load();
    await network.load();
    expect(night.view()).toEqual({ value: "dark", status: "dark" });
    expect(font.view()).toEqual({ value: 1.15, status: "115%" });
    expect(network.view()).toEqual({ value: true, status: "on (wifi enabled, data disabled)" });
  });
});
