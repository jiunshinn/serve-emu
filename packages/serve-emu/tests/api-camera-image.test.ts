import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createCameraImages, MAX_CAMERA_IMAGE_BYTES } from "../src/camera-images.ts";
import { createDeviceService } from "../src/device-service.ts";
import type { EmulatorLaunch } from "../src/emulator.ts";
import { parseApiResponse } from "../src/shared/api-contracts.ts";
import { createHarness, fakeScrcpy, response } from "./helpers/server-harness.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNsaGhgYGBgYmBgYGBgAAASKgGEzwCOrgAAAABJRU5ErkJggg==", "base64");
const put = (body: BodyInit = png): RequestInit => ({ method: "PUT", body });

test("camera endpoints report unknown modes and reject unowned devices", async () => {
  const h = await createHarness();
  try {
    const get = await response(h.request("/api/camera"));
    expect(parseApiResponse("/api/camera", "GET", await get.json())).toEqual({ ok: true, back: null, front: null });
    const res = await response(h.request("/api/camera/image", put()));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "conflict", message: expect.stringContaining('cameraBack: "uploaded"') } });
  } finally { await h.started.stop(); }
});

test("live camera contracts, atomic upload, optional app restart and device routing", async () => {
  const images = await createCameraImages("pixel", "uploaded", "none");
  const calls: string[] = [];
  const service = createDeviceService();
  const h = await createHarness({ initialEmulatorLaunch: { serial: "emulator-5554", ownsProcess: true, proc: null, cameras: images, stop: async () => {} } }, {
    listDevices: async () => [{ serial: "emulator-5554", state: "device" }, { serial: "emulator-5556", state: "device" }],
    openScrcpy: async (serial) => fakeScrcpy(serial),
    deviceService: { ...service,
      foregroundApp: async (serial, signal) => { expect(signal.aborted).toBe(false); calls.push(`${serial}:foreground`); return { packageName: "com.example", activity: "com.example.Camera", pid: null, label: null, versionName: null, versionCode: null, debuggable: null }; },
      forceStopApp: async (serial, pkg) => { calls.push(`${serial}:stop:${pkg}`); return { ok: true, output: "" }; },
      launchApp: async (serial, pkg, activity) => { calls.push(`${serial}:launch:${pkg}/${activity}`); return { ok: true, output: "" }; },
    },
  });
  try {
    const get = await response(h.request("/api/camera"));
    expect(parseApiResponse("/api/camera", "GET", await get.json())).toEqual({ ok: true, back: "uploaded", front: "none" });
    const res = await response(h.request("/api/camera/image?restartApp=true&record=false", put()));
    expect(res.status).toBe(200);
    expect(parseApiResponse("/api/camera/image", "PUT", await res.json())).toEqual({ ok: true, camera: "back", width: 2, height: 2, bytes: png.length, restartedApp: "com.example" });
    expect(calls).toEqual(["emulator-5554:foreground", "emulator-5554:stop:com.example", "emulator-5554:launch:com.example/com.example.Camera"]);
    const path = images.args(["-camera-back", "uploaded"])[1]!.slice("imagefile:".length);
    expect(await readFile(path)).toEqual(png);
    calls.length = 0;
    const pinned = await response(h.request("/d/emulator-5554/api/camera/image?restartApp=false", put()));
    expect(pinned.status).toBe(200);
    expect(parseApiResponse("/api/camera/image", "PUT", await pinned.json())).not.toHaveProperty("restartedApp");
    expect(calls).toEqual([]);
    const front = await response(h.request("/api/camera/image?camera=front", put()));
    expect(front.status).toBe(409);
    expect(await front.json()).toMatchObject({ error: { message: expect.stringContaining('cameraFront: "uploaded"') } });
    const other = await response(h.request("/d/emulator-5556/api/camera"));
    expect(await other.json()).toEqual({ ok: true, back: null, front: null });
  } finally { await h.started.stop(); await images.cleanup(); }
});

test("camera upload rejects invalid query, empty/non-PNG bodies, dimensions and oversized streams", async () => {
  const images = await createCameraImages("pixel", "uploaded", "uploaded");
  const h = await createHarness({ initialEmulatorLaunch: { serial: "emulator-5554", ownsProcess: true, proc: null, cameras: images, stop: async () => {} } });
  try {
    for (const query of ["?camera=side", "?restartApp=yes"]) {
      expect((await response(h.request(`/api/camera/image${query}`, put()))).status).toBe(400);
    }
    const oversized = Buffer.from(png); oversized.writeUInt32BE(4097, 16);
    for (const body of [Buffer.alloc(0), Buffer.from([255, 216, 255, 224]), oversized, png.subarray(0, 25)]) {
      const res = await response(h.request("/api/camera/image", put(body)));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
    const res = await response(h.request("/api/camera/image", put(new Uint8Array(MAX_CAMERA_IMAGE_BYTES + 1))));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: "payload_too_large" } });
    const front = await response(h.request("/api/camera/image?camera=front", put()));
    expect(front.status).toBe(200);
    expect(await front.json()).toMatchObject({ camera: "front" });
  } finally { await h.started.stop(); await images.cleanup(); }
});

