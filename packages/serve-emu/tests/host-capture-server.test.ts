import { expect, test } from "bun:test";
import { parseHealthResponse } from "../src/shared/api-contracts.ts";
import { createHarness, fakeScrcpy, response, waitFor } from "./helpers/server-harness.ts";
import { ManualClock } from "./helpers/manual-clock.ts";

test.each(["host", "fallback"])("health contract reports %s capture without credentials", async (kind) => {
  const session = fakeScrcpy();
  if (kind === "host") session.transport = "host-capture";
  else session.hostCaptureFallbackReason = "no live token-authenticated emulator endpoint";
  const h = await createHarness({ sessions: [session] });
  const health = parseHealthResponse(await (await response(h.request("/health"))).json());
  expect(health.stream.capture).toBe(kind === "host" ? "host" : "scrcpy");
  expect(health.hostCaptureFallbackReason).toBe(session.hostCaptureFallbackReason);
});

test("host resets from viewers and watchdog request encoder keyframes, not scrcpy resets", async () => {
  const session = fakeScrcpy();
  session.transport = "host-capture";
  let keys = 0;
  session.requestKeyFrame = () => { keys++; };
  const clock = new ManualClock();
  const h = await createHarness({ sessions: [session] }, { recoveryClock: clock });
  await h.openWebSocket();
  expect(keys).toBe(1);
  expect(session.fakeControlSocket.writes).toHaveLength(0);
  clock.advance(3_000);
  clock.fireActive();
  await waitFor(() => keys >= 2);
  expect(session.fakeControlSocket.writes).toHaveLength(0);
  expect(parseHealthResponse(await (await response(h.request("/health"))).json()).videoResetRequests).toBe(keys);
});

test.each(["exit", "close"])("host capture still terminates if scrcpy control %s occurs", async (event) => {
  const session = fakeScrcpy();
  session.transport = "host-capture";
  const h = await createHarness({ sessions: [session] }, { listDevices: async () => [] });
  if (event === "exit") session.proc.emit("exit", 0, null);
  else session.fakeControlSocket.emit("close");
  await waitFor(async () => (await (await response(h.request("/health"))).json()).status === "error");
  expect(session.closeCalls).toBe(1);
});
