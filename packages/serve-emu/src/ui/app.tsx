import { useDeviceSessionSnapshot } from "./lib/device-session-store";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from "react";
import { StatusBar } from "./components/status-bar";
import type { AccessibilityNode } from "./components/accessibility-panel";
import { DevicePanel } from "./components/device-panel";
import { DeviceOverview } from "./components/device-overview";
import { DeviceStream } from "./components/device-stream";
import { ControlBar, type HardwareKey } from "./components/control-bar";
import { SideTools } from "./components/side-tools";
import { useStream, type DeviceSize, type Sender } from "./lib/use-stream";
import { useDeviceKeyboard } from "./lib/use-device-keyboard";

type StreamControls = {
  canvasRef: RefObject<HTMLCanvasElement>;
  send: Sender;
  deviceSize: DeviceSize | null;
};

const StreamControlsContext = createContext<StreamControls | null>(null);

const StableDevicePanel = memo(DevicePanel);
const StableControlBar = memo(ControlBar);

function useStreamControls(): StreamControls {
  const controls = useContext(StreamControlsContext);
  if (!controls) throw new Error("StreamControlsContext is missing");
  return controls;
}

export function App() {
  const [overview, setOverview] = useState(() =>
    new URLSearchParams(location.search).get("view") === "devices",
  );
  const changeView = useCallback((showOverview: boolean) => {
    const url = new URL(location.href);
    if (showOverview) url.searchParams.set("view", "devices");
    else url.searchParams.delete("view");
    history.replaceState(null, "", url);
    setOverview(showOverview);
  }, []);
  const viewSwitch = (
    <nav className="view-switch" aria-label="Device view">
      <button type="button" aria-pressed={!overview} onClick={() => changeView(false)}>
        Single device
      </button>
      <button type="button" aria-pressed={overview} onClick={() => changeView(true)}>
        All devices
      </button>
    </nav>
  );

  return overview ? (
    <DeviceOverview viewSwitch={viewSwitch} onControl={() => changeView(false)} />
  ) : (
    <SingleDeviceApp viewSwitch={viewSwitch} />
  );
}

function SingleDeviceApp({ viewSwitch }: { viewSwitch: ReactNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { state, send, clearControlError } = useStream(canvasRef);
  const deviceWidth = state.deviceSize?.width;
  const deviceHeight = state.deviceSize?.height;
  const controls = useMemo<StreamControls>(
    () => ({
      canvasRef,
      send,
      deviceSize:
        deviceWidth === undefined || deviceHeight === undefined
          ? null
          : { width: deviceWidth, height: deviceHeight },
    }),
    [send, deviceWidth, deviceHeight],
  );

  return (
    <>
      <StatusBar viewSwitch={viewSwitch} controlError={state.controlError} onDismissError={clearControlError} status={state.status} deviceSize={state.deviceSize} fps={state.fps} stats={state.stats} />
      <StreamControlsContext.Provider value={controls}>
        <AppShell />
      </StreamControlsContext.Provider>
    </>
  );
}

const AppShell = memo(function AppShell() {
  const { canvasRef, send, deviceSize } = useStreamControls();
  const keyboardProxyRef = useRef<HTMLInputElement>(null);
  const deviceSession = useDeviceSessionSnapshot();
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  const [accessibilityEnabled, setAccessibilityEnabled] = useState(false);
  const [accessibilityNodes, setAccessibilityNodes] = useState<AccessibilityNode[]>([]);
  const [highlightedAccessibilityId, setHighlightedAccessibilityId] = useState<string | null>(null);
  const [devicesOpen, setDevicesOpen] = useState(true);
  const keyboardActive = useDeviceKeyboard({ keyboardProxyRef, send });

  useEffect(() => {
    setAccessibilityNodes([]);
    setHighlightedAccessibilityId(null);
  }, [deviceSession.revision]);

  const onPress = useCallback(
    (key: HardwareKey) => send({ type: key }),
    [send],
  );

  return (
    <>
      <main
        className={devicesOpen ? "app-layout devices-open" : "app-layout devices-collapsed"}
        data-app-shell-renders={renderCountRef.current}
      >
        <aside className="device-sidebar" aria-label="Devices sidebar">
          <div className="device-sidebar-header">
            <button
              type="button"
              className="sidebar-toggle"
              onClick={() => setDevicesOpen((open) => !open)}
              aria-label={devicesOpen ? "Collapse devices sidebar" : "Expand devices sidebar"}
              title={devicesOpen ? "Collapse devices" : "Expand devices"}
            >
              <SidebarIcon collapsed={!devicesOpen} />
            </button>
            {devicesOpen ? <span>Devices</span> : null}
          </div>
          {devicesOpen ? <StableDevicePanel /> : null}
        </aside>
        <div className="device">
          <DeviceStream
            canvasRef={canvasRef}
            send={send}
            accessibilityEnabled={accessibilityEnabled}
            accessibilityNodes={accessibilityNodes}
            highlightedAccessibilityId={highlightedAccessibilityId}
            onAccessibilityHover={setHighlightedAccessibilityId}
            deviceSize={deviceSize}
            keyboardProxyRef={keyboardProxyRef}
            keyboardActive={keyboardActive}
          />
          <input
            ref={keyboardProxyRef}
            className="keyboard-proxy"
            aria-hidden="true"
            tabIndex={-1}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        <aside className="side-panel">
          <SideTools key={deviceSession.revision}
            accessibilityEnabled={accessibilityEnabled}
            accessibilityNodes={accessibilityNodes}
            highlightedAccessibilityId={highlightedAccessibilityId}
            onAccessibilityEnabledChange={setAccessibilityEnabled}
            onAccessibilityNodesChange={setAccessibilityNodes}
            onAccessibilityHighlight={setHighlightedAccessibilityId}
          />
        </aside>
      </main>
      <StableControlBar onPress={onPress} />
    </>
  );
});

function SidebarIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={collapsed ? "sidebar-icon collapsed" : "sidebar-icon"}
      viewBox="0 0 20 20"
      fill="none"
    >
      <rect x="3" y="3" width="14" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 3.75V16.25" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M12.5 7.5L10 10L12.5 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
