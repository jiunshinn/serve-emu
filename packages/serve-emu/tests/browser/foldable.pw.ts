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
    ? { status: 400, json: { ok: false, error: "KO: Failed to set posture" } }
    : { json: { ok: true, foldable: { supported: true, posture: "unfolded" } } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Foldable", exact: true }).click();
  const panel = page.getByRole("region", { name: "Foldable controls" });
  await panel.getByRole("button", { name: "Fold", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Failed to set posture");
  await panel.getByRole("button", { name: "Refresh posture", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("Unfolded");
  await expect(panel.getByRole("alert")).toContainText("Failed to set posture");
});
