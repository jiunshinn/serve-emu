import type { ApiDependencies } from "../dependencies.ts";
import type { ApiRoute, ApiRouteHandler } from "../router.ts";

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

export function inspectionRoutes(): ApiRoute<ApiDependencies>[] {
  return [
    {
      method: "GET",
      path: "/api/logcat",
      handler: async ({ request: req, url, deps }) => {
        const { sessions, requestContext, srv, logcatStream, errorResponse } =
          deps;
        try {
          sessions.assertCurrent(requestContext);
          srv.timeout(req, 0);
          return logcatStream(requestContext, req, url);
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
      handler: async ({ request: req, deps }) => {
        const { accessibilityTapEndpoint, requestContext } = deps;
        return accessibilityTapEndpoint(requestContext, req);
      },
    },
  ];
}
