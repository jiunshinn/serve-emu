import { test, expect, type Page } from "@playwright/test";

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

test("built worker decodes H.264 and presents pixels after refresh", async ({
  page,
}) => {
  await page.goto("/");
  await streaming(page);
  const screenshot = await page.locator("canvas").first().screenshot();
  const rgb = await page.evaluate(
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
  expect(rgb[0]).toBeGreaterThan(240);
  expect(rgb[1]).toBeLessThan(40);
  expect(rgb[2]).toBeLessThan(40);
  await page.reload();
  await streaming(page);
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
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        const next = new URL(url, location.href);
        if (next.pathname.includes("stream-worker-"))
          next.searchParams.set("slow", "1");
        super(next, options);
      }
    };
  });
  await page.goto("/");
  await expect(page.locator("header .meta")).toHaveAttribute(
    "title",
    /recoveries [1-9]/,
  );
  const health = await (await request.get("/health")).json();
  expect(health.videoResetRequests).toBeGreaterThan(1);
  const detail = await page.locator("header .meta").getAttribute("title");
  expect(Number(detail!.match(/decode queue (\d+)/)?.[1])).toBeLessThan(12);
  expect(Number(detail!.match(/pending (\d+)ms/)?.[1])).toBeGreaterThan(250);
});
