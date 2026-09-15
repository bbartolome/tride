/**
 * `TerminalSocket` — the WS attach/reconnect state machine for one
 * terminal session. Deliberately a **plain class, not a component**: it
 * takes an injected `wsFactory` (so tests never open a real socket) and an
 * injected `Clock` (so tests never wait on a real timer). That is the only
 * thing that makes the reconnect/backoff/heartbeat logic below testable
 * without a real browser or a real server (see `terminal-socket.spec.ts`).
 *
 * Framing (mirrors `terminal/terminal.ws.ts` in the API package exactly):
 *  - text frames are JSON control messages
 *  - binary frames are raw PTY bytes, delivered to `onBinary` as a
 *    `Uint8Array` — NEVER decoded to a string first. xterm 6's `write()`
 *    takes a `Uint8Array` directly and its parser correctly reassembles a
 *    UTF-8 sequence split across frame boundaries; a string round-trip
 *    here would corrupt binary output (mirrors F133's care on the server
 *    side).
 *  - outbound keystrokes are sent as a **binary** frame
 *    (`TextEncoder().encode(...)`), never JSON-wrapped.
 *
 * Ticketing (F114/F128/F130): every connection attempt — the first one and
 * every reconnect — mints a **fresh** single-use, 30s ticket via
 * `POST /api/terminals/:id/ticket` before opening the socket. Tickets are
 * single-use, so re-presenting one on a reconnect would be rejected; this
 * is why `mintTicket` is called from inside `connect()` itself rather than
 * once up front. The identity-header path the server also accepts is not
 * used here on purpose: whether Tailscale Serve forwards identity headers
 * through a WebSocket upgrade is unverified without a live tailnet, while
 * the ticket path is verified to work in every environment.
 *
 * Reconnect:
 *  - backoff starts at `BASE_BACKOFF_MS`, doubles on each failed attempt,
 *    capped at `MAX_BACKOFF_MS`, with +/-20% jitter
 *  - backoff resets to base ONLY on receiving `{type:'ready'}` — a bare
 *    `open` event does not prove the attach round-trip succeeded (the
 *    server could still 1008-close on an invalid first frame), so it must
 *    not be trusted to mean "the connection is healthy"
 *  - `visibilitychange` -> visible tears down whatever socket exists (even
 *    one that "looks fine") and reconnects **immediately**, bypassing any
 *    pending backoff wait — iOS can kill a backgrounded socket without
 *    ever firing `close`, so a socket that looks open on resume cannot be
 *    trusted. This is the single most important line in this file.
 *  - a client-driven heartbeat (`{type:'ping'}` every ~15s) guards against
 *    exactly that: if no `{type:'pong'}` arrives within 5s, the socket is
 *    force-closed and the normal close-triggered backoff reconnect runs.
 *    The server never initiates a ping (see `terminal.ws.ts`), so this
 *    guard exists only on the client.
 *  - no replay buffer: tmux repaints the pane on reattach, so there is
 *    nothing to buffer across a reconnect.
 */

export type TerminalConnectionState =
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'closed';

export interface MintedTicketLike {
  ticket: string;
  expiresAt: number;
}

export interface TerminalReadyInfo {
  session: string;
  cwd: string;
  mode: string;
}

export interface TerminalSocketCallbacks {
  /** Raw PTY bytes. Passed through untouched — never decode to a string. */
  onBinary: (data: Uint8Array) => void;
  onState?: (state: TerminalConnectionState) => void;
  onReady?: (info: TerminalReadyInfo) => void;
  onExit?: (exitCode: number) => void;
}

/** Minimal timer seam — the thing that makes backoff/heartbeat testable
 * under vitest's fake timers without any real waiting. */
