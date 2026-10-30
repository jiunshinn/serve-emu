import { describe, expect, test } from "bun:test";
import { CommandFailureError } from "../src/command-failure.ts";
import type { ExecOpts, ExecResult, execText } from "../src/exec.ts";
import {
  PushNotificationError,
  sendPushNotification,
} from "../src/push-notification.ts";

type ExecCall = { args: string[]; opts: ExecOpts };

const DELIVERED =
  "Broadcasting: Intent { act=com.google.android.c2dm.intent.RECEIVE flg=0x10400000 pkg=com.example.app (has extras) }\n" +
  "Broadcast completed: result=-1\n";

function result(overrides: Partial<ExecResult<string>> = {}): ExecResult<string> {
  return {
    status: 0,
    signal: null,
    stdout: DELIVERED,
    stderr: "",
    timedOut: false,
    error: null,
    ...overrides,
  };
}

function recordingExec(
  calls: ExecCall[],
  response: ExecResult<string> = result(),
): typeof execText {
  return async (_cmd, args, opts = {}) => {
    calls.push({ args, opts });
    return response;
  };
}

/** The `--es` extras of a recorded broadcast, unquoted the way `sh` does. */
function extras(args: string[]): Record<string, string> {
  const unquote = (value: string) =>
    Bun.spawnSync(["/bin/sh", "-c", `printf '%s' ${value}`]).stdout.toString();
  const found: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--es") found[unquote(args[i + 1]!)] = unquote(args[i + 2]!);
  }
  return found;
}

