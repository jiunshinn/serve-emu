import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** After a failed check, wait this long before contacting the registry again. */
export const UPDATE_CHECK_FAILURE_BACKOFF_MS = 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 1_500;

/** Resolved on use, not at import, so tests and opted-out runs never touch $HOME. */
export function defaultUpdateCachePath(): string {
  return join(homedir(), ".cache", "serve-emu", "update-check.json");
}

export type UpdateCache = {
  checkedAt?: number;
  latestVersion?: string;
  /** Time of the last failed check; suppresses retries during the backoff. */
  failedAt?: number;
};

export type UpdateCheckOptions = {
  packageName: string;
  currentVersion: string;
  cachePath?: string;
  now?: () => number;
  /** Aborts an in-flight registry request (for example on shutdown). */
  signal?: AbortSignal;
  fetchLatest?: (packageName: string, signal?: AbortSignal) => Promise<string | null>;
  readCache?: (cachePath: string) => Promise<UpdateCache | null>;
  writeCache?: (cachePath: string, cache: UpdateCache) => Promise<void>;
};

function parseVersion(version: string): number[] {
  return version
    .replace(/^v/, "")
    .split("-")[0]
    .split(".")
    .map((part) => Number(part))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

export function isNewerVersion(latest: string, current: string): boolean {
  const latestParts = parseVersion(latest);
  const currentParts = parseVersion(current);
  const length = Math.max(latestParts.length, currentParts.length);

  for (let i = 0; i < length; i++) {
    const latestPart = latestParts[i] ?? 0;
    const currentPart = currentParts[i] ?? 0;
    if (latestPart > currentPart) return true;
    if (latestPart < currentPart) return false;
  }

  return false;
}

async function readUpdateCache(cachePath: string): Promise<UpdateCache | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      checkedAt: typeof parsed.checkedAt === "number" ? parsed.checkedAt : undefined,
      latestVersion: typeof parsed.latestVersion === "string" ? parsed.latestVersion : undefined,
      failedAt: typeof parsed.failedAt === "number" ? parsed.failedAt : undefined,
    };
  } catch {
    return null;
  }
}

async function writeUpdateCache(cachePath: string, cache: UpdateCache) {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(cache)}\n`);
}

async function fetchLatestVersion(
  packageName: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const timeout = AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS);
  const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) return null;

  const latest = (await res.json()) as { version?: unknown };
  return typeof latest.version === "string" ? latest.version : null;
}

export async function getUpdateNotice(options: UpdateCheckOptions): Promise<string | null> {
  const cachePath = options.cachePath ?? defaultUpdateCachePath();
  const now = options.now ?? Date.now;
  const readCacheFn = options.readCache ?? readUpdateCache;
  const writeCacheFn = options.writeCache ?? writeUpdateCache;
  const fetchLatestFn = options.fetchLatest ?? fetchLatestVersion;

  const cached = await readCacheFn(cachePath);
  let latestVersion = cached?.latestVersion;
  const checkedAt = now();
  const fresh =
    cached?.checkedAt !== undefined &&
    latestVersion !== undefined &&
    checkedAt - cached.checkedAt < UPDATE_CHECK_INTERVAL_MS;
  const backingOff =
    cached?.failedAt !== undefined &&
    checkedAt >= cached.failedAt &&
    checkedAt - cached.failedAt < UPDATE_CHECK_FAILURE_BACKOFF_MS;

  if (!fresh && !backingOff && !options.signal?.aborted) {
    let fetchedVersion: string | null = null;
    try {
      fetchedVersion = await fetchLatestFn(options.packageName, options.signal);
    } catch {
      // Offline, DNS failure, timeout, or shutdown: remembered below.
    }
    if (fetchedVersion) {
      latestVersion = fetchedVersion;
      await writeCacheFn(cachePath, { checkedAt, latestVersion });
    } else if (!options.signal?.aborted) {
      // Remember the failure so the next runs skip the registry for a while,
      // and keep the last known version so its notice still shows.
      await writeCacheFn(cachePath, {
        checkedAt: cached?.checkedAt,
        latestVersion,
        failedAt: checkedAt,
      });
    }
  }

  if (!latestVersion || !isNewerVersion(latestVersion, options.currentVersion)) return null;

  return (
    `Update available: ${options.packageName} ${options.currentVersion} -> ${latestVersion}\n` +
    `Run: bunx ${options.packageName}@latest`
  );
}
