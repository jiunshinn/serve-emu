import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { InvalidTokenError, TOKEN_CHARACTERS } from "../src/access-policy.ts";
// Importing must not parse the test runner's argv or start a server.
import { parseCliArgs, runCli } from "../src/cli.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

describe("cli", () => {
  let updateCheck: string | undefined;
  beforeEach(() => {
    updateCheck = process.env.SERVE_EMU_UPDATE_CHECK;
    process.env.SERVE_EMU_UPDATE_CHECK = "0";
  });
  afterEach(() => {
    if (updateCheck === undefined) delete process.env.SERVE_EMU_UPDATE_CHECK;
    else process.env.SERVE_EMU_UPDATE_CHECK = updateCheck;
  });

  test("parses flags with their defaults", () => {
    expect(parseCliArgs([])).toMatchObject({ port: "3300", gpu: "host" });
    expect(parseCliArgs(["-s", "emulator-5556", "--host", "0.0.0.0"])).toMatchObject({
      serial: "emulator-5556",
      host: "0.0.0.0",
    });
  });

  test.each([
    [["--bogus-flag"], "Unknown option '--bogus-flag'. Run 'serve-emu --help' for usage."],
    [["-p"], "Option '-p, --port <value>' argument missing. Run 'serve-emu --help' for usage."],
  ])("turns argument errors into one-line messages: %p", async (argv, message) => {
    await expect(runCli(argv)).rejects.toThrow(message);
  });

  test("documents the allowed token characters in --help", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await runCli(["--help"]);
      expect(log).toHaveBeenCalledTimes(1);
      const help = String(log.mock.calls[0]![0]);
      expect(help).toContain("--token <secret>");
      expect(help).toContain(`Allowed characters: ${TOKEN_CHARACTERS}.`);
    } finally {
      log.mockRestore();
    }
  });

  test("rejects an unsupported token before touching a device", async () => {
    await expect(runCli(["--token", "abc;def", "-s", "no-such-device"])).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  test("still validates flag combinations", async () => {
    await expect(runCli(["--emulator-port", "5560"])).rejects.toThrow(
      "--emulator-port and --restart-avd require --avd.",
    );
  });

  test.each([
    [["--bogus-flag"], "error: Unknown option '--bogus-flag'. Run 'serve-emu --help' for usage."],
    [["--token", "a+b", "--host", "0.0.0.0"], `error: --token may only contain ${TOKEN_CHARACTERS}.`],
  ])("as a process, %p exits 1 with one line and no stack trace", (argv, line) => {
    const run = Bun.spawnSync(["bun", CLI, ...argv], {
      env: { ...process.env, SERVE_EMU_UPDATE_CHECK: "0" },
    });
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toBe("");
    expect(run.stderr.toString()).toBe(`${line}\n`);
  });
});
