import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { execText } from "./exec.ts";

import type { AvdProfile, AvdSystemImage, AvdCatalog, CreateAvdOptions } from "./shared/avd-contracts.ts";

export class AvdManagerError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

type Dependencies = {
  execText?: typeof execText;
  env?: NodeJS.ProcessEnv;
  arch?: string;
  which?: (name: string) => string | null;
};

const SETUP_HELP = "Install Android SDK Command-line Tools (latest) in Android Studio → SDK Manager → SDK Tools, and set ANDROID_HOME to your SDK directory. Java 17 or newer must be available (JAVA_HOME can point to Android Studio's bundled JBR).";

function resolveTools(deps: Dependencies) {
  const env = deps.env ?? process.env;
  const pathTool = (deps.which ?? Bun.which)("avdmanager");
  const roots = [...new Set([
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    env.HOME && join(env.HOME, "Library", "Android", "sdk"),
    env.HOME && join(env.HOME, "Android", "Sdk"),
  ].filter((root): root is string => !!root))];
  const bins: string[] = [];
  for (const root of roots) {
    const tools = join(root, "cmdline-tools");
    bins.push(join(tools, "latest", "bin"));
    if (existsSync(tools)) {
      const versions = readdirSync(tools).filter((name) => /^\d/.test(name));
      versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      bins.push(...versions.map((version) => join(tools, version, "bin")));
    }
    bins.push(join(root, "tools", "bin"));
  }
  if (pathTool) bins.push(dirname(pathTool));
  for (const bin of bins) {
    const avdmanager = join(bin, "avdmanager");
    const sdkmanager = join(bin, "sdkmanager");
    if (existsSync(avdmanager) && existsSync(sdkmanager)) return { avdmanager, sdkmanager };
  }
  throw new AvdManagerError(SETUP_HELP, 503);
}

async function runTool(
  command: string,
  args: string[],
  deps: Dependencies,
  timeout = 30_000,
): Promise<string> {
  const result = await (deps.execText ?? execText)(command, args, {
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    lane: "background",
  });
  if (result.status !== 0 || result.error) {
    const detail = (result.stderr.trim() || result.error?.message || result.stdout.trim()).slice(0, 2000);
    throw new AvdManagerError(`Android SDK command failed: ${detail || "unknown error"}. ${SETUP_HELP}`, 503);
  }
  return result.stdout;
}

export function parseAvdProfiles(output: string): AvdProfile[] {
  const profiles: AvdProfile[] = [];
  for (const block of output.split(/(?=^id:)/m)) {
    const id = block.match(/^id:\s*\d+\s+or\s+"([^"]+)"/m)?.[1];
    const name = block.match(/^\s*Name:\s*(.+)$/m)?.[1]?.trim();
    if (!id || !name) continue;
    profiles.push({
      id,
      name,
      manufacturer: block.match(/^\s*OEM\s*:\s*(.+)$/m)?.[1]?.trim() ?? "",
      foldable: /fold|flip/i.test(`${id} ${name}`),
    });
  }
  return profiles.sort((a, b) => Number(b.foldable) - Number(a.foldable) || a.name.localeCompare(b.name));
}

export function parseAvdImages(output: string, arch: string): AvdSystemImage[] {
  const abi = arch === "arm64" ? "arm64-v8a" : arch === "x64" ? "x86_64" : null;
  const images = new Map<string, AvdSystemImage>();
  for (const line of output.split(/\r?\n/)) {
    // New SDK tools delegate to Android CLI, which uses slash-separated IDs.
    const modern = line.match(/^\s*(system-images\/\S+)\s+\S+(?:\s+->\s+\S+)?\s+(.+?)\s*$/);
    const columns = line.includes("|") ? line.split("|") : [modern?.[1], "", modern?.[2]].map((value) => value ?? "");
    const [rawId, , description] = columns.map((part) => part.trim());
    const id = rawId?.replaceAll("/", ";");
    if (!id || !/^system-images;android-[\w.-]+;[\w.-]+;[\w-]+$/.test(id)) continue;
    const imageAbi = id.split(";")[3]!;
    if (imageAbi !== abi) continue;
    images.set(id, { id, name: `${description || id} · ${id.split(";")[1]}`, abi: imageAbi });
  }
  return [...images.values()].sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
}

async function loadCatalog(tools: ReturnType<typeof resolveTools>, deps: Dependencies): Promise<AvdCatalog> {
  const [profiles, images] = await Promise.all([
    runTool(tools.avdmanager, ["list", "device"], deps),
    runTool(tools.sdkmanager, ["--list_installed"], deps),
  ]);
  return {
    profiles: parseAvdProfiles(profiles),
    images: parseAvdImages(images, deps.arch ?? process.arch),
  };
}

export async function getAvdCatalog(deps: Dependencies = {}): Promise<AvdCatalog> {
  return loadCatalog(resolveTools(deps), deps);
}

function validateOptions(value: unknown): CreateAvdOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AvdManagerError("Create payload must be an object.");
  }
  const { name, profile, image } = value as Record<string, unknown>;
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(name)) {
    throw new AvdManagerError("Name must be 1–80 letters, numbers, underscores or hyphens, starting with a letter or number.");
  }
  if (typeof profile !== "string" || !profile || profile.length > 200 ||
      typeof image !== "string" || !image || image.length > 300) {
    throw new AvdManagerError("Choose a hardware profile and an installed system image.");
  }
  return { name, profile, image };
}

// Serialize mutations across all HTTP clients; never overwrite an existing AVD.
let creating = false;
export async function createAvd(value: unknown, deps: Dependencies = {}): Promise<{ name: string }> {
  const options = validateOptions(value);
  if (creating) throw new AvdManagerError("An emulator is already being created. Try again when it finishes.", 409);
  creating = true;
  try {
    const tools = resolveTools(deps);
    const catalog = await loadCatalog(tools, deps);
    if (!catalog.profiles.some((profile) => profile.id === options.profile)) {
      throw new AvdManagerError("Unknown hardware profile. Refresh the available options.");
    }
    if (!catalog.images.some((image) => image.id === options.image)) {
      throw new AvdManagerError("Choose an installed system image compatible with this computer.");
    }
    const names = await runTool(tools.avdmanager, ["list", "avd", "-c"], deps);
    if (names.split(/\r?\n/).some((name) => name.trim().toLowerCase() === options.name.toLowerCase())) {
      throw new AvdManagerError(`An emulator named "${options.name}" already exists. Choose another name.`, 409);
    }
    await runTool(tools.avdmanager, [
      "create", "avd", "--name", options.name,
      "--package", options.image, "--device", options.profile,
    ], deps, 60_000);
    return { name: options.name };
  } finally {
    creating = false;
  }
}
