// Opens the bundled UI in headless Chromium and samples its status bar once a
// second: the rendered fps, plus the decode/latency detail the status bar
// keeps in its tooltip. Compare with measure-source-fps.ts over the same
// window to separate browser-side drops from source-side ones.
//
// Headless Chromium paces animation frames at 60 Hz; a headed browser on a
// 120 Hz display coalesces fewer frames, so treat this as a lower bound.
//
// usage: bun probe-ui-fps.ts [port=3300] [seconds=15]
// Uses the Playwright installed for packages/serve-emu (run `bun install` at
// the repo root and `bunx playwright install chromium` in that package once).

import { createRequire } from "node:module";

const requireFromPackage = createRequire(
  new URL("../../packages/serve-emu/package.json", import.meta.url),
);
const { chromium } = requireFromPackage(
  "@playwright/test",
) as typeof import("@playwright/test");

const port = Number(process.argv[2] ?? 3300);
const seconds = Number(process.argv[3] ?? 15);
const token = process.env.SERVE_EMU_TOKEN;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  // ?token= is exchanged for the session cookie, like the URL the CLI prints.
  await page.goto(`http://127.0.0.1:${port}/${token ? `?token=${token}` : ""}`);
  await page.waitForFunction(
    () => /fps/.test(document.querySelector(".meta")?.textContent ?? ""),
    null,
    { timeout: 20_000 },
  );

  const samples: number[] = [];
  let last = { text: "", detail: "" };
  for (let i = 0; i < seconds; i++) {
    await page.waitForTimeout(1000);
    last = await page.evaluate(() => {
      const meta = document.querySelector(".meta");
      return {
        text: meta?.textContent ?? "",
        detail: meta?.getAttribute("title") ?? "",
      };
    });
    samples.push(Number(/(\d+) fps/.exec(last.text)?.[1] ?? 0));
  }
  console.log(`rendered fps/sec: [${samples.join(",")}]`);
  console.log(`status: ${last.text}`);
  console.log(`detail: ${last.detail}`);
} finally {
  await browser.close();
}
