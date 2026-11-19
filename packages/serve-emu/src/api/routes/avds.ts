import type { ApiDependencies } from "../dependencies.ts";
import type { ApiRoute } from "../router.ts";

/** AVDs belong to the host, independent of the selected device session. */
export function avdRoutes(): ApiRoute<ApiDependencies>[] {
  return [
    {
      method: "GET",
      path: "/api/avds/catalog",
      handler: async ({ deps }) => {
        try {
          return Response.json({ ok: true, ...(await deps.avds.catalog()) });
        } catch (err) {
          return deps.errorResponse(err, "internal_error");
        }
      },
    },
    {
      method: "POST",
      path: "/api/avds/create",
      handler: async ({ request: req, deps }) => {
        try {
          const payload = await deps.readJsonBody(req, deps.MAX_JSON_BODY_BYTES);
          const { name } = await deps.avds.create(payload);
          return Response.json({ ok: true, avd: name }, { status: 201 });
        } catch (err) {
          return deps.errorResponse(err);
        }
      },
    },
  ];
}
