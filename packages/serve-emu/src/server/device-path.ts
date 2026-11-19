const DEVICE_PREFIX = "/d/";

export type DevicePath = {
  /** The serial named by a `/d/<serial>/` prefix, or null without one. */
  serial: string | null;
  /** The pathname with the prefix removed. */
  path: string;
};

/**
 * Splits `/d/<serial>/rest` into the serial and `/rest`. Returns null for a
 * prefix with an empty or badly encoded serial. Paths without the prefix pass
 * through unchanged.
 */
export function splitDevicePath(pathname: string): DevicePath | null {
  if (!pathname.startsWith(DEVICE_PREFIX)) return { serial: null, path: pathname };
  const rest = pathname.slice(DEVICE_PREFIX.length);
  const slash = rest.indexOf("/");
  const encoded = slash === -1 ? rest : rest.slice(0, slash);
  let serial: string;
  try {
    serial = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (!serial || serial.includes("/")) return null;
  return { serial, path: slash === -1 ? "/" : rest.slice(slash) };
}

/** `/api`, `/health`, and `/ws`, with or without a device prefix. */
export function isServicePath(pathname: string): boolean {
  const path = splitDevicePath(pathname)?.path ?? pathname;
  return (
    path === "/api" ||
    path.startsWith("/api/") ||
    path === "/health" ||
    path === "/ws"
  );
}

export function uiPagePath(
  url: URL,
  target = splitDevicePath(url.pathname),
): "/index.html" | "/compact.html" | null {
  if (url.pathname === "/grid" || url.pathname === "/grid/") return "/compact.html";
  if (target?.path !== "/" && target?.path !== "/index.html") return null;
  return url.searchParams.has("tile") ? "/compact.html" : "/index.html";
}
