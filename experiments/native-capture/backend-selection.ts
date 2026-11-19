export type Backend = "scrcpy" | "native";
export type BackendRequest = "auto" | Backend;

export type BackendSelection = {
  requestedBackend: BackendRequest;
  defaultBackend: Backend;
  availableBackends: Backend[];
  platform: string;
  /** Public status text: never includes a preparation error or credentials. */
  reason: string;
};

export function parseBackendRequest(value: string | undefined): BackendRequest {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "scrcpy" || value === "native") return value;
  throw new Error("--backend must be auto, scrcpy, or native.");
}

export async function selectBackend(options: {
  requested: BackendRequest;
  platform: string;
  serial: string;
  /** Check and prepare the real gRPC capture and host encoder dependencies. */
  prepareNative: () => Promise<void>;
}): Promise<BackendSelection> {
  const { requested, platform, serial, prepareNative } = options;
  const result = (defaultBackend: Backend, availableBackends: Backend[], reason: string): BackendSelection => ({
    requestedBackend: requested,
    defaultBackend,
    availableBackends,
    platform,
    reason,
  });

  if (requested === "scrcpy") {
    return result("scrcpy", ["scrcpy"], "scrcpy was explicitly requested.");
  }

  if (platform !== "darwin") {
    if (requested === "native") {
      throw new Error("The native backend requires macOS with VideoToolbox. Use --backend scrcpy on this platform.");
    }
    return result("scrcpy", ["scrcpy"], "Native capture requires macOS; using scrcpy.");
  }

  if (!/^emulator-\d+$/.test(serial)) {
    if (requested === "native") {
      throw new Error("The native backend requires a local Android emulator with an emulator-<port> serial. Use --backend scrcpy for this device.");
    }
    return result("scrcpy", ["scrcpy"], "Native capture requires a local Android emulator; using scrcpy.");
  }

  try {
    await prepareNative();
  } catch {
    // gRPC errors can include authentication details. Keep both public status
    // and thrown errors independent of the original error, including cause.
    if (requested === "native") {
      throw new Error("Native backend preparation failed. Check emulator gRPC discovery and authentication, and FFmpeg with h264_videotoolbox. Use --backend scrcpy to continue.");
    }
    return result("scrcpy", ["scrcpy"], "Native capture preparation failed; using scrcpy.");
  }

  if (requested === "native") {
    return result("native", ["native"], "Native capture was explicitly requested and is ready.");
  }
  return result("native", ["scrcpy", "native"], "Native capture is ready on macOS.");
}
