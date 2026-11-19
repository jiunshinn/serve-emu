import { describe, expect, test } from "bun:test";
import { shellQuote } from "../src/shell-quote.ts";

// adb joins `shell` words with spaces and the device runs them through
// `sh -c`; a POSIX sh here interprets the quoted word the same way.
function throughShell(word: string): string {
  const run = Bun.spawnSync(["sh", "-c", `printf %s ${word}`]);
  expect(run.exitCode).toBe(0);
  return run.stdout.toString();
}

describe("shellQuote", () => {
  test.each([
    ".Settings$WifiSettingsActivity",
    "com.android.settings/.Settings$WifiSettingsActivity",
    "it's",
    "'",
    "a b  c",
    "*",
    "$(id)`id`;|&<>",
    "",
  ])("passes %p through sh -c unchanged", (value) => {
    expect(throughShell(shellQuote(value))).toBe(value);
  });

  test("shows why quoting is needed", () => {
    expect(throughShell(".Settings$WifiSettingsActivity")).toBe(".Settings");
  });

  test("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("")).toBe("''");
  });
});
