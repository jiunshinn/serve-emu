import { expect, mock, test } from "bun:test";
import * as realOs from "node:os";
import { join } from "node:path";

test("importing update-check does not resolve the home directory", async () => {
  // Captured first: once mocked, the `realOs` namespace sees the mock too.
  const homedir = realOs.homedir;
  const home = homedir();
  let calls = 0;
  // Delegates to the real homedir: module mocks stay installed for the rest
  // of the process, so this must not change behaviour for other tests.
  mock.module("node:os", () => ({
    ...realOs,
    homedir: () => {
      calls++;
      return homedir();
    },
  }));
  // The query string forces a fresh evaluation that sees the mock.
  const specifier: string = "../src/update-check.ts?lazy-home";
  const updateCheck = (await import(specifier)) as typeof import("../src/update-check.ts");
  expect(calls).toBe(0);

  expect(updateCheck.defaultUpdateCachePath()).toBe(
    join(home, ".cache", "serve-emu", "update-check.json"),
  );
  expect(calls).toBe(1);
});
