import { describe, expect, test } from "bun:test";
import type { AccessibilitySnapshot } from "../src/accessibility.ts";
import { createElementTapEndpoint } from "../src/element-tap-api.ts";
import type { DeviceContext, ServerDependencies } from "../src/server.ts";
import { parseApiSuccess } from "../src/shared/api-contracts.ts";
import { createHarness, fakeScrcpy, fakeWebSocket, response, waitFor, type Harness } from "./helpers/server-harness.ts";

const endpoint = "/api/devices/tap-element";
const payload = { sourceSerial: "A", serials: ["A", "B"], x: 0.25, y: 0.75 };
function snapshot(serial: string): AccessibilitySnapshot {
  return { ok: true, capturedAt: new Date().toISOString(), nodes: [{
    id: serial === "A" ? "3" : "52", text: "", contentDescription: "Search", resourceId: "com.qa:id/nav_search",
    className: "android.widget.Button", packageName: "com.qa", clickable: true, enabled: true,
    bounds: serial === "B" ? { left: 880, top: 160, right: 1040, bottom: 320 } : { left: 80, top: 400, right: 240, bottom: 560 },
  }] };
}
async function fixture(overrides: ServerDependencies = {}, token?: string) {
  const opened = new Map<string, ReturnType<typeof fakeScrcpy>[]>();
  const loads = new Map<string, number>();
  const harness = await createHarness({ serial: "C", token }, {
    listDevices: async () => ["A", "B", "C"].map((serial) => ({ serial, state: "device" })),
    openScrcpy: async (serial) => {
      const session = fakeScrcpy(serial);
      session.meta.width = serial === "B" ? 128 : 64;
      session.meta.height = serial === "B" ? 96 : 64;
      opened.set(serial, [...(opened.get(serial) ?? []), session]);
      return session;
    },
    loadDisplaySize: async (serial) => serial === "B" ? { width: 1280, height: 960 } : { width: 640, height: 640 },
    ...overrides,
    loadAccessibility: async (serial, signal) => {
      loads.set(serial, (loads.get(serial) ?? 0) + 1);
      return overrides.loadAccessibility ? overrides.loadAccessibility(serial, signal) : snapshot(serial);
    },
  });
  const packets = (serial: string) => (opened.get(serial) ?? []).flatMap((session) => session.fakeControlSocket.writes);
  return { harness, opened, loads, packets };
}
function tap(harness: Harness, body: unknown = payload, signal?: AbortSignal) {
  return response(harness.request(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal }));
}
async function controller(harness: Harness, serial: string) {
  await harness.request(`/ws?serial=${serial}&control=1&video=0`);
  const socket = fakeWebSocket(harness.server.upgrades.at(-1)!);
  harness.handlers.websocket.open(socket);
  return socket;
}

