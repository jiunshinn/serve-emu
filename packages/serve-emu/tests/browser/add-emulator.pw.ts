import { test, expect } from "@playwright/test";

const image = "system-images;android-35;google_apis;arm64-v8a";
const catalog = {
  ok: true,
  profiles: [
    { id: "pixel_fold", name: "Pixel Fold", manufacturer: "Google", foldable: true },
    { id: "7.6in Foldable", name: '7.6" Fold-in with outer display', manufacturer: "Generic", foldable: true },
    { id: "pixel_8", name: "Pixel 8", manufacturer: "Google", foldable: false },
  ],
  images: [{ id: image, name: "Android 35 Google APIs", abi: "arm64-v8a" }],
};

test("creates a foldable from the Devices panel, refreshes the grid, and preserves the session", async ({ page }) => {
  let created = false;
  let submitted: unknown;
  let selections = 0;
  page.on("request", (req) => { if (req.url().endsWith("/api/devices/select")) selections++; });
  await page.route("**/api/avds/catalog", (route) => route.fulfill({ json: catalog }));
  await page.route("**/api/avds/create", async (route) => {
    submitted = route.request().postDataJSON();
    created = true;
    await route.fulfill({ status: 201, json: { ok: true, avd: "My_Fold" } });
  });
  await page.route("**/api/device-grid", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (created) json.devices.push({ id: "avd:My_Fold", name: "My_Fold", kind: "avd", avd: "My_Fold", serial: null, state: "stopped", current: false, canStart: true, canSelect: false, canStop: false });
    await route.fulfill({ json });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Add emulator", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add emulator" });
  await expect(dialog.getByLabel("Hardware profile")).toHaveValue("pixel_fold");
  await expect(dialog.getByLabel("Emulator name")).toBeFocused();
  await dialog.getByLabel("Emulator name").fill("My_Fold");
  await dialog.getByLabel("Hardware profile").selectOption("7.6in Foldable");
  await dialog.getByRole("button", { name: "Create emulator", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".device-row").filter({ hasText: "My_Fold" })).toBeVisible();
  expect(submitted).toEqual({ name: "My_Fold", profile: "7.6in Foldable", image });
  expect(selections).toBe(0);
  await expect(page.getByRole("button", { name: "Add emulator", exact: true })).toBeFocused();
});

for (const structured of [false, true]) {
test(`missing tools can be retried (${structured ? "structured" : "legacy"} error); Escape returns focus`, async ({ page }) => {
  let retry = false;
  await page.route("**/api/avds/catalog", (route) => route.fulfill(retry
    ? { json: { ...catalog, images: [] } }
    : { status: 503, json: { ok: false, error: structured ? { code: "service_unavailable", message: "Install Android SDK Command-line Tools" } : "Install Android SDK Command-line Tools" } }));
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Add emulator", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("Install Android SDK");
  retry = true;
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await dialog.getByLabel("Emulator name").fill("Test_Fold");
  await expect(dialog.getByRole("button", { name: "Create emulator", exact: true })).toBeDisabled();
  await expect(dialog).toContainText("No compatible images installed");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

}

for (const structured of [false, true]) {
test(`creation error retains input and prevents duplicate submission (${structured ? "structured" : "legacy"})`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/avds/catalog", (route) => route.fulfill({ json: catalog }));
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/avds/create", async (route) => {
    calls++;
    await pending;
    await route.fulfill({ status: 409, json: { ok: false, error: structured ? { code: "conflict", message: "An emulator named My_Fold already exists." } : "An emulator named My_Fold already exists." } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Add emulator", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Emulator name").fill("My_Fold");
  await dialog.getByRole("button", { name: "Create emulator", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Creating…", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  release();
  await expect(dialog.getByRole("alert")).toContainText("already exists");
  await expect(dialog.getByLabel("Emulator name")).toHaveValue("My_Fold");
  expect(calls).toBe(1);
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});

}

test("older server gives restart guidance instead of object coercion", async ({ page }) => {
  await page.route("**/api/avds/catalog", (route) => route.fulfill({ status: 404, json: { ok: false, error: { code: "not_found", message: "API route not found" } } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Add emulator", exact: true }).click();
  const alert = page.getByRole("dialog").getByRole("alert");
  await expect(alert).toContainText("Restart serve-emu from the updated project");
  await expect(alert).not.toContainText("[object Object]");
});
