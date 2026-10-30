import { test, expect, type Page } from "@playwright/test";

async function openPanel(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Push & Deep Links", exact: true }).click();
  return page.getByRole("region", { name: "Push and deep link controls" });
}

test("sends a push with a deep link and data, and opens the link in the app", async ({ page }) => {
  const pushes: unknown[] = [];
  const links: unknown[] = [];
  await page.route("**/api/apps/push", async (route) => {
    pushes.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, output: "Delivered notification message serve-emu-1 to com.example.app", messageId: "serve-emu-1" } });
  });
  await page.route("**/api/deep-link", async (route) => {
    links.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, output: "Starting: Intent { act=android.intent.action.VIEW }\nStatus: ok\nActivity: com.example.app/.LinkActivity\nComplete" } });
  });
  await page.route("**/api/foreground", (route) =>
    route.fulfill({ json: { ok: true, app: { packageName: "com.example.app", activity: ".Main", pid: 1, label: null, versionName: null, versionCode: null, debuggable: null } } }));

  const panel = await openPanel(page);
  await panel.getByRole("button", { name: "Foreground", exact: true }).click();
  await expect(panel.getByLabel("Package")).toHaveValue("com.example.app");
  await panel.getByLabel("Title").fill("Order shipped");
  await panel.getByLabel("Body").fill("Tap to\ntrack it");
  await panel.getByLabel("Deep link").fill(" myapp://orders/42 ");
  await panel.getByLabel("Data (key=value per line)").fill("orderId=42\n\nnote=a=b");
  await panel.getByRole("button", { name: "Send Push", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("Delivered notification message serve-emu-1 to com.example.app");
  await panel.getByRole("button", { name: "Open Link", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("Opened com.example.app/.LinkActivity");

  expect(pushes).toEqual([{
    packageName: "com.example.app",
    title: "Order shipped",
    body: "Tap to\ntrack it",
    link: "myapp://orders/42",
    data: { orderId: "42", note: "a=b" },
  }]);
  expect(links).toEqual([{ url: "myapp://orders/42", packageName: "com.example.app" }]);
});

test("shows server errors and malformed data lines in the status", async ({ page }) => {
  let pushes = 0;
  await page.route("**/api/apps/push", async (route) => {
    pushes++;
    await route.fulfill({ status: 400, json: { ok: false, error: { code: "invalid_request", message: "a simulated push needs root: use an emulator with a Google APIs system image, not Google Play", reason: "push-root-unavailable" } } });
  });

  const panel = await openPanel(page);
  await panel.getByLabel("Package").fill("com.example.app");
  await panel.getByLabel("Data (key=value per line)").fill("orderId");
  await panel.getByRole("button", { name: "Send Push", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText('Data line "orderId" needs key=value');
  expect(pushes).toBe(0);

  await panel.getByLabel("Data (key=value per line)").fill("orderId=42");
  await panel.getByRole("button", { name: "Send Push", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Google APIs system image");
  expect(pushes).toBe(1);
});
