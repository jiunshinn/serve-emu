/** URL prefix of one device's own UI and APIs. */
export function deviceBase(serial: string): string {
  return `/d/${encodeURIComponent(serial)}`;
}

/**
 * `/d/<serial>` when this page is a device's own UI, else "". Requests use it
 * so the page talks to the device it was opened for.
 */
export const PAGE_BASE =
  typeof location === "undefined"
    ? ""
    : (/^\/d\/[^/]+/.exec(location.pathname)?.[0] ?? "");
