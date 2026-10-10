import { memo, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { DeviceGridResponse, GridDevice } from "./device-panel";
import { deviceSessionStore, useDeviceSessionSnapshot } from "../lib/device-session-store";
import { usePoll } from "../lib/use-poll";
import { useStream, type Sender } from "../lib/use-stream";
import { useDeviceControls } from "../lib/use-device-controls";
import { useDeviceKeyboard } from "../lib/use-device-keyboard";
import { DeviceStream } from "./device-stream";
import { ControlBar } from "./control-bar";

// Bound browser decoders and server encoders while allowing every device to
// be reached by paging. Changing pages unmounts and releases old previews.
const PAGE_SIZE = 8;
type InputMode = "device" | "all" | "selected";
type OverviewSender = (serial: string, message: Record<string, unknown>, ack?: boolean) => void;
type ElementTapper = (serial: string, point: { x: number; y: number }) => void;
type ElementTapResult = {
  ok: boolean;
  error?: string;
  results?: { serial: string; ok: boolean; error?: string; code?: string }[];
  element?: { text: string; contentDescription: string; resourceId: string };
};

export function DeviceOverview({
  viewSwitch,
  onControl,
}: {
  viewSwitch: ReactNode;
  onControl: () => void;
}) {
  const [devices, setDevices] = useState<GridDevice[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<InputMode>("device");
  const [tapMapping, setTapMapping] = useState<"elements" | "positions">("elements");
  const [matchingTap, setMatchingTap] = useState(false);
  const [tapStatus, setTapStatus] = useState<string | null>(null);
  const elementRequest = useRef<AbortController | null>(null);
  const [selectedTargets, setSelectedTargets] = useState<string[]>([]);
  const [sourceSerial, setSourceSerial] = useState<string | null>(null);
  const [inputRevision, setInputRevision] = useState(0);
  const [inputError, setInputError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const keyboardProxyRef = useRef<HTMLInputElement>(null);
  const selectionInFlight = useRef(false);
  const mounted = useRef(false);
  const deviceSession = useDeviceSessionSnapshot();
  const onlineSerials = devices.filter(isReady).map((device) => device.serial!);
  const needle = query.trim().toLowerCase();
  const filtered = devices.filter((device) =>
    [device.name, device.serial, device.avd, device.kind, device.state]
      .join(" ").toLowerCase().includes(needle),
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const source = onlineSerials.includes(sourceSerial ?? "")
    ? sourceSerial!
    : devices.find((device) => device.current && isReady(device))?.serial ?? onlineSerials[0] ?? null;
  const targets = inputMode === "all" ? onlineSerials : inputMode === "selected" ? selectedTargets : source ? [source] : [];
  // Keep targets connected across filtering/paging. In local mode, warm the
  // visible screens so the first tap can be sent immediately. Unselected
  // devices must not consume control slots ahead of an explicitly chosen set.
  const controlSerials = inputMode === "device"
    ? [...visible.filter(isReady).map((device) => device.serial!), ...targets]
    : targets.filter((serial) => onlineSerials.includes(serial));
  const controls = useDeviceControls(controlSerials);
  const deviceName = (serial: string) => devices.find((device) => device.serial === serial)?.name ?? serial;

  const resetInput = () => {
    elementRequest.current?.abort();
    elementRequest.current = null;
    setMatchingTap(false);
    setTapStatus(null);
    controls.releaseAll();
    setInputRevision((revision) => revision + 1);
    setInputError(null);
  };
  const sendFromDevice = useCallback<OverviewSender>((serial, message, ack = true) => {
    if (elementRequest.current) return;
    const targetSerials = inputMode === "all" ? onlineSerials : inputMode === "selected" ? selectedTargets : [serial];
    if (targetSerials.length === 0) {
      setInputError("Select at least one target device.");
      return;
    }
    const sent = controls.send(targetSerials, message, ack);
    // Changing targets deliberately cancels held pointers; their final local
    // MOVE/UP must not turn that normal cleanup into a new input error.
    if (!sent && !(message.type === "touch" && message.action !== "down")) {
      setInputError("Input was not sent. All target devices must be connected.");
    }
    if (message.type === "touch" && message.action === "down") setSourceSerial(serial);
  }, [inputMode, onlineSerials.join("\u0000"), selectedTargets, controls.send]);
  const tapElement = useCallback<ElementTapper>((serial, point) => {
    if (elementRequest.current) return;
    const serials = inputMode === "all" ? onlineSerials : selectedTargets;
    if (!serials.length) {
      setInputError("Select at least one target device.");
      return;
    }
    if (!serials.every((target) => controls.states[target]?.status === "ready")) {
      setInputError("Wait for all target devices to connect before matching a tap.");
      return;
    }
    setSourceSerial(serial);
    setInputError(null);
    controls.clearErrors();
    controls.releaseAll();
    setMatchingTap(true);
    setTapStatus(`Finding matching controls on ${serials.length} device${serials.length === 1 ? "" : "s"}…`);
    const controller = new AbortController();
    elementRequest.current = controller;
    void (async () => {
      try {
        const response = await fetch("/api/devices/tap-element", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceSerial: serial, serials, ...point }),
          signal: controller.signal,
        });
        if (response.status === 404) {
          throw new Error("Element matching is unavailable. Restart serve-emu, then refresh this page.");
        }
        const result = await response.json() as ElementTapResult;
        if (elementRequest.current !== controller || controller.signal.aborted) return;
        if (!response.ok || !result.ok) {
          const failures = result.results?.filter((target) => !target.ok)
            .map((target) => `${devices.find((device) => device.serial === target.serial)?.name ?? target.serial}: ${target.error ?? "Tap was not sent"}`);
          throw new Error(failures?.join("\n") || result.error || "Could not match this control on every target device.");
        }
        const label = result.element?.contentDescription || result.element?.text || result.element?.resourceId || "control";
        setTapStatus(`Tapped “${label}” on ${serials.length} device${serials.length === 1 ? "" : "s"}.`);
      } catch (err) {
        if (elementRequest.current !== controller || controller.signal.aborted) return;
        setTapStatus(null);
        setInputError(err instanceof Error ? err.message : String(err));
      } finally {
        if (elementRequest.current === controller) {
          elementRequest.current = null;
          setMatchingTap(false);
        }
      }
    })();
  }, [inputMode, onlineSerials.join("\u0000"), selectedTargets, controls.states, controls.clearErrors, controls.releaseAll, devices]);
  const sendToTargets = useCallback<Sender>((message, ack) => {
    if (source) sendFromDevice(source, message, ack);
    else setInputError("Connect a device before sending input.");
  }, [source, sendFromDevice]);
  useDeviceKeyboard({ keyboardProxyRef, send: sendToTargets, autoFocus: false });
  const targetErrors = Object.entries(controls.states).filter(([, state]) => state.error);
  const targetsReady = targets.length > 0 && targets.every((serial) => controls.states[serial]?.status === "ready");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      elementRequest.current?.abort();
      elementRequest.current = null;
    };
  }, []);

  const { refresh } = usePoll({
    poll: async ({ signal }) => {
      const response = await fetch("/api/device-grid", { cache: "no-store", signal });
      const json = await response.json() as DeviceGridResponse;
      if (!response.ok || !json.ok || !Array.isArray(json.devices)) {
        throw new Error(json.error || "Could not load devices");
      }
      return json.devices;
    },
    onResult: (devices) => {
      setDevices(devices);
      setLoaded(true);
      setDiscoveryError(null);
    },
    onError: (err) => {
      setDiscoveryError(err instanceof Error ? err.message : String(err));
      setLoaded(true);
    },
    intervalMs: 5_000,
    pollKey: deviceSession.revision,
    enabled: !deviceSession.transitioning,
  });

  const controlDevice = async (device: GridDevice) => {
    if (!device.serial || selectionInFlight.current) return;
    selectionInFlight.current = true;
    setSelecting(device.id);
    setError(null);
    deviceSessionStore.beginTransition(device.serial);
    try {
      const response = await fetch("/api/devices/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial: device.serial }),
      });
      const json = await response.json() as {
        ok?: boolean;
        serial?: string;
        generation?: number;
        error?: string;
      };
      if (!response.ok || !json.ok) throw new Error(json.error || "Could not select device");
      deviceSessionStore.endTransition();
      deviceSessionStore.applyHealth(json);
      if (mounted.current) onControl();
    } catch (err) {
      deviceSessionStore.endTransition();
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      selectionInFlight.current = false;
      if (mounted.current) setSelecting(null);
    }
  };

  const readyCount = devices.filter(isReady).length;

  return (
    <>
      <header>
        <h1>serve-emu</h1>
        {viewSwitch}
        <div className="meta">{loaded ? `${readyCount} device${readyCount === 1 ? "" : "s"} ready` : "Discovering devices…"}</div>
      </header>
      <main className={inputMode === "device" ? "device-overview" : "device-overview shared-input"}>
        <div className="overview-toolbar">
          <div>
            <h2>All devices</h2>
            <p>Tap, swipe, or type once. Send the same input to all devices or a chosen group.</p>
          </div>
          <div className="overview-actions">
            <input
              aria-label="Search all devices"
              placeholder="Search devices"
              value={query}
              onChange={(event) => { resetInput(); setQuery(event.target.value); setPage(0); }}
            />
            <button type="button" onClick={refresh}>Refresh devices</button>
          </div>
        </div>
        <section className="qa-controls" aria-label="QA controls">
          <div className="qa-target-row">
            <div className="qa-input-modes" role="group" aria-label="Input targets">
              {([
                ["device", "This device"],
                ["all", "All devices"],
                ["selected", "Selected devices"],
              ] as const).map(([mode, label]) => (
                <button type="button" key={mode} aria-pressed={inputMode === mode} onClick={() => { resetInput(); setInputMode(mode); }}>
                  {label}
                </button>
              ))}
            </div>
            <span className="qa-target-summary" title={targets.map(deviceName).join(", ")}>
              {inputMode === "device" ? `Input: ${source ? deviceName(source) : "no device"}` : `${targets.length} target${targets.length === 1 ? "" : "s"}`}
              {targets.length > 0 ? targetsReady ? " · ready" : ` · ${targets.filter((serial) => controls.states[serial]?.status === "ready").length}/${targets.length} connected` : ""}
            </span>
            {inputMode === "selected" && (
              <div className="qa-selection-actions">
                <button type="button" onClick={() => { resetInput(); setSelectedTargets(onlineSerials); }}>Select all</button>
                <button type="button" onClick={() => { resetInput(); setSelectedTargets([]); }}>Clear selection</button>
              </div>
            )}
          </div>
          <p className="qa-instructions">
            {inputMode === "device"
              ? "Interact with any screen to control that device. Typing and buttons follow the last screen you touched."
              : inputMode === "all"
                ? "Input on any screen goes to every connected device, including devices on other pages."
                : "Check your target devices, then interact with any screen. Only checked devices receive input, even on other pages."}
          </p>
          {inputMode !== "device" && (
            <div className="qa-tap-mapping">
              <div className="qa-input-modes" role="group" aria-label="Tap mapping">
                <button type="button" aria-pressed={tapMapping === "elements"} onClick={() => { resetInput(); setTapMapping("elements"); }}>Match elements</button>
                <button type="button" aria-pressed={tapMapping === "positions"} onClick={() => { resetInput(); setTapMapping("positions"); }}>Screen positions</button>
              </div>
              <span>{tapMapping === "elements"
                ? "Taps find the same labeled control across layouts. Swipes use relative screen positions."
                : "Taps and swipes use relative screen positions. Use this for matching layouts or unlabeled controls."}</span>
            </div>
          )}
          {tapStatus && (
            <div className="qa-tap-status" role="status">
              <span>{tapStatus}</span>
              {matchingTap && <button type="button" onClick={resetInput}>Cancel matching</button>}
            </div>
          )}
          <form className="qa-text-input" onSubmit={(event) => { event.preventDefault(); if (text) sendToTargets({ type: "text", text }); }}>
            <input aria-label="Text to send" placeholder="Send the same text to your targets" value={text} onChange={(event) => setText(event.target.value)} maxLength={2000} />
            <button type="submit" disabled={!text || !targetsReady || matchingTap}>Send text</button>
          </form>
        </section>
        {(inputError || targetErrors.length > 0) && (
          <div className="overview-error qa-input-error" role="alert">
            <div>
              {inputError && <div>{inputError}</div>}
              {targetErrors.map(([serial, state]) => <div key={serial}>{deviceName(serial)}: {state.error}</div>)}
            </div>
            <button type="button" onClick={() => { setInputError(null); controls.clearErrors(); }}>Dismiss input errors</button>
          </div>
        )}
        {(error || discoveryError) && <div className="overview-error" role="alert">{error || discoveryError}</div>}
        {visible.length ? (
          <div className="device-overview-grid">
            {visible.map((device) => (
              <DevicePreviewCard
                key={device.id}
                device={device}
                selecting={selecting === device.id}
                disabled={selecting !== null || deviceSession.transitioning || matchingTap}
                onControl={() => void controlDevice(device)}
                targetMode={inputMode}
                targeted={!!device.serial && targets.includes(device.serial)}
                onTargetChange={() => {
                  if (!device.serial) return;
                  resetInput();
                  setSelectedTargets((current) => current.includes(device.serial!) ? current.filter((serial) => serial !== device.serial) : [...current, device.serial!]);
                }}
                onInput={sendFromDevice}
                onTap={inputMode !== "device" && tapMapping === "elements" ? tapElement : undefined}
                inputEnabled={!matchingTap}
                keyboardProxyRef={keyboardProxyRef}
                keyboardActive={true}
                inputRevision={inputRevision}
              />
            ))}
          </div>
        ) : (
          <div className="overview-empty">
            <h3>{!loaded ? "Finding your devices…" : query ? "No matching devices" : "No devices found"}</h3>
            <p>{query ? "Try another name or serial number." : "Connect an Android device or start an emulator, then refresh."}</p>
          </div>
        )}
        <div className="overview-bottom">
          <span>{inputMode !== "device" && tapMapping === "elements" ? "Taps match controls across layouts" : "Coordinates scale to each screen"} · Device list refreshes every 5 seconds</span>
          {pageCount > 1 && (
            <nav className="overview-pagination" aria-label="Device pages">
              <button type="button" disabled={currentPage === 0} onClick={() => { resetInput(); setPage(currentPage - 1); }}>Previous</button>
              <span>{currentPage + 1} / {pageCount}</span>
              <button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => { resetInput(); setPage(currentPage + 1); }}>Next</button>
            </nav>
          )}
        </div>
        <input ref={keyboardProxyRef} className="keyboard-proxy" aria-hidden="true" tabIndex={-1} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </main>
      <ControlBar onPress={(key) => sendToTargets({ type: key })} disabled={!targetsReady || matchingTap} />
    </>
  );
}

