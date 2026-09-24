import { AvdManagerError } from "../../avd-manager.ts";
import type { ApiDependencies } from "../dependencies.ts";
import type { ApiRoute } from "../router.ts";

export function avdRoutes(): ApiRoute<ApiDependencies>[] {
  return [
    {
      method: "GET",
      path: "/api/avds/catalog",
      handler: async ({ deps }) => {
        try {
          return Response.json({ ok: true, ...await deps.getAvdCatalog() });
        } catch (err) {
          return deps.errorResponse(err, err instanceof AvdManagerError ? err.status : 500);
        }
      },
    },
    {
      method: "POST",
      path: "/api/avds/create",
      handler: async ({ request, deps }) => {
        try {
          // AVDs belong to the host, independent of the selected device session.
          const payload = await deps.readJsonBody(request, deps.MAX_JSON_BODY_BYTES);
          const result = await deps.createAvd(payload);
          return Response.json({ ok: true, avd: result.name }, { status: 201 });
        } catch (err) {
          return deps.errorResponse(err, err instanceof AvdManagerError ? err.status : 400);
        }
      },
    },
  ];
}
