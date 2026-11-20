import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { cameraImageSize, createCameraImages } from "../src/camera-images.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNsaGhgYGBgYmBgYGBgAAASKgGEzwCOrgAAAABJRU5ErkJggg==", "base64");

test("owned camera images seed private independent PNG files and replace atomically", async () => {
  const images = await createCameraImages("../../pixel", "uploaded", "uploaded");
  const second = await createCameraImages("pixel", "uploaded");
  const args = images.args(["-camera-back", "uploaded", "-camera-front", "uploaded"]);
  const path = args[1]!.slice("imagefile:".length);
  const front = args[3]!.slice("imagefile:".length);
  const other = second.args(["-camera-back", "uploaded"])[1]!.slice("imagefile:".length);
  try {
    expect(images.modes).toEqual({ back: "uploaded", front: "uploaded" });
    expect(cameraImageSize(await readFile(path))).toEqual({ width: 2, height: 2 });
    expect(await readFile(front)).toEqual(png);
    expect(dirname(path)).not.toBe(dirname(other));
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    const inode = (await stat(path)).ino;
    await images.write("back", png, new AbortController().signal);
    expect((await stat(path)).ino).not.toBe(inode);
    expect(await readFile(path)).toEqual(png);
    const abort = new AbortController(); abort.abort();
    await expect(images.write("back", png, abort.signal)).rejects.toThrow();
  } finally { await images.cleanup(); await second.cleanup(); }
  expect(existsSync(dirname(path))).toBe(false);
  expect(() => images.assertUploaded("back")).toThrow("cameraBack");
});

test("file camera state strips paths and non-uploaded cameras reject uploads", async () => {
  for (const mode of ["imagefile", "videofile", "image360"]) {
    const images = await createCameraImages("pixel", `${mode}:/private/secret`, "none");
    expect(images.modes).toEqual({ back: mode, front: "none" });
    expect(images.args(["-camera-back", "emulated"])).toEqual(["-camera-back", "emulated"]);
    expect(() => images.assertUploaded("front")).toThrow('cameraFront: "uploaded"');
    await images.cleanup();
  }
  const images = await createCameraImages("pixel");
  expect(images.modes).toEqual({ back: null, front: null });
  await images.cleanup();
});

test("PNG header validation rejects empty, non-PNG, missing IHDR and invalid dimensions", () => {
  expect(cameraImageSize(png)).toEqual({ width: 2, height: 2 });
  for (const bytes of [Buffer.alloc(0), Buffer.from("JPEG"), png.subarray(0, 32)]) expect(() => cameraImageSize(bytes)).toThrow("PNG");
  for (const [offset, value] of [[8, 12], [12, 0], [16, 0], [20, 4097], [16, 4097]] as const) {
    const bytes = Buffer.from(png); bytes.writeUInt32BE(value, offset);
    expect(() => cameraImageSize(bytes)).toThrow();
  }
});