function isReady(device: GridDevice): boolean {
  return !!device.serial && device.state === "device";
}

function DevicePreviewCard({ device, selecting, disabled, onControl, targetMode, targeted, onTargetChange, onInput, onTap, inputEnabled, keyboardProxyRef, keyboardActive, inputRevision }: {
  device: GridDevice;
  selecting: boolean;
  disabled: boolean;
  onControl: () => void;
  targetMode: InputMode;
  targeted: boolean;
  onTargetChange: () => void;
  onInput: OverviewSender;
  onTap?: ElementTapper;
  inputEnabled: boolean;
  keyboardProxyRef: RefObject<HTMLInputElement>;
  keyboardActive: boolean;
  inputRevision: number;
}) {
  const ready = isReady(device);
  return (
    <article className="device-preview-card" data-serial={device.serial ?? undefined} data-targeted={targeted} aria-label={device.name}>
      <div className="device-preview-heading">
        {targetMode === "selected" && <input type="checkbox" aria-label={`Target ${device.name}`} checked={targeted} disabled={!device.serial || (!ready && !targeted)} onChange={onTargetChange} />}
        <div>
          <h3 title={device.name}>{device.name}</h3>
          <span>{device.serial ?? "Android Virtual Device"}</span>
        </div>
        {targeted && targetMode !== "device" ? <span className="device-preview-selected">Target</span> : device.current && <span className="device-preview-selected">Selected</span>}
      </div>
      {ready ? <LivePreview key={device.serial} serial={device.serial!} name={device.name} onInput={onInput} onTap={onTap} inputEnabled={inputEnabled} keyboardProxyRef={keyboardProxyRef} keyboardActive={keyboardActive} inputRevision={inputRevision} /> : (
        <div className="device-preview-unavailable">
          <strong>{device.state === "stopped" ? "Emulator stopped" : device.state}</strong>
          <span>{device.state === "unauthorized" ? "Allow USB debugging on this device." : device.canStart ? "Start this emulator from the Single device view." : "Waiting for this device to connect."}</span>
        </div>
      )}
      <div className="device-preview-actions">
        <span>{device.kind === "physical" ? "Android device" : "Emulator"}</span>
        <button type="button" aria-label={`Control ${device.name}`} disabled={!ready || disabled} onClick={onControl}>
          {selecting ? "Opening…" : "Control"}
        </button>
      </div>
    </article>
  );
}

