import { randomBytes } from "node:crypto";
import {
  adbCommandFailure,
  adbSucceeded,
  runAdb,
  throwIfAdbAborted,
  type AdbDeps,
} from "./adb-command.ts";
import { deepLinkUrl, packageName } from "./app-management.ts";
import { shellQuote } from "./shell-quote.ts";
import type { PushNotificationResponse } from "./shared/api-contracts.ts";

// Google Play services hands each FCM message to the app as this broadcast.
// The app's receiver requires a signature permission that only Play services
// holds, so the shell user cannot send it, but root can.
const FCM_RECEIVE = "com.google.android.c2dm.intent.RECEIVE";

/** FCM's own limit for the notification and data payload of one message. */
const MAX_PAYLOAD_BYTES = 4096;

// FCM rejects these data keys: the SDK reads them as message metadata.
const RESERVED_DATA_KEY_RE = /^(?:from|message_type|collapse_key)$|^(?:google|gcm)/i;
const DATA_KEY_RE = /^[^\s\x00-\x1f\x7f]{1,128}$/;
const CHANNEL_ID_RE = /^[^\x00-\x1f\x7f]{1,256}$/;
// Line breaks and tabs reach the device unchanged inside a quoted argument.
const TEXT_CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/;
const SU_MISSING_RE = /\bsu: (?:inaccessible or )?not found/;
const BROADCAST_RESULT_RE = /Broadcast completed: result=(-?\d+)/;
/** The result code the app's FCM receiver sets when it took the message. */
const FCM_ACCEPTED = "-1";

export type PushNotificationErrorCode = "root-unavailable" | "not-delivered";

/** A push the device could not send or the app did not take. `message` is public. */
export class PushNotificationError extends Error {
  constructor(
    readonly code: PushNotificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PushNotificationError";
  }
}

type Notification = {
  title?: string;
  body?: string;
  image?: string;
  channelId?: string;
  link?: string;
};

type PushMessage = {
  packageName: string;
  notification: Notification | null;
  data: [key: string, value: string][];
};

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  if (TEXT_CONTROL_RE.test(value)) {
    throw new Error(`${name} must not contain control characters`);
  }
  return value.trim() ? value : undefined;
}

function imageUrl(value: unknown): string | undefined {
  const text = optionalText(value, "image")?.trim();
  if (text === undefined) return undefined;
  if (!URL.canParse(text) || !/^https?:$/.test(new URL(text).protocol)) {
    throw new Error("image must be an http or https URL");
  }
  return text;
}

function channelId(value: unknown): string | undefined {
  const text = optionalText(value, "channelId")?.trim();
  if (text !== undefined && !CHANNEL_ID_RE.test(text)) {
    throw new Error("channelId is invalid");
  }
  return text;
}

function dataEntries(value: unknown): [string, string][] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("data must be an object of strings");
  }
  return Object.entries(value).map(([key, entry]) => {
    if (!DATA_KEY_RE.test(key)) {
      throw new Error("data keys must be 1 to 128 characters without spaces");
    }
    if (RESERVED_DATA_KEY_RE.test(key)) {
      throw new Error(`data key ${key} is reserved by FCM`);
    }
    if (typeof entry !== "string") {
      throw new Error(`data.${key} must be a string`);
    }
    if (TEXT_CONTROL_RE.test(entry)) {
      throw new Error(`data.${key} must not contain control characters`);
    }
    return [key, entry];
  });
}

/**
 * Reads a push request. A title or a body makes a notification message, which
 * the FCM SDK shows itself while the app is in the background; without them
 * it is a data message, which always goes to `onMessageReceived`.
 */
