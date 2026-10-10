type PreviewSession = {
  serial: string;
  signal: AbortSignal;
  dispose(reason: string): Promise<void>;
};

type PreviewEntry<TSession> = {
  serial: string;
  controller: AbortController;
  context: TSession | null;
  ready: Promise<TSession>;
  users: number;
};

export class DevicePreviewError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "DevicePreviewError";
  }
}

/** Shares a serial-scoped stream until its final viewer or controller leaves. */
export class DevicePreviewPool<TSession extends PreviewSession> {
  #entries = new Map<string, PreviewEntry<TSession>>();
  #drains = new Set<Promise<unknown>>();
  #closed = false;

  constructor(
    readonly limit: number,
    private readonly open: (serial: string, signal: AbortSignal) => Promise<TSession>,
    private readonly activate: (context: TSession) => void,
  ) {}

  isPublished(context: TSession): boolean {
    return this.#entries.get(context.serial)?.context === context;
  }

  isCurrent(context: TSession): boolean {
    return this.isPublished(context) && !context.signal.aborted;
  }

  snapshot(): Array<{ serial: string; context: TSession | null }> {
    return Array.from(this.#entries.values(), ({ serial, context }) => ({ serial, context }));
  }

  async acquire(serial: string, signal: AbortSignal): Promise<{
    context: TSession;
    release: () => void;
  }> {
    if (this.#closed) throw new DevicePreviewError("server is stopping", 503);
    if (signal.aborted) throw new DevicePreviewError("preview request aborted", 499);
    let entry = this.#entries.get(serial);
    if (entry?.context?.signal.aborted) {
      this.#retire(entry, "preview session ended");
      entry = undefined;
    }
    if (!entry) {
      if (this.#entries.size >= this.limit) {
        throw new DevicePreviewError(`at most ${this.limit} devices can be connected at once`, 429);
      }
      const created: PreviewEntry<TSession> = {
        serial,
        controller: new AbortController(),
        context: null,
        ready: undefined!,
        users: 0,
      };
      this.#entries.set(serial, created);
      created.ready = Promise.resolve().then(async () => {
        const context = await this.open(serial, created.controller.signal);
        created.context = context;
        if (created.controller.signal.aborted) {
          await context.dispose("preview no longer needed");
          throw new DevicePreviewError("preview request aborted", 499);
        }
        this.activate(context);
        return context;
      });
      entry = created;
    }
    const acquired = entry;
    acquired.users++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      acquired.users--;
      if (acquired.users === 0) this.#retire(acquired, "last preview closed");
    };
    let abort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => {
        release();
        reject(new DevicePreviewError("preview request aborted", 499));
      };
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const context = await Promise.race([acquired.ready, aborted]);
      if (signal.aborted || !this.isCurrent(context)) {
        throw new DevicePreviewError("preview session ended", 503);
      }
      return { context, release };
    } catch (err) {
      release();
      throw err;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const entry of this.#entries.values()) this.#retire(entry, "server stopping");
    while (this.#drains.size > 0) await Promise.allSettled(this.#drains);
  }

  #retire(entry: PreviewEntry<TSession>, reason: string): void {
    if (entry.controller.signal.aborted) return;
    entry.controller.abort(new Error(reason));
    if (this.#entries.get(entry.serial) === entry) this.#entries.delete(entry.serial);
    // Dispose immediately when possible; waiting for ready first would leave
    // already-open sockets live until an extra microtask after shutdown.
    const cleanup = entry.context
      ? entry.context.dispose(reason)
      : entry.ready.then((context) => context.dispose(reason), async () => {
          await entry.context?.dispose(reason);
        });
    this.#drains.add(cleanup);
    void cleanup.finally(() => this.#drains.delete(cleanup)).catch(() => {});
  }
}