const LivePreview = memo(function LivePreview({ serial, name, onInput, onTap, inputEnabled, keyboardProxyRef, keyboardActive, inputRevision }: {
  serial: string;
  name: string;
  onInput: OverviewSender;
  onTap?: ElementTapper;
  inputEnabled: boolean;
  keyboardProxyRef: RefObject<HTMLInputElement>;
  keyboardActive: boolean;
  inputRevision: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { state } = useStream(canvasRef, { serial });
  const live = state.status === "streaming";
  const send = useCallback<Sender>((message, ack) => onInput(serial, message, ack), [onInput, serial]);
  const tap = useCallback((point: { x: number; y: number }) => onTap?.(serial, point), [onTap, serial]);
  return (
    <>
      <div className="device-preview-screen" aria-busy={!inputEnabled}>
        <DeviceStream canvasRef={canvasRef} send={send} onTap={onTap ? tap : undefined} deviceSize={state.deviceSize} keyboardProxyRef={keyboardProxyRef} keyboardActive={keyboardActive} resetKey={`${serial}:${inputRevision}`} inputEnabled={live && inputEnabled} canvasLabel={`Live screen of ${name}`} />
        {!live && <div className="device-preview-overlay">{state.status}</div>}
      </div>
      <div className="device-preview-status" data-live={live} role="status">
        <span><i aria-hidden="true" />{state.status}</span>
        {state.deviceSize && <span>{state.deviceSize.width} × {state.deviceSize.height}{live ? ` · ${state.fps === 0 ? "idle" : `${state.fps} fps`}` : ""}</span>}
      </div>
    </>
  );
});
