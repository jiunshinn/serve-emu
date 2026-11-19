import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getUpdateNotice,
  isNewerVersion,
  UPDATE_CHECK_FAILURE_BACKOFF_MS,
  UPDATE_CHECK_INTERVAL_MS,
  type UpdateCache,
} from "../src/update-check.ts";

describe("isNewerVersion", () => {
  test("compares semver-like versions", () => {
    expect(isNewerVersion("0.0.4", "0.0.3")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.0.9")).toBe(true);
    expect(isNewerVersion("0.0.3", "0.0.3")).toBe(false);
    expect(isNewerVersion("0.0.2", "0.0.3")).toBe(false);
  });
});

describe("getUpdateNotice", () => {
  test("returns a notice when the registry version is newer", async () => {
    const writes: UpdateCache[] = [];

    const notice = await getUpdateNotice({
      packageName: "serve-emu",
      currentVersion: "0.0.3",
      now: () => 1000,
      readCache: async () => null,
      writeCache: async (_path, cache) => {
        writes.push(cache);
      },
      fetchLatest: async () => "0.0.4",
    });

    expect(notice).toBe("Update available: serve-emu 0.0.3 -> 0.0.4\nRun: bunx serve-emu@latest");
    expect(writes).toEqual([{ checkedAt: 1000, latestVersion: "0.0.4" }]);
  });

  test("uses fresh cached versions without fetching", async () => {
    let fetches = 0;

    const notice = await getUpdateNotice({
      packageName: "serve-emu",
      currentVersion: "0.0.3",
      now: () => UPDATE_CHECK_INTERVAL_MS,
      readCache: async () => ({ checkedAt: 1, latestVersion: "0.0.4" }),
      fetchLatest: async () => {
        fetches += 1;
        return "0.0.5";
      },
    });

    expect(notice).toBe("Update available: serve-emu 0.0.3 -> 0.0.4\nRun: bunx serve-emu@latest");
    expect(fetches).toBe(0);
  });

  test("does not return a notice when already current", async () => {
    const notice = await getUpdateNotice({
      packageName: "serve-emu",
      currentVersion: "0.0.3",
      readCache: async () => null,
      writeCache: async () => {},
      fetchLatest: async () => "0.0.3",
    });

    expect(notice).toBeNull();
  });
});

describe("failed update checks", () => {
  const HOUR = 60 * 60 * 1000;

  function memoryCache(initial: UpdateCache | null = null) {
    let cache = initial;
    return {
      get: () => cache,
      readCache: async () => cache,
      writeCache: async (_path: string, next: UpdateCache) => {
        cache = JSON.parse(JSON.stringify(next)) as UpdateCache;
      },
    };
  }

  test("remembers a failure and skips the registry until the backoff ends", async () => {
    const cache = memoryCache();
    let fetches = 0;
    const check = (now: number, result: () => Promise<string | null>) =>
      getUpdateNotice({
        packageName: "serve-emu",
        currentVersion: "1.0.0",
        now: () => now,
        readCache: cache.readCache,
        writeCache: cache.writeCache,
        fetchLatest: async () => {
          fetches += 1;
          return result();
        },
      });

    // Unreachable registry (a thrown fetch), then a bad response (null).
    expect(await check(1_000, () => Promise.reject(new Error("getaddrinfo ENOTFOUND")))).toBeNull();
    expect(cache.get()).toEqual({ failedAt: 1_000 });
    expect(await check(1_000 + UPDATE_CHECK_FAILURE_BACKOFF_MS - 1, async () => "9.9.9")).toBeNull();
    expect(fetches).toBe(1);

    expect(await check(1_000 + UPDATE_CHECK_FAILURE_BACKOFF_MS, async () => null)).toBeNull();
    expect(fetches).toBe(2);
    expect(cache.get()).toEqual({ failedAt: 1_000 + UPDATE_CHECK_FAILURE_BACKOFF_MS });

    // After the next backoff the registry answers, and the marker is cleared.
    const recovered = await check(1_000 + 2 * UPDATE_CHECK_FAILURE_BACKOFF_MS, async () => "1.1.0");
    expect(recovered).toContain("1.0.0 -> 1.1.0");
    expect(fetches).toBe(3);
    expect(cache.get()).toEqual({
      checkedAt: 1_000 + 2 * UPDATE_CHECK_FAILURE_BACKOFF_MS,
      latestVersion: "1.1.0",
    });
    expect(UPDATE_CHECK_FAILURE_BACKOFF_MS).toBe(HOUR);
  });

  test("a stale cache plus a failed fetch still reports the cached newer version", async () => {
    const cache = memoryCache({ checkedAt: 0, latestVersion: "2.0.0" });
    const now = UPDATE_CHECK_INTERVAL_MS + 5;
    const notice = await getUpdateNotice({
      packageName: "serve-emu",
      currentVersion: "1.0.0",
      now: () => now,
      readCache: cache.readCache,
      writeCache: cache.writeCache,
      fetchLatest: async () => {
        throw new Error("timeout");
      },
    });
    expect(notice).toContain("1.0.0 -> 2.0.0");
    expect(cache.get()).toEqual({ checkedAt: 0, latestVersion: "2.0.0", failedAt: now });

    // Within the backoff the cached notice keeps showing without a fetch.
    let fetched = false;
    const again = await getUpdateNotice({
      packageName: "serve-emu",
      currentVersion: "1.0.0",
      now: () => now + 1,
      readCache: cache.readCache,
      writeCache: cache.writeCache,
      fetchLatest: async () => {
        fetched = true;
        return null;
      },
    });
    expect(again).toContain("1.0.0 -> 2.0.0");
    expect(fetched).toBe(false);
  });

  test.each(["before", "during"] as const)(
    "a check cancelled by shutdown %s the fetch is not recorded as a failure",
    async (when) => {
      const cache = memoryCache();
      const controller = new AbortController();
      let fetches = 0;
      let fetching!: () => void;
      const started = new Promise<void>((resolve) => {
        fetching = resolve;
      });
      if (when === "before") controller.abort(new Error("serve-emu stopping"));
      const notice = getUpdateNotice({
        packageName: "serve-emu",
        currentVersion: "1.0.0",
        signal: controller.signal,
        readCache: cache.readCache,
        writeCache: cache.writeCache,
        fetchLatest: (_name, signal) => {
          fetches += 1;
          fetching();
          return new Promise((_resolve, reject) => {
            if (signal?.aborted) reject(signal.reason);
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      });
      if (when === "during") {
        await started;
        controller.abort(new Error("serve-emu stopping"));
      }
      expect(await notice).toBeNull();
      expect(fetches).toBe(when === "before" ? 0 : 1);
      expect(cache.get()).toBeNull();
    },
  );

  test("a clock that moved backwards does not extend the backoff", async () => {
    const cache = memoryCache({ failedAt: 10 * HOUR });
    let fetches = 0;
    await getUpdateNotice({
      packageName: "serve-emu",
      currentVersion: "1.0.0",
      now: () => HOUR,
      readCache: cache.readCache,
      writeCache: cache.writeCache,
      fetchLatest: async () => {
        fetches += 1;
        return "1.0.0";
      },
    });
    expect(fetches).toBe(1);
  });

  test("ignores cache fields with the wrong type", async () => {
    const directory = await mkdtemp(join(tmpdir(), "serve-emu-update-test-"));
    try {
      const cachePath = join(directory, "update-check.json");
      await writeFile(cachePath, JSON.stringify({ checkedAt: "yesterday", latestVersion: 2, failedAt: null }));
      let fetches = 0;
      await getUpdateNotice({
        packageName: "serve-emu",
        currentVersion: "1.0.0",
        cachePath,
        now: () => 1_000,
        fetchLatest: async () => {
          fetches += 1;
          return null;
        },
      });
      expect(fetches).toBe(1);
      expect(JSON.parse(await readFile(cachePath, "utf8"))).toEqual({ failedAt: 1_000 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
