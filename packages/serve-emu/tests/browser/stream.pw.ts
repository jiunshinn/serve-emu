import { test, expect, type Page, type Route } from "@playwright/test";

async function streaming(page: Page) {
  await expect(page.locator("header .meta")).toContainText("streaming");
  await expect(page.locator("header .meta")).toHaveAttribute(
    "title",
    /decode p95/,
  );
}

const runtimeErrors: string[] = [];
test.beforeEach(async ({ context }) => {
  runtimeErrors.length = 0;
  const watch = (page: Page) => {
    page.on("pageerror", error => runtimeErrors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error" && /VideoDecoder|decode failed|invalid frame|VideoFrame draw/.test(message.text())) runtimeErrors.push(message.text());
    });
  };
  context.pages().forEach(watch);
  context.on("page", watch);
});
test.afterEach(() => expect(runtimeErrors).toEqual([]));

test.beforeEach(async ({ request }) => {
  await request.post("/__test/control", { data: { clear: true } });
  const health = await (await request.get("/health")).json();
  const serial = health.serial === "device-a" ? "device-b" : "device-a";
  expect(
    (await request.post("/api/devices/select", { data: { serial } })).ok(),
  ).toBe(true);
});

/** The canvas's center pixel as [r, g, b, a]. */
async function centerColor(page: Page): Promise<number[]> {
  const screenshot = await page.locator("canvas").first().screenshot();
  return page.evaluate(
    async (bytes) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: "image/png" }),
      );
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      const color = [
        ...ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data,
      ];
      bitmap.close();
      return color;
    },
    [...screenshot],
  );
}

const isRed = ([r, g, b]: number[]) => r! > 200 && g! < 60 && b! < 60;
const isGreen = ([r, g, b]: number[]) => g! > 200 && r! < 60 && b! < 60;

async function encoderStats(request: import("@playwright/test").APIRequestContext) {
  const health = await (await request.get("/health")).json();
  const all = await (await request.get("/__test/encoder")).json();
  return all[health.serial] as {
    sessions: number;
    configs: number;
    keyframes: number;
    resetKeyframes: number;
    deltas: number;
  };
}

