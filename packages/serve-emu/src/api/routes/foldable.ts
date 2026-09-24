import { isFoldPosture } from "../../shared/foldable-contracts.ts";
import type { ApiDependencies } from "../dependencies.ts";
import type { ApiRoute } from "../router.ts";

export function foldableRoutes(): ApiRoute<ApiDependencies>[] {
  return [
    {
      method: "GET", path: "/api/foldable",
      handler: async ({ deps }) => {
        try {
          const foldable = await deps.runForContext(deps.requestContext, (context) =>
            deps.getFoldableState(context.serial, context.signal));
          return Response.json({ ok: true, foldable });
        } catch (err) { return deps.errorResponse(err); }
      },
    },
    {
      method: "POST", path: "/api/foldable",
      handler: async ({ request, deps }) => {
        try {
          const payload = await deps.readJsonBody(request, deps.MAX_JSON_BODY_BYTES, deps.requestContext);
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("foldable payload must be an object");
          const body = payload as Record<string, unknown>;
          if (!isFoldPosture(body.posture)) throw new Error("posture must be folded, half-open, or unfolded");
          if (body.record !== undefined && typeof body.record !== "boolean") throw new Error("record must be a boolean");
          const posture = body.posture;
          const foldable = await deps.runForContext(deps.requestContext, async (context) => {
            const result = await deps.setFoldPosture(context.serial, posture, context.signal);
            deps.sessions.assertCurrent(context);
            if (body.record !== false) context.recorder.recordPosture(posture, "api:foldable");
            return result;
          });
          return Response.json({ ok: true, foldable });
        } catch (err) { return deps.errorResponse(err); }
      },
    },
  ];
}
