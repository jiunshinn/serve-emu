import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

type Packet = {
  serial: string;
  type: number;
  action: number;
  pointerId: string | null;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  keycode: number | null;
  text: string | null;
};

const runtimeErrors: string[] = [];

test.beforeEach(async ({ context, request }) => {
  runtimeErrors.length = 0;
  const watch = (page: Page) => page.on("pageerror", (error) => runtimeErrors.push(error.message));
  context.pages().forEach(watch);
  context.on("page", watch);
  await resetPackets(request);
  expect((await request.post("/api/devices/select", { data: { serial: "device-a" } })).ok()).toBe(true);
});

test.afterEach(() => expect(runtimeErrors).toEqual([]));

async function resetPackets(request: APIRequestContext, rejectSerials: string[] = [], accessibilityMode = "normal") {
  await request.post("/__test/control", {
    data: { clear: true, distinctColors: true, differentSizes: true, rejectSerials, accessibilityMode },
  });
}

async function packets(request: APIRequestContext) {
  return ((await (await request.get("/__test/packets")).json()).packets as Packet[])
    .filter((packet) => packet.type !== 17);
}

async function touches(request: APIRequestContext, action?: number) {
  return (await packets(request)).filter((packet) => packet.type === 2 && (action === undefined || packet.action === action));
}

function card(page: Page, serial: string) {
  return page.locator(`.device-preview-card[data-serial="${serial}"]`);
}

async function openOverview(page: Page) {
  await page.goto("/?view=devices");
  for (const serial of ["device-a", "device-b"]) {
    await expect(card(page, serial).locator(".device-preview-status")).toContainText("streaming");
  }
  await expect(card(page, "device-b").locator(".device-preview-status")).toContainText("128 × 96");
}

async function targetMode(page: Page, name: "This device" | "All devices" | "Selected devices") {
  await page.getByRole("group", { name: "Input targets", exact: true }).getByRole("button", { name, exact: true }).click();
}

async function tapMapping(page: Page, name: "Match elements" | "Screen positions") {
  await page.getByRole("group", { name: "Tap mapping", exact: true }).getByRole("button", { name, exact: true }).click();
}

async function point(page: Page, serial: string, x: number, y: number) {
  const canvas = card(page, serial).locator("canvas");
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error(`No visible canvas for ${serial}`);
  const image = await canvas.evaluate((element: HTMLCanvasElement) => ({
    width: element.width,
    height: element.height,
    contained: getComputedStyle(element).objectFit === "contain",
  }));
  const scale = Math.min(box.width / image.width, box.height / image.height);
  const width = image.contained ? image.width * scale : box.width;
  const height = image.contained ? image.height * scale : box.height;
  return {
    x: box.x + (box.width - width) / 2 + width * x,
    y: box.y + (box.height - height) / 2 + height * y,
  };
}

async function tap(page: Page, serial: string, x: number, y: number) {
  const position = await point(page, serial, x, y);
  await page.mouse.click(position.x, position.y);
}

function expectPosition(packet: Packet, serial: string, x: number, y: number) {
  const width = serial === "device-a" ? 64 : 128;
  const height = serial === "device-a" ? 64 : 96;
  expect(packet.width).toBe(width);
  expect(packet.height).toBe(height);
  expect(Math.abs(packet.x! - width * x)).toBeLessThanOrEqual(1);
  expect(Math.abs(packet.y! - height * y)).toBeLessThanOrEqual(1);
}