test("API launch tracks camera metadata only for its owned live launch", async () => {
  const images = await createCameraImages("pixel", "uploaded", "imagefile:/private/secret");
  const proc = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null });
  const h = await createHarness({ serial: "emulator-5556" }, { startEmulator: async () => ({ serial: "emulator-5556", proc: proc as unknown as EmulatorLaunch["proc"], ownsProcess: true, cameras: images, stop: async () => {} }) });
  try {
    const start = await response(h.request("/api/avds/start", { method: "POST", body: JSON.stringify({ avd: "pixel", select: false, cameraBack: "uploaded" }) }));
    expect(start.status).toBe(200);
    const read = async () => (await response(h.request("/api/camera"))).json();
    expect(await read()).toEqual({ ok: true, back: "uploaded", front: "imagefile" });
    proc.exitCode = 0;
    expect(await read()).toEqual({ ok: true, back: null, front: null });
    proc.emit("exit", 0, null);
    expect(await read()).toEqual({ ok: true, back: null, front: null });
  } finally { await h.started.stop(); await images.cleanup(); }
});

test("camera UI response parsers reject malformed state, paths and image results", () => {
  for (const value of [{}, { ok: false }, { ok: true, back: null }, { ok: true, back: "imagefile:/secret", front: null }, { ok: true, back: 1, front: null }]) {
    expect(() => parseApiResponse("/api/camera", "GET", value)).toThrow();
  }
  const valid = { ok: true, camera: "front", width: 2, height: 2, bytes: 79 };
  for (const value of [{}, { ...valid, ok: false }, { ...valid, camera: "side" }, { ...valid, width: 0 }, { ...valid, height: 4097 }, { ...valid, bytes: -1 }, { ...valid, width: 1.5 }, { ...valid, restartedApp: 1 }]) {
    expect(() => parseApiResponse("/api/camera/image", "PUT", value)).toThrow();
  }
});

test("camera restart falls back from a private activity to the package launcher and reports launcher failures", async () => {
  for (const scenario of ["fallback", "both-fail", "no-activity"] as const) {
    const cameras = await createCameraImages("pixel", "uploaded");
    const calls: (string | undefined)[] = [];
    const activity = scenario === "no-activity" ? null : "com.example.PrivateCamera";
    const h = await createHarness({ initialEmulatorLaunch: { serial: "emulator-5554", ownsProcess: true, proc: null, cameras, stop: async () => {} } }, {
      deviceService: { ...createDeviceService(),
        foregroundApp: async () => ({ packageName: "com.example", activity, pid: null, label: null, versionName: null, versionCode: null, debuggable: null }),
        forceStopApp: async () => ({ ok: true, output: "" }),
        launchApp: async (serial, pkg, target, signal) => {
          expect(serial).toBe("emulator-5554");
          expect(pkg).toBe("com.example");
          expect(signal.aborted).toBe(false);
          calls.push(target);
          if (target || scenario !== "fallback") throw new Error("private launch failure");
          return { ok: true, output: "" };
        },
      },
    });
    try {
      const res = await response(h.request("/api/camera/image?restartApp=true", put()));
      expect(calls).toEqual(activity ? [activity, undefined] : [undefined]);
      if (scenario === "fallback") {
        expect(res.status).toBe(200);
        expect(parseApiResponse("/api/camera/image", "PUT", await res.json())).toMatchObject({ restartedApp: "com.example" });
      } else {
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body).toMatchObject({ ok: false, error: { code: "internal_error" } });
        expect(JSON.stringify(body)).not.toContain("private launch failure");
      }
    } finally { await h.started.stop(); await cameras.cleanup(); }
  }
});

test("camera upload restart handles no foreground app and downstream restart failures", async () => {
  const cameras = await createCameraImages("pixel", "uploaded");
  let packageName: string | null = null;
  const h = await createHarness({ initialEmulatorLaunch: { serial: "emulator-5554", ownsProcess: true, proc: null, cameras, stop: async () => {} } }, {
    deviceService: { ...createDeviceService(),
      foregroundApp: async () => ({ packageName, activity: null, pid: null, label: null, versionName: null, versionCode: null, debuggable: null }),
      forceStopApp: async () => { throw new Error("private failure"); },
    },
  });
  try {
    const missing = await response(h.request("/api/camera/image?restartApp=true", put()));
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ error: { message: "No foreground app to restart." } });
    packageName = "com.example";
    const failed = await response(h.request("/api/camera/image?restartApp=true", put()));
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain("private failure");
  } finally { await h.started.stop(); await cameras.cleanup(); }
});
