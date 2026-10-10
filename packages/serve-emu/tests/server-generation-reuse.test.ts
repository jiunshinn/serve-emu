import { expect, test } from "bun:test";
import type { StagedMultipartFile } from "../src/multipart-upload.ts";
import type { RecoveryWatchdogClock } from "../src/session-recovery-watchdog.ts";
import { createHarness, fakeScrcpy, response } from "./helpers/server-harness.ts";

const stagedApk: StagedMultipartFile = {
  path: "/tmp/app.apk",
  filename: "app.apk",
  mediaType: "application/vnd.android.package-archive",
  size: 4,
  cleanup: async () => {},
};

test("uploads keep working on a device switched to after a failed activation (#167)", async () => {
  // Like real scrcpy, every open is a new session.
  const opened: string[] = [];
  // Activation starts the session's recovery watchdog: fail the second start
  // (the first switch to B), as a broken session object would.
  let starts = 0;
  const recoveryClock: RecoveryWatchdogClock = {
    now: () => 1_000,
    setInterval: () => {
      starts += 1;
      if (starts === 2) throw new Error("activation failed");
      return Symbol("recovery-timer");
    },
    clearInterval: () => {},
  };
  const harness = await createHarness(
    { serial: "A" },
    {
      openScrcpy: async (serial) => {
        opened.push(serial);
        return fakeScrcpy(serial);
      },
      listDevices: async () => [
        { serial: "A", state: "device" },
        { serial: "B", state: "device" },
      ],
      recoveryClock,
      stageMultipartUpload: async () => stagedApk,
      installApk: async () => ({ ok: true, output: "installed" }),
    },
  );
  const select = (serial: string) =>
    response(
      harness.request("/api/devices/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serial }),
      }),
    );
  const install = () =>
    response(
      harness.request("/api/apps/install", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=fake" },
        body: "--fake--\r\n",
      }),
    );

  const failed = await select("B");
  expect(failed.ok).toBe(false);
  expect(harness.started.session?.serial).toBe("A");
  expect((await install()).status).toBe(200);

  const switched = await select("B");
  expect(switched.status).toBe(200);
  expect(harness.started.session?.serial).toBe("B");
  expect(opened).toEqual(["A", "B", "B"]);
  const installed = await install();
  expect(installed.status).toBe(200);
  expect(await installed.json()).toMatchObject({ ok: true, output: "installed" });
});