test("grouped taps match the same element at different positions and display resolutions", async ({ page, request }) => {
  await openOverview(page);
  await targetMode(page, "All devices");
  await expect(page.getByRole("group", { name: "Tap mapping", exact: true }).getByRole("button", { name: "Match elements", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Home", exact: true })).toBeEnabled();
  const matched = page.waitForResponse((response) => response.url().endsWith("/api/devices/tap-element"));
  await tap(page, "device-a", 0.25, 0.75);
  const response = await matched;
  expect(response.status()).toBe(200);
  expect((await response.json()).element.resourceId).toBe("com.qa:id/nav_search");
  await expect.poll(async () => (await touches(request, 1)).length).toBe(2);
  for (const serial of ["device-a", "device-b"]) {
    const input = (await touches(request)).filter((packet) => packet.serial === serial);
    expect(input.map((packet) => packet.action)).toEqual([0, 1]);
    input.forEach((packet) => expectPosition(packet, serial, serial === "device-a" ? 0.25 : 0.75, serial === "device-a" ? 0.75 : 0.25));
  }

  // Some navigation controls expose only a unique accessible name.
  await resetPackets(request);
  await expect(page.getByRole("button", { name: "Home", exact: true })).toBeEnabled();
  const homeMatched = page.waitForResponse((result) => result.url().endsWith("/api/devices/tap-element"));
  await tap(page, "device-a", 0.75, 0.25);
  const homeResponse = await homeMatched;
  expect(homeResponse.status()).toBe(200);
  expect((await homeResponse.json()).element).toMatchObject({ text: "Home", resourceId: "" });
  await expect.poll(async () => (await touches(request, 1)).length).toBe(2);
  for (const serial of ["device-a", "device-b"]) {
    const input = (await touches(request)).filter((packet) => packet.serial === serial);
    input.forEach((packet) => expectPosition(packet, serial, serial === "device-a" ? 0.75 : 0.25, serial === "device-a" ? 0.25 : 0.75));
  }
});

test("matched taps affect only checked devices and may exclude the source", async ({ page, request }) => {
  await openOverview(page);
  await targetMode(page, "Selected devices");
  await page.getByRole("checkbox", { name: "Target device-b", exact: true }).check();
  await page.getByRole("checkbox", { name: "Target device-a", exact: true }).uncheck();
  await expect(page.getByRole("button", { name: "Home", exact: true })).toBeEnabled();
  await tap(page, "device-a", 0.25, 0.75);
  await expect.poll(async () => (await touches(request, 1)).length).toBe(1);
  const input = await touches(request);
  expect(input.map((packet) => packet.serial)).toEqual(["device-b", "device-b"]);
  input.forEach((packet) => expectPosition(packet, "device-b", 0.75, 0.25));
});

for (const mode of ["missing", "ambiguous"] as const) {
  test(`a fresh ${mode} element match rejects every target without coordinate fallback`, async ({ page, request }) => {
    await openOverview(page);
    await targetMode(page, "All devices");
    await expect(page.getByRole("button", { name: "Home", exact: true })).toBeEnabled();
    await tap(page, "device-a", 0.25, 0.75);
    await expect.poll(async () => (await touches(request, 1)).length).toBe(2);
    await resetPackets(request, [], mode);
    await expect(page.getByRole("button", { name: "Home", exact: true })).toBeEnabled();
    const matched = page.waitForResponse((response) => response.url().endsWith("/api/devices/tap-element"));
    await tap(page, "device-a", 0.25, 0.75);
    const response = await matched;
    expect(response.status()).toBe(409);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.results.every((result: { ok: boolean }) => !result.ok)).toBe(true);
    await expect(page.getByRole("alert")).toContainText("device-b");
    expect(await touches(request)).toEqual([]);
    const loads = (await (await request.get("/__test/streams")).json()).accessibilityLoads as string[];
    expect([...new Set(loads)].sort()).toEqual(["device-a", "device-b"]);
  });
}

test("a pending element match does not admit a second tap", async ({ page, request }) => {
  await openOverview(page);
  await targetMode(page, "All devices");
  await expect(page.getByRole("button", { name: "Home", exact: true })).toBeEnabled();
  let acknowledgeRequest!: () => void;
  let releaseRequest!: () => void;
  const intercepted = new Promise<void>((resolve) => { acknowledgeRequest = resolve; });
  const released = new Promise<void>((resolve) => { releaseRequest = resolve; });
  let requests = 0;
  await page.route("**/api/devices/tap-element", async (route) => {
    requests += 1;
    acknowledgeRequest();
    await released;
    await route.fulfill({ response: await route.fetch() });
  });
  await tap(page, "device-a", 0.25, 0.75);
  await intercepted;
  await expect(card(page, "device-a").locator(".device-preview-screen")).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("button", { name: "Home", exact: true })).toBeDisabled();
  await tap(page, "device-a", 0.25, 0.75);
  expect(await touches(request)).toEqual([]);
  const completed = page.waitForResponse((response) => response.url().endsWith("/api/devices/tap-element"));
  releaseRequest();
  expect((await completed).status()).toBe(200);
  await expect.poll(async () => (await touches(request, 1)).length).toBe(2);
  expect(requests).toBe(1);
});

test("swipes remain position based while element matching is enabled", async ({ page, request }) => {
  await openOverview(page);
  await targetMode(page, "All devices");
  await expect(page.getByRole("button", { name: "Home", exact: true })).toBeEnabled();
  const matchingRequests: string[] = [];
  page.on("request", (req) => { if (req.url().endsWith("/api/devices/tap-element")) matchingRequests.push(req.url()); });
  const from = await point(page, "device-a", 0.2, 0.25);
  const to = await point(page, "device-a", 0.8, 0.75);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await touches(request, 1)).length).toBe(2);
  for (const serial of ["device-a", "device-b"]) {
    const input = (await touches(request)).filter((packet) => packet.serial === serial);
    expectPosition(input[0]!, serial, 0.2, 0.25);
    expectPosition(input.at(-1)!, serial, 0.8, 0.75);
    expect(input.some((packet) => packet.action === 2)).toBe(true);
  }
  expect(matchingRequests).toEqual([]);
});

