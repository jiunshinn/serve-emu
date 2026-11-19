import { isFoldPosture } from "../../shared/foldable-contracts.ts";
import type { ApiDependencies } from "../dependencies.ts";
import type { ApiRoute } from "../router.ts";

export function foldableRoutes(): ApiRoute<ApiDependencies>[] {
  return [
    {
      method: "GET",
      path: "/api/foldable",
      handler: async ({ request: req, deps }) => {
        const { runForContext, requestContext, errorResponse, device } = deps;
        try {
          return Response.json({
            ok: true,
            foldable: await runForContext(
              requestContext,
              (context, signal) => device.foldable(context.serial, signal),
              req.signal,
            ),
          });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },
    {
      method: "POST",
      path: "/api/foldable",
      handler: async ({ request: req, deps }) => {
        const {
          runForContext,
          requestContext,
          errorResponse,
          readJsonBody,
          MAX_JSON_BODY_BYTES,
          sessions,
          device,
        } = deps;
        try {
          const payload = await readJsonBody(
            req,
            MAX_JSON_BODY_BYTES,
            requestContext,
          );
          if (
            typeof payload !== "object" ||
            payload === null ||
            Array.isArray(payload)
          ) {
            throw new Error("foldable payload must be an object");
          }
          const { posture, record } = payload as Record<string, unknown>;
          if (!isFoldPosture(posture)) {
            throw new Error("posture must be folded, half-open, or unfolded");
          }
          if (record !== undefined && typeof record !== "boolean") {
            throw new Error("record must be a boolean");
          }
          return Response.json({
            ok: true,
            foldable: await runForContext(
              requestContext,
              async (context, signal) => {
                const result = await device.setFoldPosture(
                  context.serial,
                  posture,
                  signal,
                );
                sessions.assertCurrent(context);
                if (record !== false) {
                  context.recorder.recordPosture(posture, "rest:foldable");
                }
                return result;
              },
              req.signal,
            ),
          });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },
  ];
}
