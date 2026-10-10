import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

const runtimeErrors: string[] = [];

test.beforeEach(async ({ context, request }) => {
  runtimeErrors.length = 0;
  const watch = (page: Page) => {
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && /VideoDecoder|decode failed|invalid frame|VideoFrame draw/.test(message.text())) {
        runtimeErrors.push(message.text());
      }
    });
  };
  context.pages().forEach(watch);
  context.on("page", watch);
  await request.post("/__test/control", { data: { clear: true, distinctColors: true } });
  expect((await request.post("/api/devices/select", { data: { serial: "device-a" } })).ok()).toBe(true);
});

test.afterEach(() => expect(runtimeErrors).toEqual([]));

function card(page: Page, serial: string) {
  return page.locator(`.device-preview-card[data-serial="${serial}"]`);
}

async function openOverview(page: Page) {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Device view", exact: true }).getByRole("button", { name: "All devices", exact: true }).click();
  await expect(page.locator(".device-overview")).toBeVisible();
  await previewsStreaming(page);
}

async function previewsStreaming(page: Page) {
  for (const serial of ["device-a", "device-b"]) {
    await expect(card(page, serial).locator(".device-preview-status")).toContainText("streaming");
    await expect(card(page, serial).locator("canvas")).toBeVisible();
  }
}

async function centerColor(page: Page, canvas: Locator) {
  const screenshot = await canvas.screenshot();
  return page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
    const sample = document.createElement("canvas");
    sample.width = bitmap.width;
    sample.height = bitmap.height;
    const context = sample.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const color = [...context.getImageData(sample.width / 2, sample.height / 2, 1, 1).data];
    bitmap.close();
    return color;
  }, [...screenshot]);
}

async function streams(request: APIRequestContext) {
  return (await (await request.get("/__test/streams")).json()) as {
    activeSessions: Record<string, number>;
    previewRequests: string[];
  };
}

async function inputPackets(request: APIRequestContext) {
  return ((await (await request.get("/__test/packets")).json()).packets as {
    serial: string;
    type: number;
    action: number;
  }[]).filter((packet) => packet.type !== 17);
}

test("overview renders separate live devices and leaves unavailable devices disconnected", async ({ page, request }) => {
  const healthRequests: string[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/health") healthRequests.push(req.url());
  });
  await page.goto("/?view=devices");
  await previewsStreaming(page);
  const red = await centerColor(page, card(page, "device-a").locator("canvas"));
  const blue = await centerColor(page, card(page, "device-b").locator("canvas"));
  expect(red[0]).toBeGreaterThan(240);
  expect(red[1]).toBeLessThan(40);
  expect(red[2]).toBeLessThan(40);
  expect(blue[0]).toBeLessThan(40);
  expect(blue[1]).toBeLessThan(40);
  expect(blue[2]).toBeGreaterThan(240);

  await expect(card(page, "device-offline")).toContainText("offline");
  await expect(card(page, "device-unauthorized")).toContainText("unauthorized");
  await expect(page.locator(".device-preview-card").filter({ hasText: "Stopped_Pixel" })).toContainText("stopped");
  for (const serial of ["device-offline", "device-unauthorized"]) {
    await expect(card(page, serial).locator("canvas")).toHaveCount(0);
    await expect(card(page, serial).getByRole("button", { name: `Control ${serial}`, exact: true })).toBeDisabled();
  }
  expect([...new Set((await streams(request)).previewRequests)].sort()).toEqual(["device-a", "device-b"]);

  expect(healthRequests).toEqual([]);
  expect((await (await request.get("/health")).json()).serial).toBe("device-a");
});

test("Control selects that device and releases overview streams", async ({ page, request }) => {
  await openOverview(page);
  const selected = page.waitForRequest((req) => req.url().endsWith("/api/devices/select") && req.method() === "POST");
  await page.getByRole("button", { name: "Control device-b", exact: true }).click();
  expect((await selected).postDataJSON()).toEqual({ serial: "device-b" });
  await expect(page.locator(".device-overview")).toHaveCount(0);
  await expect(page.locator("header .meta")).toContainText("streaming");
  await expect(page.locator(".device-row.current")).toContainText("device-b");
  await expect.poll(async () => (await streams(request)).activeSessions).toEqual({ "device-b": 1 });

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect.poll(async () => (await inputPackets(request)).filter((packet) => packet.type === 0).length).toBe(2);
  expect((await inputPackets(request)).every((packet) => packet.serial === "device-b")).toBe(true);
});