test("an older server keeps input disabled and asks to restart", async ({ page, request }) => {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        const target = new URL(url, location.href);
        // Older servers ignored these flags and accepted controller connections
        // as read-only previews: video-session arrives, control-ready never does.
        if (target.searchParams.get("control") === "1") {
          target.searchParams.delete("control");
          target.searchParams.delete("video");
        }
        super(target, protocols);
      }
    };
  });
  await openOverview(page);
  await targetMode(page, "All devices");
  await expect(page.getByRole("button", { name: "Home", exact: true })).toBeDisabled();
  await page.getByRole("textbox", { name: "Text to send", exact: true }).fill("must not reach a device");
  await expect(page.getByRole("button", { name: "Send text", exact: true })).toBeDisabled();
  await tap(page, "device-b", 0.75, 0.25);
  await expect(page.getByRole("alert")).toContainText("Restart serve-emu and refresh this page.");
  await expect(page.getByRole("button", { name: "Home", exact: true })).toBeDisabled();
  expect(await packets(request)).toEqual([]);
  for (const serial of ["device-a", "device-b"]) {
    await expect(card(page, serial).locator(".device-preview-status")).toContainText("streaming");
  }
});

test("This device sends input only to the touched device without changing the selected session", async ({ page, request }) => {
  await openOverview(page);
  await expect(page.getByRole("group", { name: "Input targets", exact: true }).getByRole("button", { name: "This device", exact: true })).toHaveAttribute("aria-pressed", "true");
  await tap(page, "device-b", 0.25, 0.75);
  await expect.poll(async () => (await touches(request, 1)).length).toBe(1);
  let input = await touches(request);
  expect(input.map((packet) => packet.serial)).toEqual(["device-b", "device-b"]);
  input.forEach((packet) => expectPosition(packet, "device-b", 0.25, 0.75));
  expect((await (await request.get("/health")).json()).serial).toBe("device-a");

  await resetPackets(request);
  await tap(page, "device-a", 0.75, 0.25);
  await expect.poll(async () => (await touches(request, 1)).length).toBe(1);
  input = await touches(request);
  expect(input.map((packet) => packet.serial)).toEqual(["device-a", "device-a"]);
  input.forEach((packet) => expectPosition(packet, "device-a", 0.75, 0.25));
});

