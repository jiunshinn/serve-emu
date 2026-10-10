import { parseGesture, type Gesture } from "../../input.ts";
import { shouldRecordPayload } from "../../session-api.ts";
import type { ApiDependencies } from "../dependencies.ts";
import type { ApiRoute, ApiRouteHandler } from "../router.ts";

/** One gesture of the given type from the JSON payload, recorded as `source`. */
function gestureHandler(
  type: Gesture["type"],
  source: string,
): ApiRouteHandler<ApiDependencies> {
  return async ({ request: req, deps }) => {
    const {
      readJsonBody,
      MAX_JSON_BODY_BYTES,
      requestContext: context,
      enqueueGesture,
      errorResponse,
    } = deps;
    try {
      const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES, context);
      const gesture = parseGesture(
        typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload)
          ? { ...payload, type }
          : payload,
      );
      const accepted = enqueueGesture(
        context,
        gesture,
        source,
        shouldRecordPayload(payload),
      );
      try {
        const result = await accepted.completion;
        return Response.json({ ok: true, status: result.status });
      } catch (err) {
        return errorResponse(err);
      }
    } catch (err) {
      return errorResponse(err);
    }
  };
}

const keyHandler: ApiRouteHandler<ApiDependencies> = async ({
  request: req,
  deps,
}) => {
  const {
    readJsonBody,
    MAX_JSON_BODY_BYTES,
    requestContext: context,
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
      throw new Error("key payload must be an object");
    }
    const key = (payload as Record<string, unknown>).key;
    const gesture =
      key === "back" || key === "home" || key === "recents" || key === "power"
        ? parseGesture({ type: key })
        : parseGesture({ ...payload, type: "key" });
    const accepted = enqueueGesture(
      context,
      gesture,
      "rest:key",
      shouldRecordPayload(payload),
    );
    try {
      const result = await accepted.completion;
      return Response.json({ ok: true, status: result.status });
    } catch (err) {
      return errorResponse(err);
    }
  } catch (err) {
    return errorResponse(err);
  }
};

export function inputRoutes(): ApiRoute<ApiDependencies>[] {
  return [
    {
      method: "POST",
      path: "/api/tap",
      handler: gestureHandler("tap", "rest:tap"),
    },
    {
      method: "POST",
      path: "/api/swipe",
      handler: gestureHandler("swipe", "rest:swipe"),
    },
    {
      method: "POST",
      path: "/api/text",
      handler: gestureHandler("text", "rest:text"),
    },
    { method: "POST", path: "/api/key", handler: keyHandler },
  ];
}
