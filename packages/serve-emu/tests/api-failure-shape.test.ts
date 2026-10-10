import { describe, expect, test } from "bun:test";
import { AppManagementError } from "../src/app-management.ts";
import { CommandFailureError } from "../src/command-failure.ts";
import { parseApiFailure, type ApiErrorCode } from "../src/shared/api-contracts.ts";
import { createHarness, response } from "./helpers/server-harness.ts";

const ORIGIN = "http://127.0.0.1:33040";
const json = (body: unknown, init: RequestInit = {}): RequestInit => ({
  method: "POST",
  ...init,
  headers: { "content-type": "application/json", origin: ORIGIN, ...(init.headers as Record<string, string>) },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

type Case = {
  name: string;
  status: number;
  code: ApiErrorCode;
  run: () => Promise<Response>;
};

describe("every /api failure uses the documented ApiFailure shape", () => {
  const cases: Case[] = [
    {
      name: "invalid input",
      status: 400,
      code: "invalid_request",
      run: async () => response((await createHarness()).request("/api/tap", json({ x: "left", y: 0.5 }))),
    },
    {
      name: "malformed JSON",
      status: 400,
      code: "invalid_json",
      run: async () => response((await createHarness()).request("/api/tap", json("{"))),
    },
    {
      name: "oversized body",
      status: 413,
      code: "payload_too_large",
      run: async () =>
        response((await createHarness()).request("/api/tap", json({ x: 0.5, y: 0.5, pad: "x".repeat(9_000) }))),
    },
    {
      name: "unknown route",
      status: 404,
      code: "not_found",
      run: async () => response((await createHarness()).request("/api/nope")),
    },
    {
      name: "wrong method",
      status: 405,
      code: "method_not_allowed",
      run: async () => response((await createHarness()).request("/api/tap", { method: "DELETE", headers: { origin: ORIGIN } })),
    },
    {
      name: "missing token",
      status: 401,
      code: "unauthorized",
      run: async () => response((await createHarness({ token: "secret" })).request("/api/health-check")),
    },
    {
      name: "cross-origin mutation",
      status: 403,
      code: "forbidden",
      run: async () =>
        response((await createHarness()).request("/api/tap", json({ x: 0.5, y: 0.5 }, { headers: { origin: "https://evil.example" } }))),
    },
    {
      name: "ended device session",
      status: 409,
      code: "conflict",
      run: async () => {
        const h = await createHarness();
        h.session.endFrames();
        for (let turn = 0; turn < 50 && h.started.session !== null; turn++) await Promise.resolve();
        return response(h.request("/api/route/control", json({ action: "stop" })));
      },
    },
    {
      name: "adb failure",
      status: 502,
      code: "downstream_failure",
      run: async () => {
        const h = await createHarness({}, {
          importMediaFile: async () => {
            throw new AppManagementError("adb-failed", "adb: error: failed to copy '/tmp/x' to '/sdcard/Pictures/x'");
          },
        });
        const form = new FormData();
        form.set("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "x.png", { type: "image/png" }));
        return response(h.request("/api/files/import", { method: "POST", body: form, headers: { origin: ORIGIN } }));
      },
    },
    {
      name: "emulator boot failure",
      status: 502,
      code: "downstream_failure",
      run: async () => {
        const h = await createHarness({}, {
          startEmulator: async () => {
            throw new CommandFailureError(
              "emulator-failed",
              "Timed out waiting for emulator-5556 to boot.",
            );
          },
        });
        return response(h.request("/api/avds/start", json({ avd: "Pixel_8" })));
      },
    },
  ];

  test.each(cases.map((entry) => [entry.name, entry] as const))("%s", async (_name, entry) => {
    const result = await entry.run();
    expect(result.status).toBe(entry.status);
    const failure = parseApiFailure(await result.json());
    expect(failure.error.code).toBe(entry.code);
    expect(failure.error.message).not.toContain("/tmp/");
  });
});
