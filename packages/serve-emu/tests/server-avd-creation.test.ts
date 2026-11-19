import { describe, expect, test } from "bun:test";
import { AvdManagerError } from "../src/avd-manager.ts";
import { parseApiResponse } from "../src/shared/api-contracts.ts";
import { createHarness, response } from "./helpers/server-harness.ts";

const catalog = { profiles: [{ id: "pixel_fold", name: "Pixel Fold", manufacturer: "Google", foldable: true }], images: [] };
const payload = { name: "My_Fold", profile: "pixel_fold", image: "installed-image" };
const post = (body = JSON.stringify(payload)): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body });

describe("AVD HTTP API", () => {
  test("catalog and creation use host services without switching the active device", async () => {
    let received: unknown;
    const h = await createHarness({}, {
      avds: {
        catalog: async () => catalog,
        create: async (value) => { received = value; return { name: "My_Fold" }; },
      },
    });
    const listed = await (await response(h.request("/api/avds/catalog"))).json();
    expect(parseApiResponse("/api/avds/catalog", "GET", listed)).toEqual({ ok: true, ...catalog });
    const created = await response(h.request("/api/avds/create", post()));
    expect(created.status).toBe(201);
    expect(parseApiResponse("/api/avds/create", "POST", await created.json())).toEqual({ ok: true, avd: "My_Fold" });
    expect(received).toEqual(payload);
    expect((await (await response(h.request("/health"))).json()).serial).toBe("emulator-5554");
  });
  test("token and origin gates run before host mutations", async () => {
    let calls = 0;
    const h = await createHarness({ token: "test-secret" }, {
      avds: {
        create: async () => { calls++; return { name: "My_Fold" }; },
        catalog: async () => { calls++; return catalog; },
      },
    });
    expect((await response(h.request("/api/avds/catalog"))).status).toBe(401);
    expect((await response(h.request("/api/avds/create", post()))).status).toBe(401);
    expect((await response(h.request("/api/avds/create", { ...post(), headers: { Authorization: "Bearer test-secret", Origin: "https://evil.example" } }))).status).toBe(403);
    expect(calls).toBe(0);
    const result = await response(h.request("/api/avds/create", { ...post(), headers: { Authorization: "Bearer test-secret", Origin: "http://127.0.0.1:33040", "Content-Type": "application/json" } }));
    expect(result.status).toBe(201);
    expect(calls).toBe(1);
  });
  test("rejects malformed and oversized bodies before creating", async () => {
    let calls = 0;
    const h = await createHarness({}, {
      avds: { catalog: async () => catalog, create: async () => { calls++; return { name: "x" }; } },
    });
    expect((await response(h.request("/api/avds/create", post("{")))).status).toBe(400);
    expect((await response(h.request("/api/avds/create", post(JSON.stringify({ name: "x".repeat(9000) }))))).status).toBe(413);
    expect(calls).toBe(0);
  });
  test("sends actionable SDK errors without tool output", async () => {
    let catalogError = new AvdManagerError("tools-unavailable", "Install SDK tools");
    const h = await createHarness({}, {
      avds: {
        catalog: async () => { throw catalogError; },
        create: async () => { throw new AvdManagerError("exists", "Already exists"); },
      },
    });
    const unavailable = await response(h.request("/api/avds/catalog"));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      ok: false,
      error: { code: "service_unavailable", message: "Install SDK tools", reason: "avd-tools-unavailable" },
    });
    catalogError = new AvdManagerError("command-failed", "Android SDK command failed", "secret stderr");
    const failed = await response(h.request("/api/avds/catalog"));
    expect(failed.status).toBe(502);
    expect(JSON.stringify(await failed.json())).not.toContain("secret stderr");
    const exists = await response(h.request("/api/avds/create", post()));
    expect(exists.status).toBe(409);
    expect((await exists.json()).error.reason).toBe("avd-exists");
  });
});
