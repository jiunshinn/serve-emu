import { expect, test } from "bun:test";
import { CommandFailureError } from "../src/command-failure.ts";
import { EmulatorCameraConflictError, type StartEmulatorOpts } from "../src/emulator.ts";
import { parseApiResponse } from "../src/shared/api-contracts.ts";
import { createHarness, response } from "./helpers/server-harness.ts";

const post = (body: unknown): RequestInit => ({
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("AVD camera modes are validated before launch and forwarded, with omitted defaults", async () => {
  const launches: StartEmulatorOpts[] = [];
  const h = await createHarness({}, { startEmulator: async (opts) => {
    launches.push(opts);
    return { serial: "emulator-5556", proc: null, ownsProcess: false, stop: async () => {} };
  } });
  try {
    for (const cameras of [{}, { cameraBack: "emulated", cameraFront: "none" }, { cameraBack: "virtualscene", cameraFront: "environment" }, { cameraBack: "webcam0", cameraFront: "webcam1" }]) {
      const res = await response(h.request("/api/avds/start", post({ avd: "pixel", select: false, ...cameras })));
      expect(res.status).toBe(200);
      expect(launches.at(-1)).toMatchObject({ avd: "pixel", ...cameras });
    }
    expect(launches[0]).not.toHaveProperty("cameraBack");
    for (const cameras of [
      { cameraBack: 1 }, { cameraFront: null }, { cameraBack: "" }, { cameraBack: "webcam" },
      { cameraFront: "virtualscene" }, { cameraBack: "-gpu" },
      { cameraBack: "imagefile:/etc/passwd" }, { cameraFront: "videofile:/secret" },
      { cameraBack: "image360:/secret" }, { cameraFront: "imagefile:" },
      { cameraBack: "webcam0", cameraFront: "webcam0" },
    ]) {
      const res = await response(h.request("/api/avds/start", post({ avd: "pixel", select: false, ...cameras })));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
    expect(launches).toHaveLength(4);
  } finally { await h.started.stop(); }
});

test("running AVD camera conflicts are structured 409 responses", async () => {
  const h = await createHarness({}, { startEmulator: async () => {
    throw new EmulatorCameraConflictError("AVD is already running; stop it before changing cameras.");
  } });
  try {
    const res = await response(h.request("/api/avds/start", post({ avd: "pixel", select: false, cameraBack: "emulated" })));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "conflict", reason: "emulator-camera-restart-required", message: expect.stringContaining("already running") } });
  } finally { await h.started.stop(); }
});

test("webcams use the configured emulator and request signal, including empty lists and failures", async () => {
  let fail = false;
  let webcams = [{ name: "webcam0", device: "Host camera" }];
  const h = await createHarness({ emulator: { emulatorPath: "/sdk/emulator" } }, { listWebcams: async (path, _deps, signal) => {
    expect(path).toBe("/sdk/emulator");
    expect(signal).toBeInstanceOf(AbortSignal);
    if (fail) throw new CommandFailureError("emulator-failed", "emulator -webcam-list failed", "private output");
    return webcams;
  } });
  try {
    for (const expected of [webcams, []]) {
      webcams = expected;
      const res = await response(h.request("/api/webcams"));
      expect(res.status).toBe(200);
      expect(parseApiResponse("/api/webcams", "GET", await res.json())).toEqual({ ok: true, webcams: expected });
    }
    fail = true;
    const res = await response(h.request("/api/webcams"));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: { code: "downstream_failure", reason: "emulator-failed", message: "emulator -webcam-list failed" } });
  } finally { await h.started.stop(); }
});

test("webcam UI parser rejects malformed responses", () => {
  for (const value of [{ ok: false }, { ok: true }, { ok: true, webcams: {} }, { ok: true, webcams: [null] }, { ok: true, webcams: [{ name: 1, device: "Host" }] }, { ok: true, webcams: [{ name: "webcam0" }] }]) {
    expect(() => parseApiResponse("/api/webcams", "GET", value)).toThrow();
  }
});
