import { execBuffer, execText } from "./exec.ts";
import type { DeviceSize } from "./shared/api-contracts.ts";

export function displaySizeFromPng(png: Buffer): DeviceSize {
  if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    png.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("screen capture did not contain a PNG display size");
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!width || !height || width > 65_535 || height > 65_535) throw new Error("invalid display size");
  return { width, height };
}

type DefaultDisplay = DeviceSize & { physicalId: string };

/** Resolve logical display 0, which scrcpy controls, rather than the first physical panel. */
export function parseDefaultDisplay(text: string): DefaultDisplay {
  if (text.length > 4 * 1024 * 1024) throw new Error("display metadata exceeds the size limit");
  const viewports = text.match(/^\s*mViewports=\[(.*)\]\s*$/m)?.[1] ?? "";
  const active = Array.from(viewports.matchAll(/DisplayViewport\{([^}]+)\}/g), (match) => match[1]!)
    .filter((entry) => /\bvalid=true(?:,|$)/.test(entry) && /\bisActive=true(?:,|$)/.test(entry) && /\bdisplayId=0(?:,|$)/.test(entry));
  if (active.length !== 1) throw new Error("could not uniquely identify the active default display");
  const physicalId = active[0]!.match(/\buniqueId='local:(\d{1,20})'/)?.[1];
  const frame = active[0]!.match(/\blogicalFrame=Rect\(0,\s*0\s*-\s*(\d+),\s*(\d+)\)/);
  if (!physicalId || BigInt(physicalId) > 0xffffffffffffffffn || !frame) {
    throw new Error("default display has no verified physical mapping and viewport");
  }
  const width = Number(frame[1]);
  const height = Number(frame[2]);
  if (!width || !height || width > 65_535 || height > 65_535) throw new Error("invalid default display viewport");
  return { physicalId, width, height };
}

/** Verify a screenshot of the current logical display's physical panel before using its dimensions. */
export async function loadDisplaySize(
  serial: string,
  signal: AbortSignal,
  dependencies: { execText?: typeof execText; execBuffer?: typeof execBuffer } = {},
): Promise<DeviceSize> {
  const readDisplay = async () => {
    const result = await (dependencies.execText ?? execText)("adb", ["-s", serial, "shell", "dumpsys", "display"], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 4_000,
      signal,
      lane: "interactive",
    });
    if (signal.aborted) throw signal.reason;
    if (result.status !== 0 || result.error) throw new Error("could not read the current default display mapping");
    return parseDefaultDisplay(result.stdout);
  };
  const before = await readDisplay();
  const result = await (dependencies.execBuffer ?? execBuffer)("adb", ["-s", serial, "exec-out", "screencap", "-d", before.physicalId, "-p"], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 8_000,
    signal,
    lane: "interactive",
  });
  if (signal.aborted) throw signal.reason;
  if (result.status !== 0 || result.error) throw new Error("could not read the current display size");
  const size = displaySizeFromPng(result.stdout);
  const after = await readDisplay();
  if (before.physicalId !== after.physicalId || before.width !== after.width || before.height !== after.height ||
    size.width !== after.width || size.height !== after.height) {
    throw new Error("the default display mapping or geometry changed during capture; wait for the screen and retry");
  }
  return size;
}
