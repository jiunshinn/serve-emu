export type DeviceControlState = {
  status: "connecting" | "ready" | "disconnected";
  error: string | null;
};

type Connection = {
  serial: string;
  allowed: boolean;
  socket: WebSocket | null;
  epoch: number;
  retired: boolean;
  retryDelay: number;
  cancelRetry: (() => void) | null;
  cancelHandshake: (() => void) | null;
  state: DeviceControlState;
};

type GestureMember = { connection: Connection; socket: WebSocket; epoch: number };
type Dependencies = {
  createSocket: (serial: string) => WebSocket;
  onChange: (states: Record<string, DeviceControlState>) => void;
  scheduleReconnect?: (callback: () => void, delayMs: number) => () => void;
  scheduleHandshakeTimeout?: (callback: () => void, delayMs: number) => () => void;
};

const MAX_CONTROL_DEVICES = 16;
const MAX_ACTIVE_POINTERS = 16;
const MAX_BUFFERED_INPUT_BYTES = 64 * 1024;
const CONTROL_HANDSHAKE_TIMEOUT_MS = 5_000;
const SOCKET_OPEN = 1;

/** JSON-only connections. Input is sent immediately and is never replayed. */
export class DeviceControls {
  #connections = new Map<string, Connection>();
  #gestures = new Map<number, GestureMember[]>();
  #closed = false;
  #nextEpoch = 0;
  #nextRequest = 0;
  #scheduleReconnect: NonNullable<Dependencies["scheduleReconnect"]>;
  #scheduleHandshakeTimeout: NonNullable<Dependencies["scheduleHandshakeTimeout"]>;

  constructor(private readonly dependencies: Dependencies) {
    const scheduleTimeout = (callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    };
    this.#scheduleReconnect = dependencies.scheduleReconnect ?? scheduleTimeout;
    this.#scheduleHandshakeTimeout = dependencies.scheduleHandshakeTimeout ?? scheduleTimeout;
  }

