import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

export const DEFAULT_BACKEND_ORIGIN = "http://localhost:3300";
export const DEFAULT_UI_PORT = 5173;

type BackendProxy = Record<"/api" | "/health" | "/ws", ProxyOptions>;

function parseBackendOrigin(value: string | undefined): URL {
  const configuredOrigin =
    value === undefined ? DEFAULT_BACKEND_ORIGIN : value.trim();
  let backend: URL;
  try {
    backend = new URL(configuredOrigin);
  } catch {
    throw new Error(
      "SERVE_EMU_BACKEND_ORIGIN must be a valid HTTP or HTTPS origin",
    );
  }

  if (backend.protocol !== "http:" && backend.protocol !== "https:") {
    throw new Error("SERVE_EMU_BACKEND_ORIGIN must use http:// or https://");
  }
  if (backend.username || backend.password) {
    throw new Error("SERVE_EMU_BACKEND_ORIGIN must not include credentials");
  }
  if (backend.pathname !== "/") {
    throw new Error("SERVE_EMU_BACKEND_ORIGIN must not include a path");
  }
  if (configuredOrigin.includes("?") || configuredOrigin.includes("#")) {
    throw new Error("SERVE_EMU_BACKEND_ORIGIN must not include a query or hash");
  }

  return backend;
}

export function createBackendProxy(backendOrigin?: string): BackendProxy {
  const backend = parseBackendOrigin(backendOrigin);
  const httpTarget = backend.origin;
  const wsTarget = new URL(httpTarget);
  wsTarget.protocol = backend.protocol === "https:" ? "wss:" : "ws:";

  return {
    "/api": { target: httpTarget, changeOrigin: false },
    "/health": { target: httpTarget, changeOrigin: false },
    "/ws": {
      target: wsTarget.origin,
      changeOrigin: false,
      ws: true,
      rewriteWsOrigin: false,
    },
  };
}

const packageDirectory = dirname(fileURLToPath(import.meta.url));

function precompressUiAssets(): Plugin {
  return {
    name: "serve-emu:precompress-ui",
    apply: "build",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        for (const asset of Object.values(bundle)) {
          if (!/^assets\/.*\.(js|css)$/.test(asset.fileName)) continue;
          const source = asset.type === "chunk" ? asset.code : asset.source;
          const gzipped = gzipSync(source);
          const originalSize = typeof source === "string" ? Buffer.byteLength(source) : source.byteLength;
          if (gzipped.byteLength >= originalSize) continue;
          this.emitFile({ type: "asset", fileName: `${asset.fileName}.gz`, source: gzipped });
        }
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, packageDirectory, "");

  return {
    root: "src/ui",
    plugins: [react(), precompressUiAssets()],
    build: {
      outDir: "../../dist/ui",
      emptyOutDir: true,
    },
    server: {
      port: DEFAULT_UI_PORT,
      proxy: createBackendProxy(env.SERVE_EMU_BACKEND_ORIGIN),
    },
  };
});