export interface Clock {
  setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export const REAL_CLOCK: Clock = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

const BASE_BACKOFF_MS = 500;
const BACKOFF_FACTOR = 2;
const MAX_BACKOFF_MS = 8000;
const JITTER_RATIO = 0.2;
const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_TIMEOUT_MS = 5000;

interface AttachDims {
  cols: number;
  rows: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class TerminalSocket {
  private readonly wsFactory: (url: string) => WebSocket;
  private readonly clock: Clock;
  private readonly documentRef: Document | undefined;
  private readonly locationRef: { protocol: string; host: string };

  private ws: WebSocket | null = null;
  private generation = 0;
  private disposed = false;
  private backoffMs = BASE_BACKOFF_MS;
  private state: TerminalConnectionState = 'connecting';
  private dims: AttachDims;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly onVisibilityChange = (): void => {
    if (this.documentRef?.visibilityState === 'visible') {
      this.forceReconnect();
    }
  };

  constructor(
    private readonly terminalId: string,
    private readonly mintTicket: () => Promise<MintedTicketLike>,
    private readonly callbacks: TerminalSocketCallbacks,
    initialDims: AttachDims,
    options?: {
      wsFactory?: (url: string) => WebSocket;
      clock?: Clock;
      document?: Document;
      location?: { protocol: string; host: string };
    },
  ) {
    this.wsFactory =
      options?.wsFactory ?? ((url: string) => new WebSocket(url));
    this.clock = options?.clock ?? REAL_CLOCK;
    this.dims = { ...initialDims };
    this.documentRef =
      options?.document ?? (typeof document !== 'undefined' ? document : undefined);
    this.locationRef =
      options?.location ??
      (typeof location !== 'undefined'
        ? { protocol: location.protocol, host: location.host }
        : { protocol: 'http:', host: 'localhost' });
    this.documentRef?.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  /** Kicks off the first connection attempt. Call once. */
  start(): void {
    void this.connect();
  }

  /** Sends one input chunk as a binary frame — the SAME path real xterm
   * keystrokes and the mobile key-bar both go through, by construction:
   * both callers end up calling this one method, never `ws.send()`
   * directly. No-ops silently if the socket isn't open OR the attach
   * handshake hasn't completed yet (no replay buffer, see class doc) —
   * this is not just "safe to skip", it is REQUIRED: the server's first
   * frame on a connection must be the JSON `attach` message, and a
   * binary frame arriving before that is a protocol violation that gets
   * the socket 1008-closed outright (see `terminal.ws.ts`). A user typing
   * fast in the instant between raw `open` and the server's `{type:
   * 'ready'}` must not be able to trigger that. */
  sendInput(data: string): void {
    if (this.state === 'ready' && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(new TextEncoder().encode(data));
    }
  }

  /** Updates the stored terminal geometry and, if attached, sends a
   * `resize` control frame immediately. The stored dims are also what the
   * next `attach` frame (on any future reconnect) will use. */
  resize(cols: number, rows: number): void {
    this.dims = { cols, rows };
    if (this.state === 'ready' && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }

  /** Tears everything down permanently: no further reconnects, timers
   * cleared, listener removed, socket closed. */
  dispose(): void {
    this.disposed = true;
    this.documentRef?.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.clearReconnectTimer();
    this.clearHeartbeat();
    this.generation++;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // Already gone.
      }
    }
    this.setState('closed');
  }

  private setState(state: TerminalConnectionState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.callbacks.onState?.(state);
  }

  private buildUrl(ticket: string): string {
    const proto = this.locationRef.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams({ id: this.terminalId, ticket });
    return `${proto}//${this.locationRef.host}/ws/term?${params.toString()}`;
  }

  private async connect(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const myGeneration = ++this.generation;
    this.setState('connecting');

    let ticket: MintedTicketLike;
    try {
      // A FRESH ticket on every single attempt, including reconnects
      // (F114) — tickets are single-use, so reusing one across a
      // reconnect would be rejected by the server.
      ticket = await this.mintTicket();
    } catch {
      if (this.disposed || myGeneration !== this.generation) {
        return;
      }
      this.setState('reconnecting');
      this.scheduleReconnect();
      return;
    }
    if (this.disposed || myGeneration !== this.generation) {
      return;
    }

    const ws = this.wsFactory(this.buildUrl(ticket.ticket));
    // MUST be set before the socket can deliver any frame — the default
    // 'blob' binaryType forces an async unwrap and this is cheaper and
    // simpler to reason about.
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    let settled = false;
    const onCloseOrError = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (myGeneration !== this.generation) {
        // Stale — superseded by a later connect() (e.g. a forced
        // visibilitychange reconnect). Ignore entirely so we never
        // schedule a second, competing reconnect.
        return;
      }
      this.clearHeartbeat();
      if (this.ws === ws) {
        this.ws = null;
      }
      if (this.disposed) {
        this.setState('closed');
        return;
      }
      this.setState('reconnecting');
      this.scheduleReconnect();
    };

    ws.onopen = () => {
      if (myGeneration !== this.generation || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      // Bare `open` does NOT prove the attach round-trip succeeded — do
      // not reset backoff here. Send the attach frame; backoff only
      // resets once `{type:'ready'}` actually arrives.
      ws.send(
        JSON.stringify({ type: 'attach', cols: this.dims.cols, rows: this.dims.rows }),
      );
    };

    ws.onmessage = (event: MessageEvent) => {
      if (myGeneration !== this.generation) {
        return;
      }
      this.handleMessage(ws, event.data as unknown);
    };

    ws.onclose = onCloseOrError;
    ws.onerror = onCloseOrError;
  }

  private handleMessage(ws: WebSocket, data: unknown): void {
    if (data instanceof ArrayBuffer) {
      // Raw PTY bytes — straight to the callback as a Uint8Array, no
      // string round-trip (would corrupt multi-byte UTF-8 split across
      // frames).
      this.callbacks.onBinary(new Uint8Array(data));
      return;
    }
    if (typeof data !== 'string') {
      return;
    }
    const parsed = safeParseJson(data);
    if (!isPlainObject(parsed) || typeof parsed['type'] !== 'string') {
      return;
    }
    switch (parsed['type']) {
      case 'ready': {
        // The ONLY event that resets backoff to base (see class doc).
        this.backoffMs = BASE_BACKOFF_MS;
        this.setState('ready');
        this.armNextPing(ws);
        if (
          typeof parsed['session'] === 'string' &&
          typeof parsed['cwd'] === 'string' &&
          typeof parsed['mode'] === 'string'
        ) {
          this.callbacks.onReady?.({
            session: parsed['session'],
            cwd: parsed['cwd'],
            mode: parsed['mode'],
          });
        }
        return;
      }
      case 'pong': {
        this.clearPongTimer();
        this.armNextPing(ws);
        return;
      }
      case 'exit': {
        const exitCode =
          typeof parsed['exitCode'] === 'number' ? parsed['exitCode'] : -1;
        this.callbacks.onExit?.(exitCode);
        return;
      }
      default:
        return;
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) {
      return;
    }
    const delay = this.jitter(this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * BACKOFF_FACTOR, MAX_BACKOFF_MS);
    this.clearReconnectTimer();
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private jitter(base: number): number {
    const spread = base * JITTER_RATIO;
    return base - spread + Math.random() * spread * 2;
  }

  /**
   * `visibilitychange` -> visible. Tears down whatever socket exists
   * (even one that "looks fine") and reconnects immediately, WITHOUT
   * going through `scheduleReconnect()` — this is the bypass-backoff
   * path (the single most important line in this file). Bumping the
   * generation inside `connect()` (called synchronously below, before
   * any `await`) is what makes the old socket's eventual close/error a
   * no-op rather than a second, competing reconnect.
   */
  private forceReconnect(): void {
    if (this.disposed) {
      return;
    }
    this.clearReconnectTimer();
    this.clearHeartbeat();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // Already gone.
      }
    }
    void this.connect();
  }

