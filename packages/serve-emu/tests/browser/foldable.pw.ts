import { test, expect } from "@playwright/test";

test("native posture controls show confirmed state and send replayable actions", async ({ page }) => {
  let posture = "unfolded";
  const changes: unknown[] = [];
  await page.route("**/api/foldable", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON(); changes.push(body); posture = body.posture;
    }
    await route.fulfill({ json: { ok: true, foldable: { supported: true, posture } } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Foldable", exact: true }).click();
  const panel = page.getByRole("region", { name: "Foldable controls" });
  await expect(panel.getByRole("status")).toHaveText("Unfolded");
  for (const [button, label] of [["Fold", "Folded"], ["Half-open", "Half-open"], ["Unfold", "Unfolded"]]) {
    await panel.getByRole("button", { name: button, exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText(label!);
    await expect(panel.getByRole("button", { name: button, exact: true })).toHaveAttribute("aria-pressed", "true");
  }
  expect(changes).toEqual([{ posture: "folded" }, { posture: "half-open" }, { posture: "unfolded" }]);
});

test("non-foldable devices show setup guidance and disabled controls", async ({ page }) => {
  await page.route("**/api/foldable", (route) => route.fulfill({ json: { ok: true, foldable: { supported: false, posture: "unknown", reason: "Create a Pixel Fold or Fold-in AVD to test folding." } } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Foldable", exact: true }).click();
  const panel = page.getByRole("region", { name: "Foldable controls" });
  await expect(panel).toContainText("Create a Pixel Fold");
  for (const name of ["Fold", "Half-open", "Unfold"]) await expect(panel.getByRole("button", { name, exact: true })).toBeDisabled();
});

test("native command errors remain visible after a state refresh", async ({ page }) => {
  await page.route("**/api/foldable", (route) => route.fulfill(route.request().method() === "POST"
    ? { status: 502, json: { ok: false, error: { code: "downstream_failure", message: "adb emu fold failed", reason: "emulator-failed" } } }
    : { json: { ok: true, foldable: { supported: true, posture: "unfolded" } } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Foldable", exact: true }).click();
  const panel = page.getByRole("region", { name: "Foldable controls" });
  await panel.getByRole("button", { name: "Fold", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("adb emu fold failed");
  await panel.getByRole("button", { name: "Refresh posture", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("Unfolded");
  await expect(panel.getByRole("alert")).toContainText("adb emu fold failed");
});

test("warns when Android changes posture but the display keeps its size", async ({ page }) => {
  let posture = "unfolded";
  await page.route("**/api/foldable", async (route) => {
    const post = route.request().method() === "POST";
    if (post) posture = route.request().postDataJSON().posture;
    await route.fulfill({ json: { ok: true, foldable: { supported: true, posture, ...(post ? { displayChanged: posture !== "folded" } : {}) } } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Foldable", exact: true }).click();
  const panel = page.getByRole("region", { name: "Foldable controls" });
  await panel.getByRole("button", { name: "Fold", exact: true }).click();
  await expect(panel.getByRole("note")).toContainText("Android reports folded, but the screen size did not change");
  await panel.getByRole("button", { name: "Refresh posture", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("Folded");
  await expect(panel.getByRole("note")).toBeVisible();
  await panel.getByRole("button", { name: "Unfold", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("Unfolded");
  await expect(panel.getByRole("note")).toHaveCount(0);
});
