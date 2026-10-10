import { expect, test } from "@playwright/test";
import { FIXTURE_TOKEN, TOKEN_FIXTURE_PORT } from "./fixture-env.ts";

const base = `http://127.0.0.1:${TOKEN_FIXTURE_PORT}`;

test("a ?token= link becomes a session cookie and streams over it", async ({ page, request }) => {
  expect((await request.get(`${base}/health`)).status()).toBe(401);

  await page.goto(`${base}/?token=${FIXTURE_TOKEN}`);
  // The token is swapped for an HttpOnly cookie and dropped from the URL.
  await expect(page).toHaveURL(`${base}/`);
  const cookies = await page.context().cookies(base);
  expect(cookies).toContainEqual(
    expect.objectContaining({ name: "semu_session", value: FIXTURE_TOKEN, httpOnly: true, sameSite: "Strict" }),
  );

  // The UI's /health polls and its WebSocket upgrade authenticate with the cookie.
  await expect(page.locator("header .meta")).toContainText("streaming");
  await expect(page.locator("header .meta")).toHaveAttribute("title", /decode p95/);
  const health = await page.evaluate(async () => (await fetch("/health")).status);
  expect(health).toBe(200);
});

test("without the token the UI cannot stream", async ({ page }) => {
  const response = await page.goto(`${base}/`);
  expect(response?.status()).toBe(401);
});
