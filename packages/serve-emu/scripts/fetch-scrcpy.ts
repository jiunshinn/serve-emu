#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Canonical wire spec and scrcpy version upgrade checklist: ../docs/protocol.md
export const SCRCPY_VERSION = "4.0";
// The `scrcpy-server-v4.0` line of the release's upstream SHA256SUMS.txt.
// The server is pushed to and run on the user's device, so a file with any
// other digest is never used.
export const SCRCPY_SERVER_SHA256 =
  "84924bd564a1eb6089c872c7521f968058977f91f5ff02514a8c74aff3210f3a";
const DOWNLOAD_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = join(__dirname, "..", "vendor");
export const SCRCPY_SERVER_PATH = join(VENDOR_DIR, `scrcpy-server-v${SCRCPY_VERSION}`);

export class ScrcpyServerChecksumError extends Error {
  override readonly name = "ScrcpyServerChecksumError";
}

export type EnsureScrcpyServerOptions = {
  path?: string;
  /** Tests substitute their own bytes and digest. */
  expectedSha256?: string;
  download?: (url: string) => Promise<Response>;
  log?: (line: string) => void;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readIfPresent(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Returns the path of a scrcpy server whose SHA-256 matches the pinned digest.
 * A missing or mismatched file is (re)downloaded; a download that does not
 * match is rejected without touching the target path.
 */
export async function ensureScrcpyServer(
  options: EnsureScrcpyServerOptions = {},
): Promise<string> {
  const path = options.path ?? SCRCPY_SERVER_PATH;
  const expected = options.expectedSha256 ?? SCRCPY_SERVER_SHA256;
  const log = options.log ?? ((line: string) => console.log(line));
  const existing = await readIfPresent(path);
  if (existing) {
    if (sha256(existing) === expected) return path;
    log(`${path} does not match the pinned SHA-256; downloading it again`);
    await rm(path, { force: true });
  }

  log(`Downloading scrcpy-server v${SCRCPY_VERSION}…`);
  const res = await (options.download ?? fetch)(DOWNLOAD_URL);
  if (!res.ok) throw new Error(`Failed to download ${DOWNLOAD_URL}: ${res.status} ${res.statusText}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== expected) {
    throw new ScrcpyServerChecksumError(
      `Downloaded scrcpy-server v${SCRCPY_VERSION} has SHA-256 ${digest}, expected ${expected}; refusing to use it`,
    );
  }

  // Write next to the target and rename, so a crash never leaves a partial
  // file under the final name.
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  log(`Saved ${path} (${bytes.byteLength} bytes)`);
  return path;
}

if (import.meta.main) {
  // Progress goes to stderr: as `prepack` this runs inside `npm pack --json`,
  // whose stdout must stay valid JSON.
  await ensureScrcpyServer({ log: (line) => console.error(line) });
}
