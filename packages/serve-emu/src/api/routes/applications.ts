import type { ApiDependencies } from "../dependencies.ts";
import type { ApiRoute } from "../router.ts";

/**
 * Answers a multipart upload: its result as JSON, or the mapped error after
 * releasing whatever of the request body was not read.
 */
async function uploadResponse(
  deps: ApiDependencies,
  req: Request,
  upload: () => Promise<unknown>,
): Promise<Response> {
  try {
    return Response.json(await upload());
  } catch (error) {
    if (req.body && !req.body.locked) {
      await req.body.cancel(error).catch(() => {});
    }
    return deps.errorResponse(error);
  }
}

/** Runs an app action on the current session with the JSON object payload. */
async function appAction(
  deps: ApiDependencies,
  req: Request,
  action: (
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ) => unknown | Promise<unknown>,
): Promise<Response> {
  const {
    readJsonBody,
    MAX_JSON_BODY_BYTES,
    requestContext: context,
    runForContext,
    errorResponse,
  } = deps;
  try {
    const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES, context);
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      throw new Error("payload must be an object");
    }
    const result = await runForContext(
      context,
      (_captured, signal) =>
        Promise.resolve(action(payload as Record<string, unknown>, signal)),
      req.signal,
    );
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

export function applicationRoutes(): ApiRoute<ApiDependencies>[] {
  return [
    {
      method: "POST",
      path: "/api/apps/install",
      handler: async ({ request: req, deps }) => {
        const { uploads, requestContext } = deps;
        return uploadResponse(deps, req, () =>
          uploads.install(requestContext, req),
        );
      },
    },
    {
      method: "POST",
      path: "/api/files/import",
      handler: async ({ request: req, deps }) => {
        const { uploads, requestContext } = deps;
        return uploadResponse(deps, req, () =>
          uploads.importFile(requestContext, req),
        );
      },
    },
    {
      method: "POST",
      path: "/api/apps/launch",
      handler: async ({ request: req, deps }) => {
        const { requestContext, device } = deps;
        return appAction(deps, req, (payload, signal) =>
          device.launchApp(
            requestContext.serial,
            String(payload.packageName ?? ""),
            typeof payload.activity === "string" && payload.activity.trim()
              ? payload.activity
              : undefined,
            signal,
          ),
        );
      },
    },
    {
      method: "POST",
      path: "/api/apps/clear",
      handler: async ({ request: req, deps }) => {
        const { requestContext, device } = deps;
        return appAction(deps, req, (payload, signal) =>
          device.clearAppData(
            requestContext.serial,
            String(payload.packageName ?? ""),
            signal,
          ),
        );
      },
    },
    {
      method: "POST",
      path: "/api/apps/force-stop",
      handler: async ({ request: req, deps }) => {
        const { requestContext, device } = deps;
        return appAction(deps, req, (payload, signal) =>
          device.forceStopApp(
            requestContext.serial,
            String(payload.packageName ?? ""),
            signal,
          ),
        );
      },
    },
    {
      method: "POST",
      path: "/api/apps/grant",
      handler: async ({ request: req, deps }) => {
        const { requestContext, device } = deps;
        return appAction(deps, req, (payload, signal) =>
          device.grantPermission(
            requestContext.serial,
            String(payload.packageName ?? ""),
            String(payload.permission ?? ""),
            signal,
          ),
        );
      },
    },
  ];
}
