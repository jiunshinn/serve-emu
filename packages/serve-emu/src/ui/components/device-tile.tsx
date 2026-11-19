import { useRef } from "react";
import { DeviceStream } from "./device-stream";
import { useStream } from "../lib/use-stream";

/** Just the live stream, for a dashboard tile's iframe. */
export function DeviceTile() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { state, send } = useStream(canvasRef);
  return (
    <div className="tile-view">
      <DeviceStream canvasRef={canvasRef} send={send} deviceSize={state.deviceSize} />
      <div className="tile-status">
        {state.status} · {Math.round(state.fps)} fps
      </div>
    </div>
  );
}