test("a failed Control keeps its error through refresh and allows retry", async ({ page }) => {
  await openOverview(page);
  await page.route("**/api/devices/select", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Device control is temporarily unavailable" }),
    });
  });
  await page.getByRole("button", { name: "Control device-b", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Device control is temporarily unavailable");
  const refreshed = page.waitForResponse((response) => response.url().endsWith("/api/device-grid") && response.ok());
  await page.getByRole("button", { name: "Refresh devices", exact: true }).click();
  await refreshed;
  await previewsStreaming(page);
  await expect(page.getByRole("alert")).toContainText("Device control is temporarily unavailable");

  await page.unroute("**/api/devices/select");
  await page.getByRole("button", { name: "Control device-b", exact: true }).click();
  await expect(page.locator(".device-overview")).toHaveCount(0);
  await expect(page.locator("header .meta")).toContainText("streaming");
  await expect(page.locator(".device-row.current")).toContainText("device-b");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a pending Control does not navigate a newly opened overview", async ({ page }) => {
  await openOverview(page);
  let acknowledgeSelection!: () => void;
  let releaseSelection!: () => void;
  const selectionIntercepted = new Promise<void>((resolve) => { acknowledgeSelection = resolve; });
  const selectionReleased = new Promise<void>((resolve) => { releaseSelection = resolve; });
  await page.route("**/api/devices/select", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    acknowledgeSelection();
    await selectionReleased;
    const response = await route.fetch();
    await route.fulfill({ response });
  });

  await page.getByRole("button", { name: "Control device-b", exact: true }).click();
  await selectionIntercepted;
  await page.getByRole("button", { name: "Single device", exact: true }).click();
  await expect(page.locator(".device-overview")).toHaveCount(0);
  await page.getByRole("navigation", { name: "Device view", exact: true }).getByRole("button", { name: "All devices", exact: true }).click();
  await expect(page.locator(".device-overview")).toBeVisible();

  const selectionCompleted = page.waitForResponse((response) => response.url().endsWith("/api/devices/select") && response.ok());
  releaseSelection();
  await selectionCompleted;
  await previewsStreaming(page);
  await expect(page.locator(".device-overview")).toBeVisible();
  await expect(page).toHaveURL(/\?view=devices$/);
  await expect(card(page, "device-b").locator(".device-preview-selected")).toBeVisible();
  for (const serial of ["device-a", "device-b"]) {
    await expect(card(page, serial).getByRole("button", { name: `Control ${serial}`, exact: true })).toBeEnabled();
  }
});

test("preview sessions survive another tab closing and recover after refresh", async ({ page, context, request }) => {
  await openOverview(page);
  const other = await context.newPage();
  await openOverview(other);
  const before = (await streams(request)).activeSessions;
  expect(before["device-b"]).toBe(1);
  await other.close();
  await previewsStreaming(page);
  expect((await streams(request)).activeSessions).toEqual(before);

  await page.reload();
  await expect(page.locator(".device-overview")).toBeVisible();
  await previewsStreaming(page);
  const blue = await centerColor(page, card(page, "device-b").locator("canvas"));
  expect(blue[2]).toBeGreaterThan(240);
  await page.getByRole("button", { name: "Single device", exact: true }).click();
  await expect.poll(async () => (await streams(request)).activeSessions).toEqual({ "device-a": 1 });
  await expect(page.locator("header .meta")).toContainText("streaming");
});

test("another tab can control a device while overview previews stay independent", async ({ page, context, request }) => {
  await openOverview(page);
  const other = await context.newPage();
  await openOverview(other);
  await other.getByRole("button", { name: "Control device-b", exact: true }).click();
  await expect(other.locator("header .meta")).toContainText("streaming");
  await expect(card(page, "device-b").locator(".device-preview-selected")).toBeVisible();
  await previewsStreaming(page);
  const red = await centerColor(page, card(page, "device-a").locator("canvas"));
  const blue = await centerColor(page, card(page, "device-b").locator("canvas"));
  expect(red[0]).toBeGreaterThan(240);
  expect(blue[2]).toBeGreaterThan(240);
  expect((await (await request.get("/health")).json()).serial).toBe("device-b");
  await page.close();
  await expect.poll(async () => (await streams(request)).activeSessions).toEqual({ "device-b": 1 });
  await expect(other.locator("header .meta")).toContainText("streaming");
});

test("switching views releases the old decoding workers", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const active = new Set<Worker>();
    Object.defineProperty(window, "__liveStreamWorkers", { get: () => active.size });
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (String(url).includes("stream-worker-")) active.add(this);
      }

      override terminate() {
        active.delete(this);
        super.terminate();
      }
    };
  });
  await openOverview(page);
  const workers = () => page.evaluate(() => (window as unknown as { __liveStreamWorkers: number }).__liveStreamWorkers);
  for (let cycle = 0; cycle < 3; cycle++) {
    await expect.poll(workers).toBe(2);
    await page.getByRole("button", { name: "Single device", exact: true }).click();
    await expect(page.locator("header .meta")).toContainText("streaming");
    await expect.poll(workers).toBe(1);
    await page.getByRole("navigation", { name: "Device view", exact: true }).getByRole("button", { name: "All devices", exact: true }).click();
    await previewsStreaming(page);
  }
  await expect.poll(workers).toBe(2);
});