describe("group element taps", () => {
  test("preflights fresh hierarchies, scales physical viewports, records, and respects source exclusion", async () => {
    const { harness, packets, loads } = await fixture();
    const target = await controller(harness, "B");
    const result = await tap(harness, { ...payload, serials: ["B"] });
    expect(result.status).toBe(200);
    expect(parseApiSuccess(endpoint, "POST", await result.json())).toMatchObject({ ok: true, results: [{ serial: "B", ok: true }], element: { contentDescription: "Search" } });
    expect(packets("A")).toEqual([]);
    expect(packets("C")).toEqual([]);
    const touch = packets("B").find((packet) => packet[0] === 2)!;
    expect([touch.readInt32BE(10), touch.readInt32BE(14)]).toEqual([96, 24]);
    expect((target.data.context as DeviceContext).recorder.summary().eventCount).toBe(1);
    expect((await tap(harness, { ...payload, serials: ["B"], record: false })).status).toBe(200);
    expect((target.data.context as DeviceContext).recorder.summary().eventCount).toBe(1);
    expect(loads.get("A")).toBe(2);
    expect(loads.get("B")).toBe(2);
  });

  test("a missing or ambiguous target prevents every device from receiving any tap", async () => {
    for (const mode of ["missing", "ambiguous"] as const) {
      const { harness, packets } = await fixture({ loadAccessibility: async (serial) => {
        const value = snapshot(serial);
        if (serial === "B") {
          if (mode === "missing") value.nodes[0]!.resourceId = "com.qa:id/content_search";
          else value.nodes.push({ ...value.nodes[0]!, id: "duplicate", bounds: { left: 0, top: 0, right: 100, bottom: 100 } });
        }
        return value;
      } });
      const result = await tap(harness);
      expect(result.status).toBe(409);
      expect(await result.json()).toMatchObject({ ok: false, results: [{ serial: "A", ok: false }, { serial: "B", ok: false, code: mode === "missing" ? "element-not-found" : "element-ambiguous" }] });
      expect(packets("A")).toEqual([]);
      expect(packets("B")).toEqual([]);
    }
  });

  test("ignores unrelated active-device generation changes while matching", async () => {
    let resume!: () => void;
    let reading = false;
    const { harness, packets } = await fixture({ loadAccessibility: async (serial) => {
      if (serial === "A") { reading = true; await new Promise<void>((resolve) => { resume = resolve; }); }
      return snapshot(serial);
    } });
    const pending = tap(harness);
    await waitFor(() => reading);
    const switched = await response(harness.request("/api/devices/select", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ serial: "B" }) }));
    expect(switched.status).toBe(200);
    resume();
    expect((await pending).status).toBe(200);
    expect(packets("A").filter((packet) => packet[0] === 2)).toHaveLength(2);
    expect(packets("B").filter((packet) => packet[0] === 2)).toHaveLength(2);
    expect(packets("C")).toEqual([]);
  });

  test("rejects held touches, queued input, and input completed during hierarchy capture", async () => {
    let resume!: () => void;
    let block = false;
    const { harness, packets, loads } = await fixture({ loadAccessibility: async (serial) => {
      if (block && serial === "A") await new Promise<void>((resolve) => { resume = resolve; });
      return snapshot(serial);
    } });
    const target = await controller(harness, "B");
    harness.handlers.websocket.message(target, JSON.stringify({ type: "touch", action: "down", x: 0.2, y: 0.2, pointerId: 9 }));
    await waitFor(() => packets("B").length === 1);
    const held = await tap(harness);
    expect(held.status).toBe(409);
    expect(await held.json()).toMatchObject({ results: [{ serial: "A", ok: false }, { serial: "B", ok: false, code: "input-busy" }] });
    expect(packets("A")).toEqual([]);
    harness.handlers.websocket.message(target, JSON.stringify({ type: "release-input", requestId: "released" }));
    await waitFor(() => target.sent.some((value) => (value as { requestId?: string }).requestId === "released"));

    block = true;
    const pending = tap(harness);
    await waitFor(() => (loads.get("B") ?? 0) === 2);
    harness.handlers.websocket.message(target, JSON.stringify({ type: "home", requestId: "changed" }));
    await waitFor(() => target.sent.some((value) => (value as { requestId?: string }).requestId === "changed"));
    resume();
    const changed = await pending;
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ results: [{ serial: "A", ok: false }, { serial: "B", ok: false, code: "input-changed" }] });
    expect(packets("A")).toEqual([]);
    expect(packets("B").filter((packet) => packet[0] === 2)).toHaveLength(2);
  });

  test("fails the group if the viewport rotates or folds during matching", async () => {
    let targetContext: DeviceContext;
    const { harness, packets } = await fixture({ loadAccessibility: async (serial) => {
      if (serial === "B") targetContext.screen.width = 96;
      return snapshot(serial);
    } });
    targetContext = (await controller(harness, "B")).data.context as DeviceContext;
    const result = await tap(harness);
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ results: [{ serial: "A", ok: false }, { serial: "B", ok: false, code: "display-changed" }] });
    expect(packets("A")).toEqual([]);
    expect(packets("B")).toEqual([]);
  });

  test("bounds requests, reports busy work, and cancels leases without late input", async () => {
    let captureSignal: AbortSignal | undefined;
    const { harness, opened, packets } = await fixture({ loadAccessibility: async (_serial, signal) => {
      captureSignal = signal;
      return new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } });
    const cancel = new AbortController();
    const pending = tap(harness, payload, cancel.signal);
    await waitFor(() => Boolean(captureSignal));
    expect((await tap(harness)).status).toBe(429);
    cancel.abort();
    expect((await pending).status).toBe(499);
    expect(captureSignal?.aborted).toBe(true);
    await waitFor(() => opened.get("A")![0]!.closeCalls === 1);
    expect(packets("A")).toEqual([]);
    expect(packets("B")).toEqual([]);
    for (const invalid of [
      { ...payload, x: 2 }, { ...payload, record: "yes" }, { ...payload, serials: ["A", "A"] },
      { ...payload, serials: Array.from({ length: 17 }, (_, i) => String(i)) },
    ]) expect((await tap(harness, invalid)).status).toBe(400);
    expect((await tap(harness, { ...payload, padding: "x".repeat(8192) })).status).toBe(413);
  });

  test("uses a bounded deadline even when a downstream snapshot is slow", async () => {
    const { harness } = await fixture();
    const context = (await controller(harness, "A")).data.context as DeviceContext;
    let released = 0;
    let capturedSignal: AbortSignal | undefined;
    const handle = createElementTapEndpoint({
      acquire: async () => ({ context, release: () => { released++; } }),
      loadAccessibility: async (_serial, signal) => {
        capturedSignal = signal;
        return new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
      loadDisplaySize: async () => ({ width: 640, height: 640 }),
      assertCurrent: () => {},
      enqueue: () => { throw new Error("must not dispatch"); },
      timeoutMs: 15,
    });
    const result = await handle(new Request(`http://localhost${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, serials: ["A"] }) }));
    expect(result.status).toBe(504);
    expect(capturedSignal?.aborted).toBe(true);
    expect(released).toBe(1);
  });
});
