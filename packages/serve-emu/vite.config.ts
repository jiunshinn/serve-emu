import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { uiPagePath } from "./src/server/device-path";

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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, packageDirectory, "");

  return {
    root: "src/ui",
    plugins: [
      react(),
      {
        name: "serve-emu-ui-entries",
        configureServer(server) {
          server.middlewares.use((request, _response, next) => {
            if (request.url) {
              const page = uiPagePath(new URL(request.url, DEFAULT_BACKEND_ORIGIN));
              if (page) request.url = page;
            }
            next();
          });
        },
      },
    ],
    build: {
      outDir: "../../dist/ui",
      emptyOutDir: true,
      rollupOptions: {
        input: [
          join(packageDirectory, "src/ui/index.html"),
          join(packageDirectory, "src/ui/compact.html"),
        ],
      },
    },
    server: {
      port: DEFAULT_UI_PORT,
      proxy: createBackendProxy(env.SERVE_EMU_BACKEND_ORIGIN),
    },
  };
});
