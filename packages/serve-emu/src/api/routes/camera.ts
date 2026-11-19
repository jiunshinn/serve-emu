import { CameraImageError, cameraImageSize, MAX_CAMERA_IMAGE_BYTES } from "../../camera-images.ts";
import { readBodyLimited } from "../../request-body.ts";
import { ApiError } from "../api-error.ts";
import type { ApiDependencies } from "../dependencies.ts";
import type { ApiRoute } from "../router.ts";

export function cameraRoutes(): ApiRoute<ApiDependencies>[] {
  return [
    {
      method: "GET", path: "/api/camera",
      handler: async ({ deps }) => {
        try {
          return await deps.runForPublishedContext(deps.requestContext, async (context) =>
            Response.json({ ok: true, ...(deps.cameraImages(context.serial)?.modes ?? { back: null, front: null }) }));
        } catch (error) { return deps.errorResponse(error, "internal_error"); }
      },
    },
    {
      method: "PUT", path: "/api/camera/image",
      handler: async ({ request, deps }) => {
        try {
          const query = new URL(request.url).searchParams;
          const camera = query.get("camera") ?? "back";
          if (camera !== "back" && camera !== "front") throw new ApiError(400, "invalid_request", "camera must be back or front.");
          const restart = query.get("restartApp");
          if (restart !== null && restart !== "true" && restart !== "false") throw new ApiError(400, "invalid_request", "restartApp must be true or false.");
          return await deps.runForContext(deps.requestContext, async (context, signal) => {
            const images = deps.cameraImages(context.serial);
            if (!images) throw new CameraImageError("unavailable", `Launch this AVD with ${camera === "back" ? "cameraBack" : "cameraFront"}: "uploaded" to upload a ${camera} camera image.`);
            images.assertUploaded(camera);
            const bytes = await readBodyLimited(request, MAX_CAMERA_IMAGE_BYTES, signal);
            const size = cameraImageSize(bytes);
            const app = restart === "true" ? await deps.device.foregroundApp(context.serial, signal) : null;
            if (app && !app.packageName) throw new ApiError(409, "conflict", "No foreground app to restart.");
            await images.write(camera, bytes, signal);
            if (app?.packageName) {
              await deps.device.forceStopApp(context.serial, app.packageName, signal);
              await deps.device.launchApp(context.serial, app.packageName, app.activity ?? undefined, signal);
            }
            return Response.json({ ok: true, camera, ...size, bytes: bytes.length, ...(app?.packageName ? { restartedApp: app.packageName } : {}) });
          }, request.signal);
        } catch (error) {
          if (request.body && !request.body.locked) await request.body.cancel(error).catch(() => {});
          return deps.errorResponse(error, "internal_error");
        }
      },
    },
  ];
}
