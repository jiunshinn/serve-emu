import { expect, test } from "bun:test";

// Deliberate CI failure probe for #116; never merged.
test("deliberately failing probe", () => {
  expect(1).toBe(2);
});
