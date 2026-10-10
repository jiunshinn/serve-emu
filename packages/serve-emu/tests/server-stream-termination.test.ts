import { describe, expect, test } from "bun:test";
import {
  createHarness,
  response,
  waitFor,
  type Harness,
} from "./helpers/server-harness.ts";

async function health(harness: Harness) {
  const res = await response(harness.request("/health"));
  return { status: res.status, body: await res.json() };
}

async function waitForStatus(harness: Harness, status: string) {
  await waitFor(async () => (await health(harness)).body.status === status);
}

describe("scrcpy stream termination", () => {
  test("an abnormal scrcpy exit marks the session as errored", async () => {
    const harness = await createHarness();
    harness.session.proc.emit("exit", 137, null);
    await waitForStatus(harness, "error");

    const { status, body } = await health(harness);
    expect(status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      status: "error",
      lastError: "scrcpy exited with code 137 signal null",
      lastErrorCode: "process-exit",
      lastErrorMeta: { exitCode: 137 },
    });
  });

  test("a clean scrcpy exit leaves a streaming session alone", async () => {
    const harness = await createHarness();
    harness.session.proc.emit("exit", 0, null);
    await Promise.resolve();

    const { status, body } = await health(harness);
    expect(status).toBe(200);
    expect(body.status).toBe("streaming");
  });

  test("a crash after a clean end of the video stream escalates to error", async () => {
    const harness = await createHarness();
    harness.session.endFrames();
    await waitForStatus(harness, "stopped");

    harness.session.proc.emit("exit", null, "SIGKILL");
    await waitForStatus(harness, "error");
    expect((await health(harness)).body).toMatchObject({
      lastError: "scrcpy exited with code null signal SIGKILL",
      lastErrorCode: "process-exit",
      lastErrorMeta: { signal: "SIGKILL" },
    });
  });

  test("a control socket error marks the session as errored", async () => {
    const harness = await createHarness();
    harness.session.controlSocket.emit("error", new Error("EPIPE"));
    await waitForStatus(harness, "error");

    expect((await health(harness)).body).toMatchObject({
      status: "error",
      lastError: "scrcpy control socket error: EPIPE",
      lastErrorCode: null,
    });
  });

  test("an unstructured frame read failure is reported as text", async () => {
    const harness = await createHarness();
    harness.session.failFrames(new Error("read failed"));
    await waitForStatus(harness, "error");

    expect((await health(harness)).body).toMatchObject({
      status: "error",
      lastError: "Error: read failed",
      lastErrorCode: null,
    });
  });

  test("scrcpy ending during server stop is not reported as a failure", async () => {
    const harness = await createHarness();
    await harness.started.stop();
    harness.session.proc.emit("exit", 1, null);
    harness.session.controlSocket.emit("error", new Error("closed"));
    await Promise.resolve();

    expect((await health(harness)).body).toMatchObject({
      status: "stopped",
      lastError: "server stopping",
    });
  });
});
