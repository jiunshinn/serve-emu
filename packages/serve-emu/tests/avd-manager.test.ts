import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAvd, getAvdCatalog, parseAvdImages, parseAvdProfiles } from "../src/avd-manager.ts";
import type { execText } from "../src/exec.ts";

const root = mkdtempSync(join(tmpdir(), "serve-emu-avd-test-"));
const bin = join(root, "cmdline-tools", "latest", "bin");
mkdirSync(bin, { recursive: true });
for (const tool of ["avdmanager", "sdkmanager"]) writeFileSync(join(bin, tool), "");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const profiles = `Available devices definitions:
id: 2 or "pixel_8"
    Name: Pixel 8
    OEM : Google
---------
id: 9 or "7.6in Foldable"
    Name: 7.6" Fold-in with outer display
    OEM : Generic
---------
id: 10 or "pixel_fold"
    Name: Pixel Fold
    OEM : Google
`;
const image = "system-images;android-35;google_apis;arm64-v8a";
const images = `Installed packages:
Path | Version | Description | Location
${image} | 1 | Google APIs ARM | system-images/android-35/google_apis/arm64-v8a
system-images;android-35;google_apis;x86_64 | 1 | Google APIs Intel | somewhere
`;
const options = { name: "My_Fold", profile: "7.6in Foldable", image };
function fixture(overrides: { names?: string; fail?: boolean; gate?: Promise<void> } = {}) {
  const calls: string[][] = [];
  const run: typeof execText = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "create") {
      await overrides.gate;
      if (overrides.fail) return { status: 1, signal: null, stdout: "", stderr: "disk full", timedOut: false, error: null };
    }
    const stdout = args[0] === "--list_installed" ? images : args[1] === "device" ? profiles : args[1] === "avd" && args[0] === "list" ? overrides.names ?? "" : "Created";
    return { status: 0, signal: null, stdout, stderr: "", timedOut: false, error: null };
  };
  return { calls, deps: { env: { ANDROID_HOME: root }, which: () => null, arch: "arm64", execText: run } };
}

describe("AVD creation", () => {
  test("reads named profiles, preserving SDK foldable IDs with spaces", () => {
    const result = parseAvdProfiles(profiles);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ id: "7.6in Foldable", name: '7.6" Fold-in with outer display', manufacturer: "Generic", foldable: true });
    expect(result[2]?.foldable).toBe(false);
    expect(parseAvdProfiles("unexpected output")).toEqual([]);
  });
  test("only offers host-compatible images in old and new SDK output", () => {
    expect(parseAvdImages(images, "arm64").map((item) => item.id)).toEqual([image]);
    expect(parseAvdImages(images, "x64")[0]?.abi).toBe("x86_64");
    expect(parseAvdImages(images, "unsupported")).toEqual([]);
    expect(parseAvdImages("  system-images/android-37.1/google_apis_playstore_ps16k/arm64-v8a  6.0.0 -> 9.0.0  16 KB Google Play ARM\n", "arm64")[0]?.id).toBe("system-images;android-37.1;google_apis_playstore_ps16k;arm64-v8a");
  });
  test("discovers SDK tools and returns a catalog", async () => {
    const { deps } = fixture();
    const catalog = await getAvdCatalog(deps);
    expect(catalog.profiles).toHaveLength(3);
    expect(catalog.images).toHaveLength(1);
  });
  test("gives actionable missing-tool guidance", async () => {
    await expect(getAvdCatalog({ env: {}, which: () => null })).rejects.toThrow("SDK Manager → SDK Tools");
  });
  test("creates with argument arrays and no overwrite flag", async () => {
    const { deps, calls } = fixture();
    expect(await createAvd(options, deps)).toEqual({ name: "My_Fold" });
    expect(calls.at(-1)).toEqual([join(bin, "avdmanager"), "create", "avd", "--name", "My_Fold", "--package", image, "--device", "7.6in Foldable"]);
  });
  test.each([null, [], {}, { ...options, name: "../escape" }, { ...options, name: "-force" }, { ...options, name: "a".repeat(81) }, { ...options, image: 12 }])("rejects malformed payload before running tools: %j", async (payload) => {
    const { deps, calls } = fixture();
    await expect(createAvd(payload, deps)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
  test("rejects unknown profiles, uninstalled images and duplicate names", async () => {
    const { deps, calls } = fixture({ names: "my_fold\n" });
    await expect(createAvd({ ...options, profile: "--force" }, deps)).rejects.toThrow("Unknown hardware");
    await expect(createAvd({ ...options, image: image.replace("35", "99") }, deps)).rejects.toThrow("installed system image");
    await expect(createAvd(options, deps)).rejects.toThrow("already exists");
    expect(calls.some((call) => call[1] === "create")).toBe(false);
  });
  test("blocks overlapping mutations and releases the lock after failure", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { deps } = fixture({ gate, fail: true });
    const first = createAvd(options, deps).catch((error: Error) => error);
    await expect(createAvd(options, deps)).rejects.toThrow("already being created");
    release();
    expect((await first as Error).message).toContain("disk full");
    expect(await createAvd(options, fixture().deps)).toEqual({ name: "My_Fold" });
  });
});