describe("simulated FCM push", () => {
  test("sends a notification message with a link as a root broadcast to one app", async () => {
    const calls: ExecCall[] = [];
    const response = await sendPushNotification(
      "emulator-5554",
      {
        packageName: " com.example.app ",
        title: "Order shipped",
        body: "Tap to\ntrack it",
        image: " https://example.com/box.png ",
        channelId: "orders",
        link: " myapp://orders/42 ",
        data: { orderId: "42", empty: "" },
      },
      { execText: recordingExec(calls) },
    );

    expect(response).toEqual({
      ok: true,
      output: `Delivered notification message ${response.messageId} to com.example.app`,
      messageId: expect.stringMatching(/^serve-emu-[0-9a-f]{16}$/),
    });
    const [call] = calls;
    expect(call!.args.slice(0, 15)).toEqual([
      "-s",
      "emulator-5554",
      "shell",
      "su",
      "0",
      "am",
      "broadcast",
      "--receiver-foreground",
      "-a",
      "com.google.android.c2dm.intent.RECEIVE",
      "-p",
      "'com.example.app'",
      "--el",
      "google.sent_time",
      expect.stringMatching(/^\d{13}$/),
    ]);
    expect(extras(call!.args)).toEqual({
      from: "serve-emu",
      "google.message_id": response.messageId,
      "google.delivered_priority": "high",
      "google.original_priority": "high",
      "gcm.n.e": "1",
      "gcm.n.title": "Order shipped",
      "gcm.n.body": "Tap to\ntrack it",
      "gcm.n.image": "https://example.com/box.png",
      "gcm.n.android_channel_id": "orders",
      "gcm.n.link": "myapp://orders/42",
      orderId: "42",
      empty: "",
    });
    expect(call!.opts).toMatchObject({ timeout: 30_000, lane: "background" });
  });

  test("a push without a title or a body is a data message", async () => {
    const calls: ExecCall[] = [];
    const response = await sendPushNotification(
      "emulator-5554",
      { packageName: "com.example.app", title: "  ", data: { type: "sync" } },
      { execText: recordingExec(calls) },
    );

    expect(response.output).toBe(
      `Delivered data message ${response.messageId} to com.example.app`,
    );
    const sent = extras(calls[0]!.args);
    expect(Object.keys(sent).filter((key) => key.startsWith("gcm."))).toEqual([]);
    expect(sent.type).toBe("sync");
  });

  test("text reaches the device shell unchanged", async () => {
    const hostile = "a&b;reboot|id`id`$(id)$HOME'q\"z *";
    const calls: ExecCall[] = [];
    await sendPushNotification(
      "emulator-5554",
      { packageName: "com.example.app", title: hostile, data: { [hostile.replaceAll(" ", "")]: hostile } },
      { execText: recordingExec(calls) },
    );

    const sent = extras(calls[0]!.args);
    expect(sent["gcm.n.title"]).toBe(hostile);
    expect(sent[hostile.replaceAll(" ", "")]).toBe(hostile);
  });

  test("rejects invalid requests before adb runs", async () => {
    const calls: ExecCall[] = [];
    const deps = { execText: recordingExec(calls) };
    const base = { packageName: "com.example.app", title: "Hi" };

    for (const [payload, error] of [
      [{ title: "Hi" }, "packageName is invalid"],
      [{ packageName: "com.example.app" }, "a push needs a title, a body, or data"],
      [{ packageName: "com.example.app", data: {} }, "a push needs a title, a body, or data"],
      [{ packageName: "com.example.app", link: "myapp://x", data: { a: "b" } }, "link, image, and channelId need a title or a body"],
      [{ ...base, title: 42 }, "title must be a string"],
      [{ ...base, body: "a\u0000b" }, "body must not contain control characters"],
      [{ ...base, link: "not a link" }, "link is invalid"],
      [{ ...base, link: "myapp://a\nb" }, "link is invalid"],
      [{ ...base, link: `x:${"a".repeat(4095)}` }, "link must be at most 4096 characters"],
      [{ ...base, image: "ftp://example.com/a.png" }, "image must be an http or https URL"],
      [{ ...base, image: "not a url" }, "image must be an http or https URL"],
      [{ ...base, channelId: "a\nb" }, "channelId is invalid"],
      [{ ...base, data: ["a"] }, "data must be an object of strings"],
      [{ ...base, data: "a=b" }, "data must be an object of strings"],
      [{ ...base, data: { "a b": "c" } }, "data keys must be 1 to 128 characters without spaces"],
      [{ ...base, data: { ["k".repeat(129)]: "c" } }, "data keys must be 1 to 128 characters without spaces"],
      [{ ...base, data: { from: "x" } }, "data key from is reserved by FCM"],
      [{ ...base, data: { "google.c.a.e": "1" } }, "data key google.c.a.e is reserved by FCM"],
      [{ ...base, data: { "gcm.n.title": "x" } }, "data key gcm.n.title is reserved by FCM"],
      [{ ...base, data: { count: 3 } }, "data.count must be a string"],
      [{ ...base, data: { a: "b\u001bc" } }, "data.a must not contain control characters"],
      [{ ...base, body: "x".repeat(4095) }, "push payload must be at most 4096 bytes"],
      [{ ...base, data: { a: "가".repeat(1365) } }, "push payload must be at most 4096 bytes"],
    ] as const) {
      await expect(
        sendPushNotification("emulator-5554", payload as Record<string, unknown>, deps),
      ).rejects.toThrow(error);
    }
    expect(calls).toEqual([]);
  });

  test("a device without su says that the push needs root", async () => {
    const missing = "/system/bin/sh: su: inaccessible or not found";
    // With and without adb's shell protocol, which reports the exit status.
    for (const response of [
      result({ status: 127, stdout: "", stderr: missing }),
      result({ status: 0, stdout: `${missing}\n` }),
      result({ status: 127, stdout: "", stderr: "su: not found" }),
    ]) {
      const sending = sendPushNotification(
        "emulator-5554",
        { packageName: "com.example.app", title: "Hi" },
        { execText: async () => response },
      );
      await expect(sending).rejects.toBeInstanceOf(PushNotificationError);
      await expect(sending).rejects.toMatchObject({
        code: "root-unavailable",
        message: expect.stringContaining("Google APIs system image"),
      });
    }
  });

  test("a broadcast no FCM receiver took is not delivered", async () => {
    for (const [stdout, message] of [
      ["Broadcast completed: result=0\n", /did not take the push/],
      ["Broadcasting: Intent { ... }\n", /did not take the push/],
      ["Broadcast completed: result=500\n", "the app's FCM receiver answered with result 500"],
    ] as const) {
      await expect(
        sendPushNotification(
          "emulator-5554",
          { packageName: "com.example.app", data: { a: "b" } },
          { execText: async () => result({ stdout }) },
        ),
      ).rejects.toMatchObject({ code: "not-delivered", message: expect.stringMatching(message) });
    }
  });

  test("other adb failures keep their command failure codes", async () => {
    const payload = { packageName: "com.example.app", title: "Hi" };
    const failed = sendPushNotification("emulator-5554", payload, {
      execText: async () => result({ status: 1, stdout: "", stderr: "Security exception" }),
    });
    await expect(failed).rejects.toBeInstanceOf(CommandFailureError);
    await expect(failed).rejects.toMatchObject({
      code: "adb-failed",
      publicMessage: "adb shell am broadcast failed",
    });

    await expect(
      sendPushNotification("emulator-5554", payload, {
        execText: async () => result({ status: 1, stdout: "", stderr: "error: device offline" }),
      }),
    ).rejects.toMatchObject({ code: "adb-device-unavailable" });
    await expect(
      sendPushNotification("emulator-5554", payload, {
        execText: async () => result({ status: null, stdout: "", timedOut: true }),
      }),
    ).rejects.toMatchObject({ code: "adb-timeout" });
  });

  test("a cancelled call does not run or report adb", async () => {
    const calls: ExecCall[] = [];
    const payload = { packageName: "com.example.app", title: "Hi" };
    const before = new AbortController();
    before.abort(new Error("switched before"));
    await expect(
      sendPushNotification("emulator-5554", payload, {
        signal: before.signal,
        execText: recordingExec(calls),
      }),
    ).rejects.toThrow("switched before");
    expect(calls).toEqual([]);

    const during = new AbortController();
    await expect(
      sendPushNotification("emulator-5554", payload, {
        signal: during.signal,
        execText: async () => {
          during.abort(new Error("switched during"));
          return result();
        },
      }),
    ).rejects.toThrow("switched during");
  });
});
