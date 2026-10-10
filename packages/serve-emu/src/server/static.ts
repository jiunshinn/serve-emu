import { join } from "node:path";

/** Serves a file from the bundled UI directory, or a plain 404. */
export async function serveStaticFile(root: string, pathname: string): Promise<Response> {
  const reqPath = pathname === "/" ? "/index.html" : pathname;
  if (reqPath.includes("..")) return new Response("not found", { status: 404 });
  const file = Bun.file(join(root, reqPath));
  if (await file.exists()) return new Response(file);
  return new Response("not found", { status: 404 });
}
