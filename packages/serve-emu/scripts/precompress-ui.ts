import { join } from "node:path";
import { gzipSync } from "node:zlib";

const uiDir = join(import.meta.dir, "../dist/ui");
for await (const asset of new Bun.Glob("assets/**/*.{js,css}").scan(uiDir)) {
  const path = join(uiDir, asset);
  const source = await Bun.file(path).bytes();
  const compressed = gzipSync(source);
  if (compressed.byteLength < source.byteLength) {
    await Bun.write(`${path}.gz`, compressed);
  }
}
