import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReleaseError,
  changelogEntry,
  compareVersions,
  insertChangelogEntry,
  nextVersion,
  parseVersion,
  release,
} from "../scripts/release.ts";

describe("release versions", () => {
  test("parses canonical versions and rejects leading zeros or other shapes", () => {
    expect(parseVersion("0.1.0")).toEqual([0, 1, 0]);
    expect(parseVersion("10.20.30")).toEqual([10, 20, 30]);
    for (const value of ["0.1.00", "01.0.0", "1.2", "1.2.3-beta", "v1.2.3", "", 1, null]) {
      expect(() => parseVersion(value)).toThrow(ReleaseError);
    }
    expect(() => parseVersion("1.0.99999999999999999999")).toThrow(ReleaseError);
  });

  test("compares numerically, not as strings", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.0.1", "0.1.0")).toBe(-1);
    expect(compareVersions("2.0.0", "10.0.0")).toBe(-1);
  });

  test("bumps patch, minor, and major as before", () => {
    expect(nextVersion("0.1.0", "patch")).toBe("0.1.1");
    expect(nextVersion("0.1.9", "minor")).toBe("0.2.0");
    expect(nextVersion("0.9.3", "major")).toBe("1.0.0");
  });

  test("accepts only a higher explicit version", () => {
    expect(nextVersion("0.1.0", "0.1.1")).toBe("0.1.1");
    expect(nextVersion("0.9.0", "0.10.0")).toBe("0.10.0");
    expect(() => nextVersion("0.1.0", "0.0.1")).toThrow(
      "0.0.1 is not greater than the current version 0.1.0",
    );
    expect(() => nextVersion("0.1.0", "0.1.0")).toThrow(ReleaseError);
    expect(() => nextVersion("0.1.0", "0.1.00")).toThrow("without leading zeros");
    expect(() => nextVersion("0.1.0", "01.0.0")).toThrow(ReleaseError);
    expect(() => nextVersion("0.1.0", "next")).toThrow(ReleaseError);
  });
});

describe("CHANGELOG insertion", () => {
  const entry = changelogEntry("0.2.0", ["Add a thing"], "2026-10-10");

  test("puts the entry above the newest release after a preamble", () => {
    const current = "# Changelog\n\nIntro.\n\n## 0.1.0 - 2026-10-04\n\n- Old\n";
    expect(insertChangelogEntry(current, "0.2.0", entry)).toBe(
      `# Changelog\n\nIntro.\n\n${entry}\n## 0.1.0 - 2026-10-04\n\n- Old\n`,
    );
  });

  test("puts the entry at the top when the file starts with a release", () => {
    const current = "## 0.1.0 - 2026-10-04\n\n- Old\n\n## 0.0.6 - 2026-09-01\n\n- Older\n";
    const next = insertChangelogEntry(current, "0.2.0", entry);
    expect(next.startsWith(entry)).toBe(true);
    expect(next.indexOf("## 0.2.0")).toBeLessThan(next.indexOf("## 0.1.0"));
    expect(next.indexOf("## 0.1.0")).toBeLessThan(next.indexOf("## 0.0.6"));
  });

  test("appends after a preamble that has no releases yet", () => {
    expect(insertChangelogEntry("# Changelog\n\nIntro.\n", "0.2.0", entry)).toBe(
      `# Changelog\n\nIntro.\n\n${entry}`,
    );
  });

  test("refuses a version that already has an entry", () => {
    expect(() =>
      insertChangelogEntry("## 0.2.0 - 2026-10-01\n", "0.2.0", entry),
    ).toThrow("already has an entry for 0.2.0");
  });
});

describe("release()", () => {
  const CHANGELOG = "# Changelog\n\n## 0.1.0 - 2026-10-04\n\n- Old\n";
  let dir: string;
  let gitCalls: string[][];
  let tags: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "serve-emu-release-"));
    await writeFile(join(dir, "package.json"), `${JSON.stringify({ name: "x", version: "0.1.0" }, null, 2)}\n`);
    await writeFile(join(dir, "CHANGELOG.md"), CHANGELOG);
    gitCalls = [];
    tags = ["v0.1.0"];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function run(...args: string[]) {
    const lines: string[] = [];
    release(args, {
      packageDir: dir,
      log: (line) => lines.push(line),
      today: () => "2026-10-10",
      runGit: (gitArgs) => {
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "rev-parse") {
          return tags.includes(gitArgs.at(-1)!.replace("refs/tags/", "")) ? "sha" : null;
        }
        if (gitArgs[0] === "describe") return "v0.1.0";
        if (gitArgs[0] === "log") return "Fix a bug\nAdd a feature";
        return null;
      },
    });
    return lines;
  }

  async function files() {
    return {
      packageJson: await readFile(join(dir, "package.json"), "utf8"),
      changelog: await readFile(join(dir, "CHANGELOG.md"), "utf8"),
    };
  }

  test("writes the bumped version and a changelog entry from commit subjects", async () => {
    expect(run("minor")[0]).toBe("0.1.0 -> 0.2.0");
    const { packageJson, changelog } = await files();
    expect(JSON.parse(packageJson).version).toBe("0.2.0");
    expect(changelog).toBe(
      `# Changelog\n\n${changelogEntry("0.2.0", ["Fix a bug", "Add a feature"], "2026-10-10")}\n## 0.1.0 - 2026-10-04\n\n- Old\n`,
    );
    expect(gitCalls).toContainEqual(["log", "--format=%s", "--no-merges", "v0.1.0..HEAD"]);
  });

  test("changes no files on a dry run", async () => {
    const before = await files();
    expect(run("patch", "--dry-run")).toContain("\nDry run only. No files changed.");
    expect(await files()).toEqual(before);
  });

  test("rejects downgrades, repeats, non-canonical versions, and existing tags without writing", async () => {
    const before = await files();
    for (const version of ["0.0.1", "0.1.0", "0.1.00", "01.0.0"]) {
      expect(() => run(version)).toThrow(ReleaseError);
    }
    tags.push("v0.2.0");
    expect(() => run("0.2.0")).toThrow("Tag v0.2.0 already exists");
    expect(() => run()).toThrow("Usage:");
    expect(await files()).toEqual(before);
  });
});

describe("release CLI", () => {
  test("reports a rejected version as one line and exit 1", () => {
    const result = Bun.spawnSync(
      [process.execPath, new URL("../scripts/release.ts", import.meta.url).pathname, "0.0.0", "--dry-run"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toMatch(
      /^release: 0\.0\.0 is not greater than the current version \d+\.\d+\.\d+\n$/,
    );
  });
});
