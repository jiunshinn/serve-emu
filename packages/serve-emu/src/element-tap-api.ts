import type { AccessibilitySnapshot } from "./accessibility.ts";
import type { ControlInputHandle } from "./control-input-queue.ts";
import {
  assertElementViewport,
  describeMatchedElement,
  ElementMatchError,
  identifySourceElement,
  matchTargetElement,
} from "./element-matching.ts";
import type { Gesture } from "./input.ts";
import { HttpBodyError, readJsonLimited } from "./request-body.ts";
import type { DeviceContext } from "./server.ts";
import type { DeviceSize, ElementTapDeviceResult, ElementTapRequest, MatchedElement } from "./shared/api-contracts.ts";

type Lease = { context: DeviceContext; release(): void };
type Capture = { context: DeviceContext; stream: DeviceSize; viewport: DeviceSize; snapshot: AccessibilitySnapshot; completedMs: number; inputRevision?: number };
type Services = {
  acquire(serial: string, signal: AbortSignal): Promise<Lease>;
  loadAccessibility(serial: string, signal: AbortSignal): Promise<AccessibilitySnapshot>;
  loadDisplaySize(serial: string, signal: AbortSignal): Promise<DeviceSize>;
  assertCurrent(context: DeviceContext): void;
  assertInputIdle?(context: DeviceContext): void;
  inputRevision?(context: DeviceContext): number;
  enqueue(context: DeviceContext, gesture: Gesture, source: string, record: boolean): ControlInputHandle;
  timeoutMs?: number;
};

const MAX_TARGETS = 16;
const MAX_CONCURRENT_REQUESTS = 1;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_CAPTURE_AGE_MS = 10_000;

function serial(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() ||
    Buffer.byteLength(value) > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("each serial must be a nonempty device serial of at most 256 bytes");
  }
  return value;
}

export function parseElementTapRequest(value: unknown): ElementTapRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("element tap payload must be an object");
  const body = value as Record<string, unknown>;
  const sourceSerial = serial(body.sourceSerial);
  if (!Array.isArray(body.serials) || !body.serials.length || body.serials.length > MAX_TARGETS) {
    throw new Error(`serials must contain 1 to ${MAX_TARGETS} target devices`);
  }
  const serials = body.serials.map(serial);
  if (new Set(serials).size !== serials.length) throw new Error("target serials must be unique");
  if (new Set([sourceSerial, ...serials]).size > MAX_TARGETS) throw new Error(`source and targets may include at most ${MAX_TARGETS} devices`);
  for (const key of ["x", "y"] as const) {
    if (typeof body[key] !== "number" || !Number.isFinite(body[key]) || body[key] < 0 || body[key] > 1) {
      throw new Error(`${key} must be a normalized coordinate between 0 and 1`);
    }
  }
  if (body.record !== undefined && typeof body.record !== "boolean") throw new Error("record must be a boolean");
  return { sourceSerial, serials, x: body.x as number, y: body.y as number, record: body.record !== false };
}

function detail(error: unknown): { error: string; code: string } {
  return {
    error: error instanceof Error ? error.message : String(error),
    code: error instanceof ElementMatchError ? error.code : "device-unavailable",
  };
}