function pushMessage(payload: Record<string, unknown>): PushMessage {
  const pkg = packageName(payload.packageName);
  const title = optionalText(payload.title, "title");
  const body = optionalText(payload.body, "body");
  const link = optionalText(payload.link, "link");
  const notification: Notification = {
    title,
    body,
    image: imageUrl(payload.image),
    channelId: channelId(payload.channelId),
    link: link === undefined ? undefined : deepLinkUrl(link, "link"),
  };
  const data = dataEntries(payload.data);
  const isNotification = title !== undefined || body !== undefined;
  if (
    !isNotification &&
    Object.values(notification).some((value) => value !== undefined)
  ) {
    throw new Error("link, image, and channelId need a title or a body");
  }
  if (!isNotification && data.length === 0) {
    throw new Error("a push needs a title, a body, or data");
  }
  const bytes = [...Object.values(notification), ...data.flat()].reduce(
    (total, text) => total + (text ? Buffer.byteLength(text) : 0),
    0,
  );
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new Error(`push payload must be at most ${MAX_PAYLOAD_BYTES} bytes`);
  }
  return {
    packageName: pkg,
    notification: isNotification ? notification : null,
    data,
  };
}

/** The extras an FCM message carries, under the keys the FCM SDK reads. */
function messageExtras(push: PushMessage, messageId: string): [string, string][] {
  const extras: [string, string][] = [
    ["from", "serve-emu"],
    ["google.message_id", messageId],
    ["google.delivered_priority", "high"],
    ["google.original_priority", "high"],
  ];
  const notification = push.notification;
  if (notification) {
    extras.push(["gcm.n.e", "1"]);
    for (const [key, value] of [
      ["gcm.n.title", notification.title],
      ["gcm.n.body", notification.body],
      ["gcm.n.image", notification.image],
      ["gcm.n.android_channel_id", notification.channelId],
      ["gcm.n.link", notification.link],
    ] as const) {
      if (value !== undefined) extras.push([key, value]);
    }
  }
  return [...extras, ...push.data];
}

/**
 * Simulates an FCM message for one app: it sends, as root, the broadcast
 * Google Play services sends when a message arrives, so the app's own FCM
 * code handles it. Real FCM does not deliver to an app in the stopped state,
 * and neither does this broadcast.
 */
export async function sendPushNotification(
  serial: string,
  payload: Record<string, unknown>,
  deps: AdbDeps = {},
): Promise<PushNotificationResponse> {
  const push = pushMessage(payload);
  const messageId = `serve-emu-${randomBytes(8).toString("hex")}`;
  const args = [
    "shell",
    "su",
    "0",
    "am",
    "broadcast",
    "--receiver-foreground",
    "-a",
    FCM_RECEIVE,
    "-p",
    shellQuote(push.packageName),
    "--el",
    "google.sent_time",
    String(Date.now()),
    ...messageExtras(push, messageId).flatMap(([key, value]) => [
      "--es",
      shellQuote(key),
      shellQuote(value),
    ]),
  ];
  throwIfAdbAborted(deps.signal, "The operation was aborted");
  const result = await runAdb(serial, args, {
    timeout: 30_000,
    signal: deps.signal,
    lane: "background",
    execText: deps.execText,
  });
  throwIfAdbAborted(deps.signal, "The operation was aborted");
  const output = `${result.stdout}${result.stderr}`.trim();
  // Checked before the exit status: devices without adb's shell protocol
  // always exit 0.
  if (SU_MISSING_RE.test(output)) {
    throw new PushNotificationError(
      "root-unavailable",
      "a simulated push needs root: use an emulator with a Google APIs system image, not Google Play",
    );
  }
  if (!adbSucceeded(result)) {
    throw adbCommandFailure("adb shell am broadcast", result);
  }
  const code = BROADCAST_RESULT_RE.exec(output)?.[1];
  if (code !== FCM_ACCEPTED) {
    throw new PushNotificationError(
      "not-delivered",
      code === "0" || code === undefined
        ? "the app did not take the push: check that it uses Firebase Cloud Messaging and was launched after install or force-stop"
        : `the app's FCM receiver answered with result ${code}`,
    );
  }
  const kind = push.notification ? "notification" : "data";
  return {
    ok: true,
    output: `Delivered ${kind} message ${messageId} to ${push.packageName}`,
    messageId,
  };
}
