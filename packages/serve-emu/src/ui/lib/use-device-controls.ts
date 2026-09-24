import { useCallback, useEffect, useRef, useState } from "react";
import { DeviceControls, type DeviceControlState } from "./device-controls";

export function useDeviceControls(serials: readonly string[]) {
  const [states, setStates] = useState<Record<string, DeviceControlState>>({});
  const controlsRef = useRef<DeviceControls | null>(null);
  const serialsRef = useRef(serials);
  serialsRef.current = serials;
  const serialKey = JSON.stringify([...new Set(serials)].sort());

  useEffect(() => {
    let disposed = false;
    const controls = new DeviceControls({
      createSocket: (serial) => {
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        return new WebSocket(`${protocol}//${location.host}/ws?serial=${encodeURIComponent(serial)}&control=1&video=0`);
      },
      onChange: (next) => { if (!disposed) setStates(next); },
    });
    controlsRef.current = controls;
    controls.setSerials(serialsRef.current);
    return () => {
      disposed = true;
      controls.close();
      if (controlsRef.current === controls) controlsRef.current = null;
    };
  }, []);

  useEffect(() => { controlsRef.current?.setSerials(serialsRef.current); }, [serialKey]);

  const send = useCallback((targets: readonly string[], message: Record<string, unknown>, ack = true) =>
    controlsRef.current?.send(targets, message, ack) ?? false, []);
  const releaseAll = useCallback(() => { controlsRef.current?.releaseAll(); }, []);
  const clearErrors = useCallback(() => { controlsRef.current?.clearErrors(); }, []);
  return { states, send, releaseAll, clearErrors };
}
