import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Version = readonly [major: number, minor: number, patch: number];

const USAGE = "Usage: bun run release <patch|minor|major|x.y.z> [--dry-run]";
// Semver core without leading zeros: 0.1.00 and 01.0.0 are not versions.
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_HEADING = /^## \d+\.\d+\.\d+ - /m;

/** A mistake in the release request, reported as one line without a stack. */
export class ReleaseError extends Error {
  override readonly name = "ReleaseError";
}

export function parseVersion(value: unknown): Version {
  const match = typeof value === "string" ? VERSION_PATTERN.exec(value) : null;
  const parts = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [];
  if (parts.length !== 3 || !parts.every(Number.isSafeInteger)) {
    throw new ReleaseError(
      `Expected a version like 1.2.3 without leading zeros, got ${String(value)}`,
    );
  }
  return parts as unknown as Version;
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
}

export function nextVersion(current: string, bump: string): string {
  const [major, minor, patch] = parseVersion(current);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;

  if (!VERSION_PATTERN.test(bump)) {
    throw new ReleaseError(
      `Expected patch, minor, major, or a version like 1.2.3 without leading zeros, got ${bump}`,
    );
  }
  if (compareVersions(bump, current) <= 0) {
    throw new ReleaseError(
      `${bump} is not greater than the current version ${current}`,
    );
  }
  return bump;
}

export function changelogEntry(version: string, subjects: string[], date: string): string {
  const lines = subjects.length > 0 ? subjects : ["Release maintenance."];

  return [
    `## ${version} - ${date}`,
    "",
    "### Changed",
    "",
    ...lines.map((line) => `- ${line}`),
    "",
  ].join("\n");
}

/** Puts the entry above the newest release, or after a preamble with none. */
export function insertChangelogEntry(current: string, version: string, entry: string): string {
  if (current.includes(`## ${version} - `)) {
    throw new ReleaseError(`CHANGELOG.md already has an entry for ${version}`);
  }

  const firstRelease = RELEASE_HEADING.exec(current);
  if (firstRelease === null) {
    return `${current.trimEnd()}\n\n${entry}`;
  }

  return `${current.slice(0, firstRelease.index)}${entry}\n${current.slice(firstRelease.index)}`;
}

type ReleaseOptions = {
  packageDir?: string;
  /** stdout of a successful git command, or null. */
  runGit?: (args: string[]) => string | null;
  log?: (line: string) => void;
  today?: () => string;
};

function systemGit(packageDir: string) {
  return (args: string[]): string | null => {
    const result = spawnSync("git", args, { cwd: packageDir, encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : null;
  };
}

export function release(args: string[], options: ReleaseOptions = {}): void {
  const packageDir = options.packageDir ?? resolve(import.meta.dir, "..");
  const runGit = options.runGit ?? systemGit(packageDir);
  const log = options.log ?? ((line: string) => console.log(line));
  const today = options.today ?? (() => new Date().toISOString().slice(0, 10));
  const packageJsonPath = resolve(packageDir, "package.json");
  const changelogPath = resolve(packageDir, "CHANGELOG.md");

  const bumpArg = args.find((arg) => !arg.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  if (!bumpArg) throw new ReleaseError(USAGE);

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version?: unknown;
    [key: string]: unknown;
  };
  const currentVersion = String(packageJson.version);
  parseVersion(currentVersion);
  const version = nextVersion(currentVersion, bumpArg);
  if (runGit(["rev-parse", "-q", "--verify", `refs/tags/v${version}`]) !== null) {
    throw new ReleaseError(`Tag v${version} already exists`);
  }

  packageJson.version = version;
  const tag = runGit(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"]) || null;
  const subjects = (runGit(["log", "--format=%s", "--no-merges", tag ? `${tag}..HEAD` : "HEAD"]) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const nextChangelog = insertChangelogEntry(
    readFileSync(changelogPath, "utf8"),
    version,
    changelogEntry(version, subjects, today()),
  );

  log(`${currentVersion} -> ${version}`);
  if (tag) log(`Changes since ${tag}`);
  if (subjects.length === 0) log("No commit subjects found; using a maintenance placeholder.");

  if (dryRun) {
    log("\nDry run only. No files changed.");
    return;
  }

  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFileSync(changelogPath, nextChangelog);

  log("\nUpdated:");
  log(`- ${packageJsonPath}`);
  log(`- ${changelogPath}`);
  log("\nNext:");
  log("1. Review CHANGELOG.md and edit sections if needed.");
  log("2. Run: bun run check");
  log(`3. Commit: git commit -m "Release v${version}" -- packages/serve-emu/package.json packages/serve-emu/CHANGELOG.md`);
  log(`4. Tag: git tag v${version}`);
  log("5. Publish from a clean tree: npm publish packages/serve-emu");
}

if (import.meta.main) {
  try {
    release(Bun.argv.slice(2));
  } catch (error) {
    if (!(error instanceof ReleaseError)) throw error;
    console.error(`release: ${error.message}`);
    process.exit(1);
  }
}
