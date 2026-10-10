import { describe, expect, test } from "bun:test";
import { displaySizeFromPng, loadDisplaySize, parseDefaultDisplay } from "../src/display-size.ts";
import type { execBuffer, execText } from "../src/exec.ts";

const innerId = "4619827259835644672";
const outerId = "4619827551948147201";
const viewport = (id: string, displayId = 0, active = true, width = 2208, height = 1840) =>
  `DisplayViewport{type=INTERNAL, valid=true, isActive=${active}, displayId=${displayId}, uniqueId='local:${id}', logicalFrame=Rect(0, 0 - ${width}, ${height}), deviceWidth=${width}, deviceHeight=${height}}`;
const dump = (...viewports: string[]) => `DISPLAY MANAGER\n  mViewports=[${viewports.join(", ")}]\n  mStableDisplaySize=Point(1080, 2092)\n`;
function png(width = 2208, height = 1840): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write("IHDR", 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
}
function dependencies(texts: string[], image = png()) {
  const calls: string[][] = [];
  let reads = 0;
  return { calls, dependencies: {
    execText: (async (_command: string, args: string[]) => {
      calls.push(args);
      return { status: 0, stdout: texts[Math.min(reads++, texts.length - 1)]!, stderr: "" };
    }) as unknown as typeof execText,
    execBuffer: (async (_command: string, args: string[]) => {
      calls.push(args);
      return { status: 0, stdout: image, stderr: Buffer.alloc(0) };
    }) as unknown as typeof execBuffer,
  } };
}

describe("default display geometry", () => {
  test("resolves active logical display zero instead of the first physical fold panel", () => {
    expect(parseDefaultDisplay(dump(viewport(outerId, 3, false, 1080, 2092), viewport(innerId)))).toEqual({ physicalId: innerId, width: 2208, height: 1840 });
    expect(parseDefaultDisplay(dump(viewport(innerId, 3, false), viewport(outerId, 0, true, 1080, 2092)))).toEqual({ physicalId: outerId, width: 1080, height: 2092 });
  });

  test("rejects unknown, inactive, duplicate, or virtual default mappings", () => {
    for (const text of [
      "SurfaceFlinger displays: " + innerId,
      dump(viewport(innerId, 0, false)),
      dump(viewport(innerId), viewport(outerId)),
      dump(viewport(innerId).replace(`local:${innerId}`, "virtual:scrcpy")),
      dump(viewport("99999999999999999999")),
    ]) expect(() => parseDefaultDisplay(text)).toThrow();
  });

  test("captures the verified physical ID explicitly and rechecks mapping afterward", async () => {
    const mock = dependencies([dump(viewport(outerId, 3, false), viewport(innerId))]);
    expect(await loadDisplaySize("fold", new AbortController().signal, mock.dependencies)).toEqual({ width: 2208, height: 1840 });
    expect(mock.calls).toEqual([
      ["-s", "fold", "shell", "dumpsys", "display"],
      ["-s", "fold", "exec-out", "screencap", "-d", innerId, "-p"],
      ["-s", "fold", "shell", "dumpsys", "display"],
    ]);
  });

  test("never strips a multiple-display warning and accepts an unverified default screenshot", async () => {
    const prefixed = Buffer.concat([Buffer.from("[Warning] Multiple displays were found, but no display id was specified!\n"), png()]);
    expect(() => displaySizeFromPng(prefixed)).toThrow("PNG display size");
    const mock = dependencies([dump(viewport(innerId))], prefixed);
    await expect(loadDisplaySize("fold", new AbortController().signal, mock.dependencies)).rejects.toThrow("PNG display size");
  });

  test("fails closed when folding changes the mapping or screenshot geometry", async () => {
    const changed = dependencies([dump(viewport(innerId)), dump(viewport(outerId, 0, true, 1080, 2092))]);
    await expect(loadDisplaySize("fold", new AbortController().signal, changed.dependencies)).rejects.toThrow("mapping or geometry changed");
    const geometry = dependencies([dump(viewport(innerId))], png(1080, 2092));
    await expect(loadDisplaySize("fold", new AbortController().signal, geometry.dependencies)).rejects.toThrow("mapping or geometry changed");
  });
});
