import { useCallback, useEffect, useRef, useState } from "react";
import type { LocationPoint } from "./route-map";
import { DEFAULT_MAX_ROUTE_FILE_BYTES } from "./route-parser";
import type {
  RouteParserWorkerCommand,
  RouteParserWorkerResponse,
} from "./route-parser-worker";

export type LoadedRoute = {
  points: LocationPoint[];
  format: string;
};

export type RouteFileLoaderOptions = {
  /** Progress and outcome lines for the panel status. */
  onStatus: (text: string) => void;
  onLoaded: (route: LoadedRoute) => void;
};

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
}

/**
 * Parses a route file (GPX, GeoJSON, KML) in a worker so a large file never
 * blocks the stream. One parse at a time: loading another file or calling
 * `cancel` abandons the previous worker, and so does unmounting.
 */
export function useRouteFileLoader(options: RouteFileLoaderOptions) {
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef(0);
  const [parsing, setParsing] = useState(false);
  // Read when worker messages arrive, so the callbacks may change freely.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const abandon = useCallback(() => {
    requestRef.current += 1;
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);

  useEffect(() => abandon, [abandon]);

  const cancel = useCallback(() => {
    abandon();
    setParsing(false);
    optionsRef.current.onStatus("Route load cancelled");
  }, [abandon]);

  const load = useCallback((file: File) => {
    const status = (text: string) => optionsRef.current.onStatus(text);
    abandon();
    const requestId = requestRef.current;
    setParsing(false);

    // This check intentionally runs before the File crosses the worker
    // boundary; the worker repeats it before calling File.text().
    if (file.size > DEFAULT_MAX_ROUTE_FILE_BYTES) {
      status(`Route file exceeds ${formatMegabytes(DEFAULT_MAX_ROUTE_FILE_BYTES)}`);
      return;
    }
    if (typeof Worker !== "function") {
      status("Route parsing requires Web Worker support");
      return;
    }

    setParsing(true);
    status(`Loading ${file.name} in worker...`);
    let worker: Worker;
    try {
      worker = new Worker(new URL("./route-parser-worker.ts", import.meta.url), {
        type: "module",
      });
    } catch (error) {
      setParsing(false);
      status(error instanceof Error ? error.message : "Worker start failed");
      return;
    }
    workerRef.current = worker;

    const current = () =>
      requestId === requestRef.current && workerRef.current === worker;
    const finish = () => {
      if (workerRef.current === worker) workerRef.current = null;
      worker.terminate();
      setParsing(false);
    };
    worker.addEventListener(
      "message",
      (event: MessageEvent<RouteParserWorkerResponse>) => {
        const message = event.data;
        if (!current() || message.requestId !== requestId) return;
        if (message.type === "accepted") {
          status(`Reading ${message.fileName}...`);
        } else if (message.type === "progress") {
          status(
            message.stage === "reading"
              ? `Reading route ${message.bytesRead === message.totalBytes ? "100%" : "..."}`
              : `Parsing route... ${message.waypoints} waypoints`,
          );
        } else if (message.type === "result") {
          const { points, format } = message.result;
          optionsRef.current.onLoaded({ points, format });
          status(`Loaded ${points.length} ${format.toUpperCase()} waypoints`);
          finish();
        } else if (message.type === "error") {
          status(message.error.message);
          finish();
        } else if (message.type === "cancelled") {
          status("Route load cancelled");
          finish();
        }
      },
    );
    worker.addEventListener("error", (event) => {
      if (!current()) return;
      event.preventDefault();
      status(event.message || "Route worker failed");
      finish();
    });
    worker.addEventListener("messageerror", () => {
      if (!current()) return;
      status("Route worker response could not be decoded");
      finish();
    });
    const command: RouteParserWorkerCommand = {
      type: "parse",
      requestId,
      file,
    };
    try {
      worker.postMessage(command);
    } catch (error) {
      status(error instanceof Error ? error.message : "Route file could not be sent");
      finish();
    }
  }, [abandon]);

  return { parsing, load, cancel };
}