function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void task.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Preflight every device before admitting even the first semantic tap. */
export function createElementTapEndpoint(services: Services): (request: Request) => Promise<Response> {
  let active = 0;
  return async (request) => {
    if (active >= MAX_CONCURRENT_REQUESTS) {
      return Response.json({ ok: false, error: "Too many element matching requests; retry shortly.", results: [] }, { status: 429 });
    }
    active++;
    const controller = new AbortController();
    const abort = () => controller.abort(new ElementMatchError("request-aborted", "Element matching was cancelled. Any already-admitted taps may finish."));
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const timer = setTimeout(() => controller.abort(new ElementMatchError("request-timeout", "Element matching timed out; retry when the screens are stable.")), services.timeoutMs ?? 20_000);
    const { signal } = controller;
    const leases = new Map<string, Lease>();
    const completions: Promise<unknown>[] = [];
    let body: ElementTapRequest | undefined;
    let element: MatchedElement | undefined;
    try {
      body = parseElementTapRequest(await readJsonLimited(new Request(request, { signal }), MAX_BODY_BYTES));
      const requestBody = body;
      const task = async (): Promise<Response> => {
        const captures = new Map<string, Capture>();
        const failures = new Map<string, ReturnType<typeof detail>>();
        await Promise.all(Array.from(new Set([requestBody.sourceSerial, ...requestBody.serials]), async (serial) => {
          try {
            const lease = await services.acquire(serial, signal);
            if (signal.aborted) { lease.release(); throw signal.reason; }
            leases.set(serial, lease);
            const context = lease.context;
            const stream = { ...context.screen };
            const inputRevision = services.inputRevision?.(context);
            const captureSignal = AbortSignal.any([signal, context.signal]);
            let completedMs = 0;
            const [snapshot, viewport] = await Promise.all([
              services.loadAccessibility(serial, captureSignal).then((snapshot) => {
                completedMs = Date.now();
                return snapshot;
              }),
              services.loadDisplaySize(serial, captureSignal),
            ]);
            if (captureSignal.aborted) throw captureSignal.reason;
            services.assertCurrent(context);
            assertElementViewport(viewport, stream);
            captures.set(serial, { context, stream, viewport, snapshot, completedMs, inputRevision });
          } catch (error) { failures.set(serial, detail(error)); }
        }));
        if (signal.aborted) throw signal.reason;

        const source = captures.get(requestBody.sourceSerial);
        let identity: ReturnType<typeof identifySourceElement> | undefined;
        if (source) {
          try {
            identity = identifySourceElement(source.snapshot, source.viewport, requestBody);
            element = describeMatchedElement(identity);
          } catch (error) { failures.set(requestBody.sourceSerial, detail(error)); }
        }
        const points = new Map<string, { x: number; y: number }>();
        if (identity) {
          for (const serial of requestBody.serials) {
            const capture = captures.get(serial);
            if (!capture) continue;
            try { points.set(serial, matchTargetElement(identity, capture.snapshot, capture.viewport)); }
            catch (error) { failures.set(serial, detail(error)); }
          }
        }
        // Recheck every participating context after the slow hierarchy reads;
        // folding, rotating, disconnecting, or replacing a pool invalidates it.
        for (const [serial, capture] of captures) {
          try {
            services.assertCurrent(capture.context);
            const queue = capture.context.inputQueue.snapshot();
            if (queue.closed || queue.depth || queue.active || queue.reservedReleases) {
              throw new ElementMatchError("input-busy", "The device has pending input or a held touch. Release it and retry.");
            }
            services.assertInputIdle?.(capture.context);
            if (capture.inputRevision !== services.inputRevision?.(capture.context)) {
              throw new ElementMatchError("input-changed", "The device received other input during element matching. Retry on the new screen.");
            }
            if (capture.context.screen.width !== capture.stream.width || capture.context.screen.height !== capture.stream.height) {
              throw new ElementMatchError("display-changed", "The display size changed during element matching; retry after it settles.");
            }
            if (Date.now() - capture.completedMs > MAX_CAPTURE_AGE_MS) {
              throw new ElementMatchError("snapshot-stale", "The accessibility snapshot became stale while waiting for other devices.");
            }
          } catch (error) { failures.set(serial, detail(error)); }
        }
        if (signal.aborted) throw signal.reason;
        if (failures.size || points.size !== requestBody.serials.length) {
          const sourceFailure = failures.get(requestBody.sourceSerial);
          return Response.json({
            ok: false,
            error: "Element matching could not verify every device. No devices were tapped.",
            ...(element ? { element } : {}),
            results: requestBody.serials.map((serial) => ({
              serial, ok: false,
              ...(failures.get(serial) ?? (sourceFailure ? {
                code: sourceFailure.code, error: `Source ${requestBody.sourceSerial}: ${sourceFailure.error}`,
              } : { code: "group-preflight-failed", error: "Not tapped because another device could not match the element." })),
            })),
          }, { status: 409 });
        }

        const admitted = requestBody.serials.map((serial) => {
          try {
            const capture = captures.get(serial)!;
            const accepted = services.enqueue(capture.context, { type: "tap", ...points.get(serial)! }, "element:tap", requestBody.record !== false);
            completions.push(accepted.completion);
            return accepted.completion.then(
              () => ({ serial, ok: true } as ElementTapDeviceResult),
              (error) => ({ serial, ok: false, ...detail(error) }),
            );
          } catch (error) { return Promise.resolve({ serial, ok: false, ...detail(error) }); }
        });
        const results = await Promise.all(admitted);
        const ok = results.every((result) => result.ok);
        return Response.json({ ok, results, element, ...(ok ? {} : { error: "Some devices could not complete the matched tap." }) }, { status: ok ? 200 : 207 });
      };
      return await abortable(task(), signal);
    } catch (error) {
      const failure = detail(signal.aborted ? signal.reason : error);
      const status = failure.code === "request-timeout" ? 504 : failure.code === "request-aborted" ? 499 : error instanceof HttpBodyError ? error.status : 400;
      return Response.json({ ok: false, ...failure, results: (body?.serials ?? []).map((serial) => ({ serial, ok: false, ...failure })), ...(element ? { element } : {}) }, { status });
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      controller.abort(new Error("element tap request ended"));
      if (completions.length) {
        let drainTimer!: ReturnType<typeof setTimeout>;
        await Promise.race([
          Promise.allSettled(completions),
          new Promise<void>((resolve) => { drainTimer = setTimeout(resolve, 1_000); }),
        ]);
        clearTimeout(drainTimer);
      }
      for (const lease of leases.values()) lease.release();
      active--;
    }
  };
}