  setSerials(serials: readonly string[]): void {
    if (this.#closed) return;
    const unique = [...new Set(serials)].sort();
    const desired = new Set(unique);
    const allowed = new Set(unique.slice(0, MAX_CONTROL_DEVICES));
    const removed = [...this.#connections.values()].filter((connection) =>
      !desired.has(connection.serial) || connection.allowed !== allowed.has(connection.serial),
    );
    if (removed.length) this.releaseAll();
    for (const connection of removed) {
      this.#connections.delete(connection.serial);
      this.#retire(connection);
    }
    for (const serial of unique) {
      if (this.#connections.has(serial)) continue;
      const canConnect = allowed.has(serial);
      const connection: Connection = {
        serial,
        allowed: canConnect,
        socket: null,
        epoch: 0,
        retired: false,
        retryDelay: 500,
        cancelRetry: null,
        cancelHandshake: null,
        state: {
          status: canConnect ? "connecting" : "disconnected",
          error: canConnect ? null : `${serial}: At most ${MAX_CONTROL_DEVICES} devices can be controlled at once.`,
        },
      };
      this.#connections.set(serial, connection);
      if (canConnect) this.#connect(connection);
    }
    this.#publish();
  }

  send(serials: readonly string[], message: Record<string, unknown>, ack = true): boolean {
    if (this.#closed) return false;
    const touch = message.type === "touch";
    const pointerId = typeof message.pointerId === "number" ? message.pointerId : 0;
    const continuation = touch && message.action !== "down";
    let members: GestureMember[];

    if (continuation) {
      const gesture = this.#gestures.get(pointerId);
      if (!gesture) return false;
      members = gesture;
    } else {
      const targets = [...new Set(serials)];
      if (!targets.length) return false;
      const unavailable = targets.filter((serial) => {
        const connection = this.#connections.get(serial);
        return !connection || !this.#ready(connection);
      });
      if (unavailable.length) {
        for (const serial of unavailable) {
          const connection = this.#connections.get(serial);
          if (connection) connection.state.error ??= `${serial}: Connection unavailable. Input was not sent.`;
        }
        this.#publish();
        return false;
      }
      members = targets.map((serial) => {
        const connection = this.#connections.get(serial)!;
        return { connection, socket: connection.socket!, epoch: connection.epoch };
      });
    }

    // A pointer belongs to the exact sockets that accepted DOWN. A replacement
    // connection must never receive a delayed MOVE or UP from that gesture.
    if (members.some(({ connection, socket, epoch }) =>
      !this.#ready(connection) || connection.socket !== socket || connection.epoch !== epoch,
    )) {
      this.releaseAll();
      return false;
    }
    const congested = members.filter(({ socket }) => socket.bufferedAmount > MAX_BUFFERED_INPUT_BYTES);
    if (congested.length) {
      for (const { connection } of congested) {
        connection.state.status = "disconnected";
        connection.state.error = `${connection.serial}: Control connection is too slow. Input was not sent.`;
      }
      this.releaseAll();
      for (const { socket } of congested) { try { socket.close(); } catch {} }
      return false;
    }
    if (touch && message.action === "down") {
      if (this.#gestures.has(pointerId) || this.#gestures.size >= MAX_ACTIVE_POINTERS) return false;
      this.#gestures.set(pointerId, members);
    }
    for (const { connection, socket, epoch } of members) {
      try {
        socket.send(JSON.stringify({
          ...message,
          requestId: `${epoch}:${++this.#nextRequest}`,
          ...(!ack ? { ack: false } : {}),
        }));
      } catch {
        connection.state.error = `${connection.serial}: Input could not be sent. Other targets may have received it.`;
        connection.state.status = "disconnected";
        this.releaseAll();
        try { socket.close(); } catch {}
        this.#publish();
        return false;
      }
    }
    if (touch && message.action === "up") this.#gestures.delete(pointerId);
    return true;
  }

  releaseAll(): void {
    this.#gestures.clear();
    for (const connection of this.#connections.values()) {
      if (!this.#ready(connection)) continue;
      try {
        connection.socket!.send(JSON.stringify({ type: "release-input", ack: false }));
      } catch {
        connection.state.status = "disconnected";
        connection.state.error = `${connection.serial}: Connection lost while releasing input.`;
        try { connection.socket?.close(); } catch {}
      }
    }
    this.#publish();
  }

  clearErrors(): void {
    for (const connection of this.#connections.values()) connection.state.error = null;
    this.#publish();
  }

  close(): void {
    if (this.#closed) return;
    this.releaseAll();
    this.#closed = true;
    for (const connection of this.#connections.values()) this.#retire(connection);
    this.#connections.clear();
  }

  #ready(connection: Connection): boolean {
    return !connection.retired && connection.state.status === "ready" &&
      connection.socket?.readyState === SOCKET_OPEN;
  }

  #retire(connection: Connection): void {
    connection.retired = true;
    connection.cancelRetry?.();
    connection.cancelRetry = null;
    this.#cancelHandshake(connection);
    try { connection.socket?.close(); } catch {}
    connection.socket = null;
  }

  #connect(connection: Connection): void {
    if (this.#closed || connection.retired) return;
    connection.cancelRetry = null;
    connection.state.status = "connecting";
    const epoch = ++this.#nextEpoch;
    connection.epoch = epoch;
    let socket: WebSocket;
    try {
      socket = this.dependencies.createSocket(connection.serial);
    } catch {
      connection.state.status = "disconnected";
      connection.state.error = `${connection.serial}: Control connection unavailable.`;
      this.#retry(connection);
      this.#publish();
      return;
    }
    connection.socket = socket;
    const current = () => !this.#closed && !connection.retired &&
      connection.socket === socket && connection.epoch === epoch;
    const rejectUnsupportedControl = () => {
      if (!current()) return;
      this.#cancelHandshake(connection);
      connection.state.status = "disconnected";
      connection.state.error = `${connection.serial}: Device control is unavailable on this server. Restart serve-emu and refresh this page.`;
      this.#interruptGestures(connection);
      try { socket.close(); } catch {}
    };
    socket.onopen = () => {
      if (!current()) return;
      // Old servers accept this URL as a read-only preview. A successful
      // upgrade alone does not establish that input is supported or scoped.
      this.#cancelHandshake(connection);
      connection.cancelHandshake = this.#scheduleHandshakeTimeout(() => {
        if (current() && connection.state.status === "connecting") rejectUnsupportedControl();
      }, CONTROL_HANDSHAKE_TIMEOUT_MS);
      this.#publish();
    };
    socket.onmessage = (event) => {
      if (!current() || typeof event.data !== "string") return;
      try {
        const response = JSON.parse(event.data);
        if (response?.type === "control-ready") {
          if (response.serial !== connection.serial || socket.readyState !== SOCKET_OPEN ||
            connection.state.status !== "connecting") return;
          this.#cancelHandshake(connection);
          connection.retryDelay = 500;
          connection.state = { status: "ready", error: null };
          this.#publish();
          return;
        }
        if (response?.ok === false && response.code === "preview_read_only") {
          rejectUnsupportedControl();
          return;
        }
        if (response?.ok === false && typeof response.error === "string") {
          connection.state.error = `${connection.serial}: ${response.error.slice(0, 300)}`;
          this.#interruptGestures(connection);
        }
      } catch {}
    };
    socket.onerror = () => {
      if (!current()) return;
      this.#cancelHandshake(connection);
      connection.state.status = "disconnected";
      connection.state.error ??= `${connection.serial}: Control connection unavailable.`;
      this.#interruptGestures(connection);
      try { socket.close(); } catch {}
    };
    socket.onclose = () => {
      if (!current()) return;
      this.#cancelHandshake(connection);
      connection.socket = null;
      connection.state.status = "disconnected";
      connection.state.error ??= `${connection.serial}: Control disconnected. Input was not replayed.`;
      this.#interruptGestures(connection);
      this.#retry(connection);
    };
    this.#publish();
  }

  #retry(connection: Connection): void {
    if (this.#closed || connection.retired) return;
    const delay = connection.retryDelay;
    connection.retryDelay = Math.min(5000, Math.round(delay * 1.6));
    connection.cancelRetry = this.#scheduleReconnect(() => this.#connect(connection), delay);
  }

  #cancelHandshake(connection: Connection): void {
    connection.cancelHandshake?.();
    connection.cancelHandshake = null;
  }

  #interruptGestures(connection: Connection): void {
    if ([...this.#gestures.values()].some((members) =>
      members.some((member) => member.connection === connection),
    )) this.releaseAll();
    else this.#publish();
  }

  #publish(): void {
    if (this.#closed) return;
    this.dependencies.onChange(Object.fromEntries(
      [...this.#connections].map(([serial, connection]) => [serial, { ...connection.state }]),
    ));
  }
}