test("All devices broadcasts normalized taps and swipes to different screen sizes", async ({ page, request }) => {
  await openOverview(page);
  await targetMode(page, "All devices");
  await tapMapping(page, "Screen positions");
  await tap(page, "device-a", 0.25, 0.25);
  await expect.poll(async () => (await touches(request, 1)).length).toBe(2);
  for (const serial of ["device-a", "device-b"]) {
    const input = (await touches(request)).filter((packet) => packet.serial === serial);
    expect(input.map((packet) => packet.action)).toEqual([0, 1]);
    input.forEach((packet) => expectPosition(packet, serial, 0.25, 0.25));
  }

  await resetPackets(request);
  const from = await point(page, "device-a", 0.2, 0.25);
  const to = await point(page, "device-a", 0.8, 0.75);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await touches(request, 1)).length).toBe(2);
  for (const serial of ["device-a", "device-b"]) {
    const input = (await touches(request)).filter((packet) => packet.serial === serial);
    expect(input[0]!.action).toBe(0);
    expect(input.at(-1)!.action).toBe(1);
    expect(input.some((packet) => packet.action === 2)).toBe(true);
    expectPosition(input[0]!, serial, 0.2, 0.25);
    expectPosition(input.at(-1)!, serial, 0.8, 0.75);
  }
});

test("All devices sends text and hardware keys to every ready device", async ({ page, request }) => {
  await openOverview(page);
  await targetMode(page, "All devices");
  await page.getByRole("textbox", { name: "Text to send", exact: true }).fill("QA 동기화 42");
  await page.getByRole("button", { name: "Send text", exact: true }).click();
  await expect.poll(async () => (await packets(request)).filter((packet) => packet.type === 1).length).toBe(2);
  const texts = (await packets(request)).filter((packet) => packet.type === 1);
  expect(texts.map((packet) => packet.serial).sort()).toEqual(["device-a", "device-b"]);
  expect(texts.every((packet) => packet.text === "QA 동기화 42")).toBe(true);

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect.poll(async () => (await packets(request)).filter((packet) => packet.type === 0).length).toBe(4);
  for (const serial of ["device-a", "device-b"]) {
    const keys = (await packets(request)).filter((packet) => packet.serial === serial && packet.type === 0);
    expect(keys.map((packet) => [packet.keycode, packet.action])).toEqual([[3, 0], [3, 1]]);
  }
});

test("typing and navigation keys follow the touched screen's broadcast targets", async ({ page, request }) => {
  await openOverview(page);
  await targetMode(page, "All devices");
  await tapMapping(page, "Screen positions");
  await tap(page, "device-b", 0.5, 0.5);
  await expect.poll(async () => (await touches(request, 1)).length).toBe(2);
  await resetPackets(request);
  await page.keyboard.type("qa");
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await packets(request)).filter((packet) => packet.type === 0).length).toBe(4);
  for (const serial of ["device-a", "device-b"]) {
    const input = (await packets(request)).filter((packet) => packet.serial === serial);
    expect(input.filter((packet) => packet.type === 1).map((packet) => packet.text).join("")).toBe("qa");
    expect(input.filter((packet) => packet.type === 0).map((packet) => [packet.keycode, packet.action])).toEqual([[20, 0], [20, 1]]);
  }
});

test("Selected devices excludes unchecked devices even when they are the gesture source", async ({ page, request }) => {
  await openOverview(page);
  await targetMode(page, "Selected devices");
  await tapMapping(page, "Screen positions");
  await page.getByRole("checkbox", { name: "Target device-a", exact: true }).check();
  await page.getByRole("checkbox", { name: "Target device-b", exact: true }).uncheck();
  await tap(page, "device-b", 0.5, 0.75);
  await expect.poll(async () => (await touches(request, 1)).length).toBe(1);
  const input = await touches(request);
  expect(input.map((packet) => packet.serial)).toEqual(["device-a", "device-a"]);
  input.forEach((packet) => expectPosition(packet, "device-a", 0.5, 0.75));

  await page.getByRole("textbox", { name: "Text to send", exact: true }).fill("selected only");
  await page.getByRole("button", { name: "Send text", exact: true }).click();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect.poll(async () => (await packets(request)).filter((packet) => packet.type === 0).length).toBe(2);
  expect((await packets(request)).every((packet) => packet.serial === "device-a")).toBe(true);
  expect((await packets(request)).filter((packet) => packet.type === 1).map((packet) => packet.text)).toEqual(["selected only"]);
});

