import { describe, expect, test } from "bun:test";
import { DEFAULT_HOST } from "../src/server.ts";
import {
  API_ROUTE_METHODS,
  ApiBoundaryError,
  apiFailure,
  withApiErrorBoundary,
  apiMethodGate,
  readBodyBytes,
  readJsonBody,
} from "../src/server/api-boundary.ts";
import {
  frameDeliveryDecision,
  sendResultDecision,
} from "../src/server/backpressure.ts";
import {
  StaleSessionError,
  sessionScoped,
  sessionScopedCommit,
  sessionScopedResult,
} from "../src/server/session-scope.ts";

describe("server API boundaries", () => {
  test("the complete API method table is enforced before business routing", async () => {
    const entries = Object.entries(API_ROUTE_METHODS);
    expect(entries).toHaveLength(31);
    expect(entries.reduce((total, [, methods]) => total + methods.length, 0)).toBe(40);
    for (const [path, methods] of entries) {
      for (const method of methods) {
        expect(apiMethodGate(path, method)).toBeNull();
      }
      const mismatch = apiMethodGate(path, "PATCH");
      expect(mismatch?.status).toBe(405);
      expect(mismatch?.headers.get("allow")).toBe(methods.join(", "));
      expect(await mismatch?.json()).toMatchObject({
        ok: false,
        error: { code: "method_not_allowed" },
      });
    }
    expect(apiMethodGate("/health", "GET")).toBeNull();
    expect(apiMethodGate("/apiary", "GET")).toBeNull();
  });

  test("unknown API paths have a stable structured 404", async () => {
    const response = apiMethodGate("/api/not-registered", "GET");
    expect(response?.status).toBe(404);
    expect(await response?.json()).toEqual({
      ok: false,
      error: { code: "not_found", message: "API route not found" },
    });
  });

  test("bounded bodies reject declared and streamed byte overflow", async () => {
    const declared = new Request("http://localhost/api/tap", {
      method: "POST",
      headers: { "Content-Length": "9" },
      body: "{}",
    });
    await expect(readBodyBytes(declared, 8)).rejects.toMatchObject({
      status: 413,
      code: "payload_too_large",
    });

    const streamed = new Request("http://localhost/api/tap", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("1234"));
          controller.enqueue(new TextEncoder().encode("56789"));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readBodyBytes(streamed, 8)).rejects.toMatchObject({
      status: 413,
      code: "payload_too_large",
    });

    const rejectingCancel = new Request("http://localhost/api/tap", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(9));
        },
        cancel() {
          throw new Error("transport cancel failed");
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readBodyBytes(rejectingCancel, 8)).rejects.toMatchObject({
      status: 413,
      code: "payload_too_large",
    });
  });

  test("JSON parsing differentiates valid input from malformed bytes", async () => {
    const valid = await readJsonBody(
      new Request("http://localhost/api/tap", {
        method: "POST",
        body: JSON.stringify({ x: 0.5 }),
      }),
    );
    expect(valid).toEqual({ x: 0.5 });

    await expect(
      readJsonBody(
        new Request("http://localhost/api/tap", {
          method: "POST",
          body: "{",
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: "invalid_json" });
  });

  test("failure responses expose only the stable code and safe message", async () => {
    const response = apiFailure(
      new ApiBoundaryError(413, "payload_too_large", "Request body is too large"),
    );
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "payload_too_large",
        message: "Request body is too large",
      },
    });
  });

  test("the composed API boundary preserves body-limit status and code", async () => {
    const request = new Request("http://localhost/api/route", {
      method: "POST",
      body: "123456789",
    });
    const response = await withApiErrorBoundary(async () => {
      await readJsonBody(request, 8);
      return Response.json({ ok: true });
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "payload_too_large",
        message: "Request body is too large",
      },
    });
  });

  test("server module remains importable without opening Android or a port", () => {
    expect(DEFAULT_HOST).toBe("127.0.0.1");
  });
});

describe("server backpressure policy", () => {
  const base = {
    awaitingKeyFrame: false,
    isKeyFrame: false,
    bufferedBytes: 0,
    dropThresholdBytes: 512,
    closeThresholdBytes: 16_384,
  };

  test("drops deltas until a keyframe and prioritizes the close threshold", () => {
    expect(
      frameDeliveryDecision({ ...base, awaitingKeyFrame: true }),
    ).toBe("drop-awaiting-keyframe");
    expect(
      frameDeliveryDecision({
        ...base,
        awaitingKeyFrame: true,
        isKeyFrame: true,
      }),
    ).toBe("send");
    expect(
      frameDeliveryDecision({ ...base, bufferedBytes: 513 }),
    ).toBe("drop-buffered");
    expect(
      frameDeliveryDecision({ ...base, bufferedBytes: 16_385 }),
    ).toBe("close-slow-client");
    expect(
      frameDeliveryDecision({
        ...base,
        awaitingKeyFrame: true,
        bufferedBytes: 16_385,
      }),
    ).toBe("close-slow-client");
  });

  test("classifies Bun WebSocket send results", () => {
    expect(sendResultDecision(-1)).toBe("backpressure");
    expect(sendResultDecision(0)).toBe("closed");
    expect(sendResultDecision(1)).toBe("sent");
  });
});

describe("device-session isolation", () => {
  test("a replay callback cannot cross a session generation", async () => {
    let generation = 4;
    const calls: string[] = [];
    const action = sessionScoped(4, () => generation, async (value: string) => {
      calls.push(value);
    });

    await action("old-session");
    generation++;
    expect(() => action("new-session")).toThrow(StaleSessionError);
    expect(calls).toEqual(["old-session"]);
  });

  test("an in-flight result cannot commit after a device switch", async () => {
    let generation = 10;
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    let committed: string | null = null;
    const work = sessionScopedResult(10, () => generation, () => pending)
      .then((value) => {
        committed = value;
      });

    generation++;
    resolve("old-device-location");
    await expect(work).rejects.toBeInstanceOf(StaleSessionError);
    expect(committed).toBeNull();
  });

  test("the post-await check and state commit are one synchronous step", async () => {
    let generation = 20;
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const commits: string[] = [];
    const work = sessionScopedCommit(
      20,
      () => generation,
      () => pending,
      (value) => {
        commits.push(value);
        return value.length;
      },
    );

    generation++;
    resolve("stale");
    await expect(work).rejects.toBeInstanceOf(StaleSessionError);
    expect(commits).toEqual([]);
  });
});
