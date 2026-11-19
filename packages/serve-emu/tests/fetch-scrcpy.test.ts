import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCRCPY_SERVER_PATH,
  SCRCPY_SERVER_SHA256,
  SCRCPY_VERSION,
  ScrcpyServerChecksumError,
  ensureScrcpyServer,
} from "../scripts/fetch-scrcpy.ts";

const GOOD: Uint8Array<ArrayBuffer> = new TextEncoder().encode("scrcpy server bytes");
const GOOD_SHA256 = createHash("sha256").update(GOOD).digest("hex");
const TAMPERED: Uint8Array<ArrayBuffer> = new TextEncoder().encode("scrcpy server bytez");

let dir: string;
let path: string;
let downloads: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "serve-emu-fetch-scrcpy-"));
  path = join(dir, "vendor", `scrcpy-server-v${SCRCPY_VERSION}`);
  downloads = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function serving(body: Uint8Array<ArrayBuffer>, status = 200) {
  return async (url: string) => {
    downloads.push(url);
    return new Response(body, { status });
  };
}

function ensure(download: (url: string) => Promise<Response>) {
  return ensureScrcpyServer({
    path,
    expectedSha256: GOOD_SHA256,
    download,
    log: () => {},
  });
}

async function vendorEntries(): Promise<string[]> {
  return existsSync(join(dir, "vendor")) ? readdir(join(dir, "vendor")) : [];
}

describe("ensureScrcpyServer", () => {
  test("pins the upstream SHA-256 for the pinned version", () => {
    expect(SCRCPY_SERVER_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(SCRCPY_SERVER_PATH.endsWith(`scrcpy-server-v${SCRCPY_VERSION}`)).toBe(true);
  });

  test("downloads, verifies, and writes a missing server", async () => {
    expect(await ensure(serving(GOOD))).toBe(path);
    expect(new Uint8Array(await readFile(path))).toEqual(GOOD);
    expect(downloads).toEqual([
      `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`,
    ]);
    // Only the final file: the temporary write was renamed into place.
    expect(await vendorEntries()).toEqual([`scrcpy-server-v${SCRCPY_VERSION}`]);
  });

  test("returns a matching existing server without downloading", async () => {
    await ensure(serving(GOOD));
    downloads = [];
    expect(await ensure(serving(TAMPERED))).toBe(path);
    expect(downloads).toEqual([]);
  });

  test("rejects a download that does not match and writes nothing", async () => {
    const result = ensure(serving(TAMPERED));
    await expect(result).rejects.toBeInstanceOf(ScrcpyServerChecksumError);
    await expect(result).rejects.toThrow(`expected ${GOOD_SHA256}`);
    expect(existsSync(path)).toBe(false);
    expect(await vendorEntries()).toEqual([]);
  });

  test("replaces an existing corrupt or empty server with a verified download", async () => {
    for (const corrupt of [TAMPERED, new Uint8Array()]) {
      await rm(join(dir, "vendor"), { recursive: true, force: true });
      await ensure(serving(GOOD));
      await writeFile(path, corrupt);
      downloads = [];

      expect(await ensure(serving(GOOD))).toBe(path);
      expect(downloads).toHaveLength(1);
      expect(new Uint8Array(await readFile(path))).toEqual(GOOD);
    }
  });

  test("never leaves a corrupt server behind when the replacement also fails", async () => {
    await ensure(serving(GOOD));
    await writeFile(path, TAMPERED);

    await expect(ensure(serving(TAMPERED))).rejects.toBeInstanceOf(
      ScrcpyServerChecksumError,
    );
    expect(existsSync(path)).toBe(false);
    await expect(ensure(serving(GOOD, 503))).rejects.toThrow("503");
    expect(existsSync(path)).toBe(false);
  });
});
