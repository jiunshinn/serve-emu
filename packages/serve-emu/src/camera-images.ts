import { randomUUID } from "node:crypto";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_CAMERA_IMAGE_BYTES = 8 * 1024 * 1024;
const PLACEHOLDER = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNsaGhgYGBgYmBgYGBgAAASKgGEzwCOrgAAAABJRU5ErkJggg==", "base64");

export class CameraImageError extends Error {
  constructor(readonly code: "invalid" | "unavailable", message: string) {
    super(message);
    this.name = "CameraImageError";
  }
}

export function cameraImageSize(bytes: Uint8Array): { width: number; height: number } {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length < 33 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR") {
    throw new CameraImageError("invalid", "Camera image must be a PNG with an IHDR header.");
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 4096 || height > 4096) {
    throw new CameraImageError("invalid", "Camera image dimensions must be between 1 and 4096 pixels.");
  }
  return { width, height };
}

export async function createCameraImages(avd: string, back?: string, front?: string) {
  const directory = [back, front].includes("uploaded") ? await mkdtemp(join(tmpdir(), "serve-emu-camera-")) : null;
  const paths: Partial<Record<"back" | "front", string>> = {};
  const modes = { back: back?.split(":", 1)[0] ?? null, front: front?.split(":", 1)[0] ?? null };
  const cleanup = async () => { if (directory) await rm(directory, { recursive: true, force: true }); };
  try {
    for (const camera of ["back", "front"] as const) {
      if (modes[camera] !== "uploaded" || !directory) continue;
      const path = join(directory, `${avd.replace(/[^a-zA-Z0-9_-]/g, "_")}-${camera}.png`);
      await writeFile(path, PLACEHOLDER, { mode: 0o600 });
      paths[camera] = path;
    }
  } catch (error) { await cleanup(); throw error; }
  let closed = false;
  return {
    modes,
    args: (args: string[]) => args.map((arg, i) => arg === "uploaded" ? `imagefile:${paths[args[i - 1] === "-camera-back" ? "back" : "front"]}` : arg),
    assertUploaded(camera: "back" | "front") {
      if (closed || !paths[camera]) throw new CameraImageError("unavailable", `Launch this AVD with ${camera === "back" ? "cameraBack" : "cameraFront"}: "uploaded" to upload a ${camera} camera image.`);
    },
    async write(camera: "back" | "front", bytes: Uint8Array, signal: AbortSignal) {
      this.assertUploaded(camera);
      const path = paths[camera]!;
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, bytes, { mode: 0o600, flag: "wx", signal });
        signal.throwIfAborted();
        this.assertUploaded(camera);
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    },
    async cleanup() { closed = true; await cleanup(); },
  };
}

export type CameraImages = Awaited<ReturnType<typeof createCameraImages>>;
