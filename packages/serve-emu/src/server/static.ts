import { join } from "node:path";

const UI_ASSET_PATH = /^\/assets\/.*\.(?:js|css)$/;

function acceptsGzip(header: string | null): boolean {
  if (!header) return false;
  let gzip: number | undefined;
  let wildcard: number | undefined;
  let identity: number | undefined;
  for (const entry of header.toLowerCase().split(",")) {
    const [name, weight] = entry.split(";");
    const coding = name.trim();
    if (coding !== "gzip" && coding !== "*" && coding !== "identity") continue;
    const q = weight === undefined ? 1 :
      Number(/^\s*q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/.exec(weight)?.[1] ?? 0);
    if (coding === "gzip") gzip = q;
    else if (coding === "*") wildcard = q;
    else identity = q;
  }
  const preferred = gzip ?? wildcard ?? 0;
  return preferred > 0 && preferred >= (identity ?? 0);
}

/** Serves a file from the bundled UI directory, or a plain 404. */
export async function serveStaticFile(
  root: string,
  pathname: string,
  acceptEncoding: string | null = null,
): Promise<Response> {
  const reqPath =
    pathname === "/" || pathname === "/grid" || pathname === "/grid/"
      ? "/index.html"
      : pathname;
  if (
    reqPath.includes("..") ||
    (reqPath.endsWith(".gz") && UI_ASSET_PATH.test(reqPath.slice(0, -3)))
  ) {
    return new Response("not found", { status: 404 });
  }
  const file = Bun.file(join(root, reqPath));
  const headers = UI_ASSET_PATH.test(reqPath) ? { Vary: "Accept-Encoding" } : undefined;
  if (headers && acceptsGzip(acceptEncoding)) {
    const compressed = Bun.file(join(root, `${reqPath}.gz`));
    if (await compressed.exists()) {
      return new Response(compressed, {
        headers: { ...headers, "Content-Encoding": "gzip", "Content-Type": file.type },
      });
    }
  }
  if (await file.exists()) return new Response(file, { headers });
  return new Response("not found", { status: 404 });
}
