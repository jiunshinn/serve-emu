import type { ApiDependencies } from "../dependencies.ts";
import type { ApiRoute } from "../router.ts";

export function applicationRoutes(): ApiRoute<ApiDependencies>[] {
  return [
    {
      method: "POST",
      path: "/api/apps/install",
      handler: async ({ request: req, deps }) => {
        const { installEndpoint, requestContext } = deps;
        return installEndpoint(requestContext, req);
      },
    },
    {
      method: "POST",
      path: "/api/files/import",
      handler: async ({ request: req, deps }) => {
        const { fileImportEndpoint, requestContext } = deps;
        return fileImportEndpoint(requestContext, req);
      },
    },
    {
      method: "POST",
      path: "/api/apps/launch",
      handler: async ({ request: req, deps }) => {
        const { appJsonEndpoint, requestContext, device } = deps;
        return appJsonEndpoint(requestContext, req, (payload, signal) =>
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
        const { appJsonEndpoint, requestContext, device } = deps;
        return appJsonEndpoint(requestContext, req, (payload, signal) =>
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
        const { appJsonEndpoint, requestContext, device } = deps;
        return appJsonEndpoint(requestContext, req, (payload, signal) =>
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
        const { appJsonEndpoint, requestContext, device } = deps;
        return appJsonEndpoint(requestContext, req, (payload, signal) =>
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