test("built worker decodes delta frames and presents pixels after refresh", async ({
  page,
}) => {
  // The GOP's IDR is red and the color only turns green in later P frames,
  // so seeing green proves delta frames decode, not just key frames.
  await page.goto("/");
  await streaming(page);
  await expect.poll(async () => isGreen(await centerColor(page)), { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => isRed(await centerColor(page)), { timeout: 10_000 }).toBe(true);
  await page.reload();
  await streaming(page);
  await expect.poll(async () => isGreen(await centerColor(page)), { timeout: 10_000 }).toBe(true);
});

test("a late-joining tab renders from the server's cached SPS/PPS", async ({
  page,
  context,
  request,
}) => {
  // Resets are ignored, so the encoder never resends its config: the only
  // way a second tab can decode is the cached config the server prepends to
  // the next periodic IDR.
  await request.post("/__test/control", {
    data: { encoder: { answerResets: false, keyframeIntervalFrames: 20 } },
  });
  await page.goto("/");
  await streaming(page);
  const configsBefore = (await encoderStats(request)).configs;
  const late = await context.newPage();
  await late.goto("/");
  await streaming(late);
  await expect.poll(async () => isRed(await centerColor(late)) || isGreen(await centerColor(late))).toBe(true);
  expect((await encoderStats(request)).configs).toBe(configsBefore);
});

test("another tab's device switch refreshes both device lists", async ({
  page,
  context,
  request,
}) => {
  await page.goto("/");
  const other = await context.newPage();
  await other.goto("/");
  await streaming(page);
  await streaming(other);
  const health = await (await request.get("/health")).json();
  const target = health.serial === "device-a" ? "device-b" : "device-a";
  await other
    .locator(".device-row")
    .filter({ has: other.locator(".device-name", { hasText: target }) })
    .locator(".device-row-main")
    .click();
  await streaming(other);
  await streaming(page);
  for (const tab of [page, other]) {
    await expect(tab.locator(".device-row.current")).toContainText(target);
  }
});

test("closing a tab during a drag releases only its input", async ({
  page,
  context,
  request,
}) => {
  await page.goto("/");
  const other = await context.newPage();
  await other.goto("/");
  await streaming(page);
  await streaming(other);
  const down = async (tab: Page) => {
    const box = await tab.locator("canvas").first().boundingBox();
    await tab.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await tab.mouse.down();
  };
  await down(page);
  await down(other);
  const downs = async () =>
    (await (await request.get("/__test/packets")).json()).packets.filter(
      (p: any) => p.type === 2 && p.action === 0,
    );
  await expect.poll(async () => (await downs()).length).toBe(2);
  const ids = (await downs()).map((p: any) => p.pointerId);
  expect(new Set(ids).size).toBe(2);
  await page.close();
  await expect
    .poll(
      async () =>
        (await (await request.get("/__test/packets")).json()).packets.filter(
          (p: any) => p.type === 2 && p.action === 1,
        ).length,
    )
    .toBe(1);
  await other.mouse.up();
  await expect
    .poll(
      async () =>
        (await (await request.get("/__test/packets")).json()).packets.filter(
          (p: any) => p.type === 2 && p.action === 1,
        ).length,
    )
    .toBe(2);
});

test("server input failures survive the worker-to-React boundary", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await streaming(page);
  await request.post("/__test/control", { data: { reject: true } });
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "injected device input failure",
  );
  await expect(page.locator("header .meta")).toContainText("streaming");
  await page.getByRole("button", { name: "Dismiss input error" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a slow decoder recovers by elapsed time with a shallow queue", async ({
  page,
  request,
}) => {
  // No periodic IDRs: every key frame after the first answers a reset, so a
  // recovery that ends can only have ended on a reset's key frame.
  await request.post("/__test/control", {
    data: { encoder: { keyframeIntervalFrames: 0 } },
  });
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        const next = new URL(url, location.href);
        if (options?.name === "stream-worker") next.searchParams.set("slow", "1");
        super(next, options);
      }
    };
  });
  await page.goto("/");
  await expect(page.locator("header .meta")).toHaveAttribute(
    "title",
    /recoveries [1-9]/,
  );
  const detail = await page.locator("header .meta").getAttribute("title");
  expect(Number(detail!.match(/decode queue (\d+)/)?.[1])).toBeLessThan(12);
  expect(Number(detail!.match(/pending (\d+)ms/)?.[1])).toBeGreaterThan(250);

  // Every recovery has to end on the key frame its reset produces. If a
  // coalesced request were never retried (#153), pending would keep growing.
  const pending: number[] = [];
  for (let second = 0; second < 6; second++) {
    await page.waitForTimeout(1_000);
    const title = await page.locator("header .meta").getAttribute("title");
    pending.push(Number(title?.match(/pending (\d+)ms/)?.[1] ?? 0));
  }
  expect(Math.max(...pending)).toBeLessThan(3_000);
  const stats = await encoderStats(request);
  expect(stats.resetKeyframes).toBeGreaterThanOrEqual(2);
  expect(stats.keyframes - stats.resetKeyframes).toBe(1);
  const health = await (await request.get("/health")).json();
  expect(health.videoResetRequests).toBeGreaterThan(1);
});

test("structured API errors render as text and keep the stream mounted", async ({
  page,
}) => {
  await page.route("**/api/orientation", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: { code: "not_found", message: "API route not found" },
      }),
    }),
  );
  await page.goto("/");
  await streaming(page);
  await page.getByRole("button", { name: "Orientation" }).click();
  await expect(page.locator(".orientation-panel .location-status")).toHaveText(
    "API route not found",
  );
  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(page.locator("header .meta")).toContainText("streaming");
});

test("a device switch keeps open tool sections open", async ({ page, request }) => {
  await page.goto("/");
  await streaming(page);
  const session = page.getByRole("button", { name: "Session", exact: true });
  const location = page.getByRole("button", { name: "Location", exact: true });
  await session.click();
  await location.click();
  await expect(session).toHaveAttribute("aria-expanded", "true");
  await expect(location).toHaveAttribute("aria-expanded", "true");

  const health = await (await request.get("/health")).json();
  const target = health.serial === "device-a" ? "device-b" : "device-a";
  await page
    .locator(".device-row")
    .filter({ has: page.locator(".device-name", { hasText: target }) })
    .locator(".device-row-main")
    .click();
  await expect(page.locator(".device-row.current")).toContainText(target);
  await streaming(page);

  await expect(session).toHaveAttribute("aria-expanded", "true");
  await expect(location).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".session-panel")).toBeVisible();
});