  /** Arms the NEXT ping, ~15s out. Called once a connection reaches
   * `ready`, and again every time a `pong` actually arrives — so there is
   * only ever one ping/pong cycle in flight at a time. */
  private armNextPing(ws: WebSocket): void {
    this.clearHeartbeatTimerOnly();
    this.heartbeatTimer = this.clock.setTimeout(
      () => this.sendPing(ws),
      HEARTBEAT_INTERVAL_MS,
    );
  }

  private sendPing(ws: WebSocket): void {
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify({ type: 'ping' }));
    this.clearPongTimer();
    this.pongTimer = this.clock.setTimeout(() => {
      this.pongTimer = null;
      // No pong within the window — the server never initiates a ping
      // (see terminal.ws.ts), so a silent socket here means the
      // connection is dead even though nothing has told us so yet.
      // Force-close and let the NORMAL close-triggered backoff reconnect
      // run — this is a suspected failure, not a confirmed foreground
      // resume, so it does not bypass backoff the way forceReconnect()
      // does.
      if (this.ws === ws) {
        try {
          ws.close();
        } catch {
          // Already gone.
        }
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      this.clock.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHeartbeat(): void {
    this.clearHeartbeatTimerOnly();
    this.clearPongTimer();
  }

  private clearHeartbeatTimerOnly(): void {
    if (this.heartbeatTimer !== null) {
      this.clock.clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearPongTimer(): void {
    if (this.pongTimer !== null) {
      this.clock.clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }
}