test("All and Selected modes retain targets on other device pages", async ({ page, request }) => {
  await request.post("/__test/control", {
    data: { clear: true, distinctColors: true, differentSizes: true, extraDevices: true },
  });
  await openOverview(page);
  await targetMode(page, "All devices");
  await expect(card(page, "device-extra-7")).toHaveCount(0);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect.poll(async () => (await packets(request)).filter((packet) => packet.type === 0).length).toBe(18);
  expect([...new Set((await packets(request)).filter((packet) => packet.type === 0).map((packet) => packet.serial))].sort()).toEqual([
    "device-a", "device-b", ...Array.from({ length: 7 }, (_, index) => `device-extra-${index + 1}`),
  ]);

  await targetMode(page, "Selected devices");
  await page.getByRole("navigation", { name: "Device pages", exact: true }).getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("checkbox", { name: "Target device-extra-7", exact: true }).check();
  await page.getByRole("navigation", { name: "Device pages", exact: true }).getByRole("button", { name: "Previous", exact: true }).click();
  await expect(card(page, "device-extra-7")).toHaveCount(0);
  await request.post("/__test/control", {
    data: { clear: true, distinctColors: true, differentSizes: true, extraDevices: true },
  });
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect.poll(async () => (await packets(request)).filter((packet) => packet.type === 0).length).toBe(2);
  expect((await packets(request)).every((packet) => packet.serial === "device-extra-7")).toBe(true);
});

test("a failed target reports its device while other targets still receive input", async ({ page, request }) => {
  await openOverview(page);
  await targetMode(page, "All devices");
  await resetPackets(request, ["device-b"]);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("device-b");
  await expect(page.getByRole("alert")).toContainText("injected device input failure");
  await expect.poll(async () => (await packets(request)).filter((packet) => packet.type === 0).length).toBe(2);
  expect((await packets(request)).every((packet) => packet.serial === "device-a")).toBe(true);
  for (const serial of ["device-a", "device-b"]) {
    await expect(card(page, serial).locator(".device-preview-status")).toContainText("streaming");
  }
});

test("changing target mode releases a held gesture on its original devices", async ({ page, request }) => {
  await openOverview(page);
  await targetMode(page, "All devices");
  await tapMapping(page, "Screen positions");
  const position = await point(page, "device-a", 0.4, 0.6);
  await page.mouse.move(position.x, position.y);
  await page.mouse.down();
  await expect.poll(async () => (await touches(request, 0)).length).toBe(2);
  const downs = await touches(request, 0);
  const localMode = page.getByRole("group", { name: "Input targets", exact: true }).getByRole("button", { name: "This device", exact: true });
  await localMode.focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await touches(request, 1)).length).toBe(2);
  const ups = await touches(request, 1);
  for (const down of downs) {
    expect(ups.some((up) => up.serial === down.serial && up.pointerId === down.pointerId)).toBe(true);
  }
  await page.mouse.up();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect.poll(async () => (await packets(request)).filter((packet) => packet.type === 0).length).toBe(2);
  expect((await touches(request, 1)).length).toBe(2);
});

test("closing a broadcasting tab releases only that tab's touches on every target", async ({ page, context, request }) => {
  await openOverview(page);
  const other = await context.newPage();
  await openOverview(other);
  for (const tab of [page, other]) {
    await targetMode(tab, "All devices");
    await tapMapping(tab, "Screen positions");
    const position = await point(tab, "device-a", 0.5, 0.5);
    await tab.mouse.move(position.x, position.y);
    await tab.mouse.down();
  }
  await expect.poll(async () => (await touches(request, 0)).length).toBe(4);
  const downs = await touches(request, 0);
  for (const serial of ["device-a", "device-b"]) {
    expect(new Set(downs.filter((packet) => packet.serial === serial).map((packet) => packet.pointerId)).size).toBe(2);
  }
  await page.close();
  await expect.poll(async () => (await touches(request, 1)).length).toBe(2);
  expect((await touches(request, 1)).map((packet) => packet.serial).sort()).toEqual(["device-a", "device-b"]);
  await other.mouse.up();
  await expect.poll(async () => (await touches(request, 1)).length).toBe(4);
  for (const down of downs) {
    expect((await touches(request, 1)).some((up) => up.serial === down.serial && up.pointerId === down.pointerId)).toBe(true);
  }
});