async function setPageHidden(page: Page, hidden: boolean) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (value ? "hidden" : "visible"),
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test("a hidden tab stops polling and refreshes as soon as it is visible again", async ({ page }) => {
  // Tall enough that every opened section is on screen (the Session section
  // also stops polling while scrolled out of view).
  await page.setViewportSize({ width: 1280, height: 2400 });
  const polled: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/health" || path.startsWith("/api/")) polled.push(path);
  });
  await page.goto("/");
  await streaming(page);
  // Network loads once when opened; Location and Session poll every second.
  for (const name of ["Network", "Location", "Session"]) {
    await page.getByRole("button", { name, exact: true }).click();
  }
  const pollers = ["/api/network", "/api/route", "/api/session", "/health"];
  await expect.poll(() => pollers.every((path) => polled.includes(path))).toBe(true);

  await setPageHidden(page, true);
  await page.waitForTimeout(300);
  polled.length = 0;
  await page.waitForTimeout(3_500);
  expect(polled).toEqual([]);

  // Becoming visible refreshes every poll at once, not a second later.
  await setPageHidden(page, false);
  await page.waitForTimeout(500);
  expect(pollers.filter((path) => !polled.includes(path))).toEqual([]);
});

test("a route error keeps its own line and leaves the location status alone", async ({ page, request }) => {
  await page.goto("/");
  await streaming(page);
  await page.getByRole("button", { name: "Location", exact: true }).click();
  // The fixture has no emulator, so applying the route's first fix fails.
  await request.post("/api/route", {
    data: { waypoints: [{ latitude: 37.5, longitude: 127 }, { latitude: 37.6, longitude: 127.1 }] },
  });
  const routeError = page.locator(".route-error");
  await expect(routeError).not.toBeEmpty();
  const panel = page.locator(".location-panel");
  await panel.getByLabel("Lat", { exact: true }).fill("not a number");
  await panel.getByRole("button", { name: "Set Location" }).click();
  const status = panel.locator(".panel-heading .location-status").first();
  await expect(status).toHaveText("Coordinates must be numbers");
  // Several route polls later, the status line still shows the user's result.
  await page.waitForTimeout(2_500);
  await expect(status).toHaveText("Coordinates must be numbers");
  await expect(routeError).not.toBeEmpty();
});

test("a device switch clears the previous session's route state at once", async ({ page, request }) => {
  await page.goto("/");
  await streaming(page);
  const locationToggle = page.getByRole("button", { name: "Location", exact: true });
  // Tool panels stay mounted across a switch (#96), so the section is still
  // open afterwards; reopening it only if needed keeps the test independent
  // of that.
  const openLocation = async () => {
    if ((await locationToggle.getAttribute("aria-expanded")) !== "true") await locationToggle.click();
  };
  await openLocation();
  const routeError = page.locator(".route-error");
  const routeLine = page.locator(".route-panel .location-status");
  const otherDevice = async () =>
    (await (await request.get("/health")).json()).serial === "device-a" ? "device-b" : "device-a";
  // The fixture has no emulator, so the route's first fix fails.
  const failRoute = async () => {
    await request.post("/api/route", {
      data: { waypoints: [{ latitude: 37.5, longitude: 127 }, { latitude: 37.6, longitude: 127.1 }] },
    });
    await expect(routeError).not.toBeEmpty();
  };
  // Hold every route poll, so only the session change can clear the old state.
  const held: Route[] = [];
  const holdRoutePolls = () => page.route("**/api/route", (route) => void held.push(route));
  const releaseRoutePolls = async () => {
    await page.unroute("**/api/route");
    await Promise.all(held.splice(0).map((route) => route.abort().catch(() => {})));
  };

  // Another client switches the device: /health settles on a new session.
  await failRoute();
  await holdRoutePolls();
  const switchedTo = await otherDevice();
  expect((await request.post("/api/devices/select", { data: { serial: switchedTo } })).ok()).toBe(true);
  await expect(page.locator(".device-row.current")).toContainText(switchedTo);
  await openLocation();
  await expect(routeError).toHaveCount(0);
  await expect(routeLine).toHaveText("idle 0%");
  await releaseRoutePolls();

  // This tab switches the device: the state clears as the switch starts.
  await failRoute();
  await holdRoutePolls();
  const target = await otherDevice();
  await page
    .locator(".device-row")
    .filter({ has: page.locator(".device-name", { hasText: target }) })
    .locator(".device-row-main")
    .click();
  await expect(page.locator(".device-row.current")).toContainText(target);
  await openLocation();
  await expect(routeError).toHaveCount(0);
  await expect(routeLine).toHaveText("idle 0%");
  await releaseRoutePolls();
});
