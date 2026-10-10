import {
  findAccessibilityNode,
  parseAccessibilitySelector,
} from "../../accessibility.ts";
import { shouldRecordPayload } from "../../session-api.ts";
import type { ApiDependencies } from "../dependencies.ts";
import type { ApiRoute, ApiRouteHandler } from "../router.ts";

const MAX_LOGCAT_QUERY_BYTES = 200;

/** GET and POST /api/screenshot: PNG bytes, or base64 JSON with ?format=base64. */
const screenshot: ApiRouteHandler<ApiDependencies> = async ({
  request: req,
  url,
  deps,
}) => {
  const { runForContext, requestContext, errorResponse, device } = deps;
  try {
    const png = await runForContext(
      requestContext,
      (context, signal) => device.screenshot(context.serial, signal),
      req.signal,
    );
    if (url.searchParams.get("format") === "base64") {
      return Response.json({
        ok: true,
        mimeType: "image/png",
        data: png.toString("base64"),
      });
    }
    return new Response(new Uint8Array(png), {
      headers: { "Content-Type": "image/png" },
    });
  } catch (err) {
    return errorResponse(err);
  }
};

/** POST /api/accessibility/tap: taps the center of the node a selector matches. */
const accessibilityTap: ApiRouteHandler<ApiDependencies> = async ({
  request: req,
  deps,
}) => {
  const {
    readJsonBody,
    MAX_JSON_BODY_BYTES,
    requestContext: context,
    readAccessibilitySnapshot,
    enqueueGesture,
    errorResponse,
  } = deps;
  try {
    const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES, context);
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      throw new Error("accessibility tap payload must be an object");
    }
    const body = payload as Record<string, unknown>;
    const selector = parseAccessibilitySelector(body.selector ?? body);
    const snapshot = await readAccessibilitySnapshot(context, 1_000);
    const node = findAccessibilityNode(snapshot.nodes, selector);
    const centerX = (node.bounds.left + node.bounds.right) / 2;
    const centerY = (node.bounds.top + node.bounds.bottom) / 2;
    const accessibilityWidth = Math.max(
      ...snapshot.nodes.map((n) => n.bounds.right),
      context.screen.width,
    );
    const accessibilityHeight = Math.max(
      ...snapshot.nodes.map((n) => n.bounds.bottom),
      context.screen.height,
    );
    const x = centerX / accessibilityWidth;
    const y = centerY / accessibilityHeight;
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      x > 1 ||
      y < 0 ||
      y > 1
    ) {
      throw new Error(
        "matched accessibility node is outside the current stream bounds",
      );
    }
    const accepted = enqueueGesture(
      context,
      {
        type: "tap",
        x,
        y,
      },
      "accessibility:tap",
      shouldRecordPayload(payload),
    );
    try {
      const result = await accepted.completion;
      return Response.json({
        ok: true,
        status: result.status,
        node,
        capturedAt: snapshot.capturedAt,
      });
    } catch (err) {
      return errorResponse(err);
    }
  } catch (err) {
    return errorResponse(err);
  }
};

export function inspectionRoutes(): ApiRoute<ApiDependencies>[] {
  return [
    {
      method: "GET",
      path: "/api/logcat",
      handler: async ({ request: req, url, deps }) => {
        const { sessions, requestContext, srv, errorResponse } = deps;
        try {
          sessions.assertCurrent(requestContext);
          srv.timeout(req, 0);
          const packageName = (url.searchParams.get("package") ?? "")
            .trim()
            .slice(0, MAX_LOGCAT_QUERY_BYTES);
          const search = (url.searchParams.get("search") ?? "")
            .trim()
            .slice(0, MAX_LOGCAT_QUERY_BYTES)
            .toLowerCase();
          return requestContext.logcat.subscribe(
            { packageName, search },
            req.signal,
          );
        } catch (err) {
          return errorResponse(err);
        }
      },
    },
    { method: "GET", path: "/api/screenshot", handler: screenshot },
    { method: "POST", path: "/api/screenshot", handler: screenshot },
    {
      method: "GET",
      path: "/api/foreground",
      handler: async ({ request: req, deps }) => {
        const { runForContext, requestContext, errorResponse, device } = deps;
        try {
          return Response.json({
            ok: true,
            app: await runForContext(
              requestContext,
              (context, signal) => device.foregroundApp(context.serial, signal),
              req.signal,
            ),
          });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },
    {
      method: "GET",
      path: "/api/accessibility",
      handler: async ({ deps }) => {
        const { readAccessibilitySnapshot, requestContext, errorResponse } =
          deps;
        try {
          return Response.json(await readAccessibilitySnapshot(requestContext));
        } catch (err) {
          return errorResponse(err);
        }
      },
    },
    {
      method: "POST",
      path: "/api/accessibility/tap",
      handler: accessibilityTap,
    },
  ];
}
