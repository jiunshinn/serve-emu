import { createRoot } from "react-dom/client";
import { App } from "./app";
import { DeviceGrid } from "./components/device-grid";
import { DeviceTile } from "./components/device-tile";
import { ErrorBoundary } from "./components/error-boundary";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
const view =
  location.pathname.replace(/\/+$/, "") === "/grid" ? (
    <DeviceGrid />
  ) : new URLSearchParams(location.search).has("tile") ? (
    <DeviceTile />
  ) : (
    <App />
  );
createRoot(root).render(<ErrorBoundary label="serve-emu">{view}</ErrorBoundary>);
