import { describe, expect, test } from "bun:test";
import {
  ApiClientError,
  apiErrorMessage,
  createApiClient,
  type FetchLike,
} from "../src/ui/lib/api-client.ts";

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(value), {
    ...init,
    headers,
  });
}

describe("API client", () => {
  test("returns legacy success payloads and serializes JSON bodies", async () => {
    let requestInit: RequestInit | undefined;
    const request = createApiClient(async (_input, init) => {
      requestInit = init;
      return jsonResponse({
        ok: true,
        orientation: { mode: "lock", rotation: 0, orientation: "portrait", raw: "lock 0" },
      });
    });

    const result = await request("/api/orientation", {
      method: "POST",
      body: { orientation: "portrait" },
    });

    expect(result.orientation.orientation).toBe("portrait");
    expect(requestInit?.body).toBe(JSON.stringify({ orientation: "portrait" }));
    expect(new Headers(requestInit?.headers).get("Content-Type")).toBe("application/json");
  });

  test("accepts existing success responses that do not carry an ok discriminant", async () => {
    const request = createApiClient(async () =>
      jsonResponse({
        session: {
          eventCount: 0,
          retainedBytes: 0,
          limits: { maxEvents: 2_000, maxBytes: 1_048_576 },
          droppedEvents: 0,
          oldestEventId: null,
          newestEventId: null,
          oldestEventAt: null,
          newestEventAt: null,
          recording: true,
          replaying: false,
          replayStartedAt: null,
          replayCompletedAt: null,
          lastError: null,
        },
        events: [],
        nextBefore: null,
        hasMore: false,
      }),
    );

    const page = await request("/api/session", { method: "GET" });

    expect(page.session.recording).toBe(true);
    expect(page.events).toEqual([]);
  });

  test("appends a query string while parsing with the path's contract", async () => {
    let requested: RequestInfo | URL | undefined;
    const request = createApiClient(async (input) => {
      requested = input;
      return jsonResponse({
        session: {
          eventCount: 0,
          retainedBytes: 0,
          limits: { maxEvents: 2_000, maxBytes: 1_048_576 },
          droppedEvents: 0,
          oldestEventId: null,
          newestEventId: null,
          oldestEventAt: null,
          newestEventAt: null,
          recording: true,
          replaying: false,
          replayStartedAt: null,
          replayCompletedAt: null,
          lastError: null,
        },
        events: [],
        nextBefore: null,
        hasMore: false,
      });
    });

    const page = await request("/api/session", {
      method: "GET",
      query: { limit: 6, before: undefined },
    });

    expect(requested).toBe("/api/session?limit=6");
    expect(page.hasMore).toBe(false);
  });

  test("turns a structured failure into its message", async () => {
    const structured = createApiClient(async () =>
      jsonResponse(
        { ok: false, error: { code: "not_found", message: "API route not found" } },
        { status: 404 },
      ),
    );

    const structuredError = await structured("/api/orientation", { method: "GET" }).catch(
      (error: unknown) => error,
    );
    expect(apiErrorMessage(structuredError)).toBe("API route not found");
    expect(apiErrorMessage("plain")).toBe("plain");
  });

  test("passes FormData and AbortSignal through without a multipart content-type override", async () => {
    let requestInit: RequestInit | undefined;
    const fetcher: FetchLike = async (_input, init) => {
      requestInit = init;
      return jsonResponse({ ok: true, output: "installed" });
    };
    const request = createApiClient(fetcher);
    const form = new FormData();
    form.set("apk", new File(["apk"], "demo.apk"));
    const controller = new AbortController();

    await request("/api/apps/install", {
      method: "POST",
      body: form,
      signal: controller.signal,
    });

    expect(requestInit?.body).toBe(form);
    expect(requestInit?.signal).toBe(controller.signal);
    expect(new Headers(requestInit?.headers).has("Content-Type")).toBe(false);
  });

  test("preserves abort errors and wraps other transport failures", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortingRequest = createApiClient(async () => {
      throw controller.signal.reason;
    });
    const failingRequest = createApiClient(async () => {
      throw new TypeError("connection refused");
    });

    await expect(
      abortingRequest("/api/device-grid", { method: "GET", signal: controller.signal }),
    ).rejects.toBe(controller.signal.reason);
    await expect(failingRequest("/api/device-grid", { method: "GET" })).rejects.toMatchObject({
      status: 0,
      code: "network_error",
      message: "Unable to reach the API",
    });
  });

  test("throws typed errors for structured failures even when HTTP status is successful", async () => {
    const request = createApiClient(async () =>
      jsonResponse({
        ok: false,
        error: { code: "invalid_request", message: "orientation is required" },
      }),
    );

    const promise = request("/api/orientation", { method: "GET" });
    await expect(promise).rejects.toBeInstanceOf(ApiClientError);
    await expect(promise).rejects.toMatchObject({
      status: 200,
      code: "invalid_request",
      message: "orientation is required",
    });
  });

  test("preserves status and server error details for non-2xx failures", async () => {
    const request = createApiClient(async () =>
      jsonResponse(
        { ok: false, error: { code: "service_unavailable", message: "device offline" } },
        { status: 503 },
      ),
    );

    await expect(request("/api/device-grid", { method: "GET" })).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
      message: "device offline",
    });
  });

  test("treats the retired string failure shape as an invalid response", async () => {
    const request = createApiClient(async () =>
      jsonResponse({ ok: false, error: "old server failure" }, { status: 400 }),
    );

    await expect(request("/api/device-grid", { method: "GET" })).rejects.toMatchObject({
      status: 400,
      code: "invalid_response",
    });
  });

  test("keeps a failure's reason in its payload", async () => {
    const request = createApiClient(async () =>
      jsonResponse(
        { ok: false, error: { code: "rate_limited", message: "upload queue is full", reason: "upload-queue-full" } },
        { status: 429 },
      ),
    );

    await expect(request("/api/device-grid", { method: "GET" })).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      message: "upload queue is full",
      payload: { error: { reason: "upload-queue-full" } },
    });
  });

  test("rejects invalid JSON and non-object success payloads", async () => {
    const invalidJson = createApiClient(async () => new Response("not json", { status: 502 }));
    const primitiveJson = createApiClient(async () => jsonResponse("unexpected"));

    await expect(invalidJson("/api/device-grid", { method: "GET" })).rejects.toMatchObject({
      status: 502,
      code: "invalid_response",
    });
    await expect(primitiveJson("/api/device-grid", { method: "GET" })).rejects.toMatchObject({
      status: 200,
      code: "invalid_response",
    });
  });

  test("rejects malformed failure discriminants instead of returning them as success", async () => {
    const request = createApiClient(async () =>
      jsonResponse({ ok: false, error: { code: "made_up", message: "bad envelope" } }),
    );

    await expect(request("/api/device-grid", { method: "GET" })).rejects.toMatchObject({
      status: 200,
      code: "invalid_response",
    });
  });

  test("rejects malformed failures on success shapes without an ok field", async () => {
    const request = createApiClient(async () =>
      jsonResponse({
        ok: false,
        error: { code: "made_up", message: "bad envelope" },
        events: [],
        recording: true,
        replaying: false,
        replayStartedAt: null,
        replayCompletedAt: null,
        lastError: null,
      }),
    );

    await expect(request("/api/session", { method: "GET" })).rejects.toMatchObject({
      status: 200,
      code: "invalid_response",
    });
  });

  test("validates endpoint-specific success payloads before returning them", async () => {
    const request = createApiClient(async () =>
      jsonResponse({ ok: true, orientation: { orientation: "portrait" } }),
    );

    await expect(request("/api/orientation", { method: "GET" })).rejects.toMatchObject({
      status: 200,
      code: "invalid_response",
    });
  });

  test("returns binary screenshots without forcing a JSON parse", async () => {
    const request = createApiClient(async () =>
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        headers: { "Content-Type": "image/png" },
      })
    );

    const png = await request("/api/screenshot", { method: "GET" });

    expect(png).toBeInstanceOf(Uint8Array);
    expect(Array.from(png as Uint8Array)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});
