import { TerminalSocket, type TerminalConnectionState } from './terminal-socket';

/**
 * Hand-rolled fake `WebSocket`: emits open/message/close/error only when
 * the test tells it to, and records every `send()` call verbatim so tests
 * can assert on the exact bytes/frames `TerminalSocket` produces. This
 * (plus vitest's fake timers) is what makes the entire reconnect/backoff/
 * heartbeat state machine testable with no real browser and no real
 * server.
 */
class FakeWebSocket {
  binaryType = 'blob';
  readyState = 0;
  readonly sent: unknown[] = [];
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {}

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls++;
  }

  emitOpen(): void {
    this.readyState = 1; // WebSocket.OPEN
    this.onopen?.();
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  emitClose(): void {
    this.readyState = 3; // WebSocket.CLOSED
    this.onclose?.();
  }

  emitError(): void {
    this.onerror?.();
  }
}

class FakeDocument {
  visibilityState: 'visible' | 'hidden' = 'visible';
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

function readyMessage(): string {
  return JSON.stringify({
    type: 'ready',
    session: 'wui-000000000000',
    cwd: 'some/repo',
    mode: 'shell',
  });
}

describe('TerminalSocket', () => {
  let sockets: FakeWebSocket[];
  let fakeDocument: FakeDocument;
  let ticketCounter: number;
  let mintTicket: () => Promise<{ ticket: string; expiresAt: number }>;
  let states: TerminalConnectionState[];
  let onBinary: (data: Uint8Array) => void;
  let binaryCalls: Uint8Array[];

  function createSocket(): TerminalSocket {
    return new TerminalSocket(
      'wui-000000000000',
      mintTicket,
      {
        onBinary,
        onState: (s) => states.push(s),
      },
      { cols: 80, rows: 24 },
      {
        wsFactory: (url: string) => {
          const ws = new FakeWebSocket(url);
          sockets.push(ws);
          return ws as unknown as WebSocket;
        },
        document: fakeDocument as unknown as Document,
        location: { protocol: 'http:', host: 'example.test' },
      },
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    fakeDocument = new FakeDocument();
    ticketCounter = 0;
    mintTicket = vi.fn(async () => ({
      ticket: `ticket-${++ticketCounter}`,
      expiresAt: Date.now() + 30000,
    }));
    states = [];
    binaryCalls = [];
    onBinary = (data) => binaryCalls.push(data);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('mints a fresh ticket before every attempt, including reconnects, and embeds it in the URL', async () => {
    const socket = createSocket();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(mintTicket).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toContain('ticket=ticket-1');
    expect(sockets[0].url).toContain('id=wui-000000000000');

    // Fail the first attempt (no `ready` ever arrived) and let the
    // scheduled reconnect run.
    sockets[0].emitClose();
    await vi.advanceTimersByTimeAsync(700); // > max jittered 500ms base

    expect(mintTicket).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].url).toContain('ticket=ticket-2');

    socket.dispose();
  });

  it('follows the exact 500->1000->2000->4000->8000->8000(capped) backoff sequence', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // midpoint -> zero jitter drift

    const socket = createSocket();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);

    const expectedDelays = [500, 1000, 2000, 4000, 8000, 8000];
    for (let i = 0; i < expectedDelays.length; i++) {
      const delay = expectedDelays[i];
      sockets[sockets.length - 1].emitClose();

      // One millisecond short of the expected delay: no new attempt yet.
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sockets).toHaveLength(i + 1);

      // The final millisecond crosses the threshold: exactly one new attempt.
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(i + 2);
    }

    socket.dispose();
  });

  it('applies the documented +/-20% jitter bounds around the base backoff', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // minimum: base * 0.8
    const minSocket = createSocket();
    minSocket.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].emitClose();
    await vi.advanceTimersByTimeAsync(399); // 500 * 0.8 = 400
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    minSocket.dispose();

    sockets = [];
    vi.spyOn(Math, 'random').mockReturnValue(1); // maximum: base * 1.2
    const maxSocket = createSocket();
    maxSocket.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].emitClose();
    await vi.advanceTimersByTimeAsync(599); // 500 * 1.2 = 600
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    maxSocket.dispose();
  });

  it('resets backoff to base only on {type:"ready"} — a bare open does not', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const socket = createSocket();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);

    // Attempt 1 fails outright (no open at all) -> backoff becomes 1000,
    // next delay is 500.
    sockets[0].emitClose();
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(2);

    // Attempt 2: bare `open`, no `ready`, then closes. If open had reset
    // backoff we'd see a 500ms delay again; instead we must see 1000ms —
    // proving open alone did not reset anything.
    sockets[1].emitOpen();
    sockets[1].emitClose();
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);

    // Attempt 3: reaches `ready` this time -> backoff resets to base.
    sockets[2].emitOpen();
    sockets[2].emitMessage(readyMessage());
    expect(states.at(-1)).toBe('ready');
    sockets[2].emitClose();

    // If `ready` had not reset backoff, the next delay would be 2000ms
    // (the natural next step after 500 -> 1000); assert it is 500ms.
    await vi.advanceTimersByTimeAsync(499);
    expect(sockets).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(4);

    socket.dispose();
  });

  it('tears down and reconnects immediately on visibilitychange -> visible, bypassing any pending backoff', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const socket = createSocket();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);

    // Get into a long, pending backoff wait (several failures with no
    // ready in between).
    sockets[0].emitClose();
    await vi.advanceTimersByTimeAsync(500);
    sockets[1].emitClose();
    await vi.advanceTimersByTimeAsync(1000);
    sockets[2].emitClose(); // schedules an 2000ms-out reconnect
    expect(sockets).toHaveLength(3);

    // Foreground the tab well before that 2000ms elapses.
    await vi.advanceTimersByTimeAsync(100);
    fakeDocument.emit('visibilitychange');
    await vi.advanceTimersByTimeAsync(0);

    // A new attempt happened immediately, not 1900ms from now.
    expect(sockets).toHaveLength(4);
    expect(mintTicket).toHaveBeenCalledTimes(4);

    // The old scheduled backoff timer (had it survived) must not also
    // fire and create a duplicate/competing connection.
    await vi.advanceTimersByTimeAsync(5000);
    expect(sockets).toHaveLength(4);

    socket.dispose();
  });

  it('tears down a socket that looks perfectly healthy on visibilitychange -> visible', async () => {
    const socket = createSocket();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].emitOpen();
    sockets[0].emitMessage(readyMessage());
    expect(states.at(-1)).toBe('ready');

    fakeDocument.emit('visibilitychange');
    await vi.advanceTimersByTimeAsync(0);

    expect(sockets[0].closeCalls).toBe(1);
    expect(sockets).toHaveLength(2);
    expect(mintTicket).toHaveBeenCalledTimes(2);

    // The torn-down socket's real close event can still arrive later
    // (async, out of our control) — it must be recognized as stale and
    // must NOT trigger a second, competing reconnect on top of the one
    // already in flight.
    sockets[0].emitClose();
    await vi.advanceTimersByTimeAsync(20000);
    expect(sockets).toHaveLength(2);
    expect(mintTicket).toHaveBeenCalledTimes(2);

    socket.dispose();
  });

  it('delivers inbound binary frames to onBinary as an untouched Uint8Array', async () => {
    const socket = createSocket();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].emitOpen();

    const bytes = new Uint8Array([0xf0, 0x9f, 0x98, 0x80]); // an emoji's UTF-8 bytes
    sockets[0].emitMessage(bytes.buffer);

    expect(binaryCalls).toHaveLength(1);
    // Not a strict `toBeInstanceOf(Uint8Array)` — under vitest's jsdom
    // environment, `TextEncoder`/typed-array globals used by production
    // code and the test file's own `Uint8Array` global can be
    // structurally identical but cross-realm distinct objects (a jsdom
    // environment quirk, not a real bug: in an actual browser they are
    // the same realm). `ArrayBuffer.isView` plus the constructor name are
    // realm-agnostic.
    expect(ArrayBuffer.isView(binaryCalls[0])).toBe(true);
    expect(binaryCalls[0].constructor.name).toBe('Uint8Array');
    expect(Array.from(binaryCalls[0])).toEqual(Array.from(bytes));

    socket.dispose();
  });

  it('sends outbound input as a binary Uint8Array frame, never text/JSON', async () => {
    const socket = createSocket();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].emitOpen();
    sockets[0].emitMessage(readyMessage());

    socket.sendInput('ls -la\n');

    const sent = sockets[0].sent;
    const inputFrame = sent[sent.length - 1];
    // See the inbound-binary test for why this isn't a strict
    // `toBeInstanceOf(Uint8Array)` (a jsdom/vitest cross-realm quirk, not
    // a real bug).
    expect(typeof inputFrame).not.toBe('string');
    expect(ArrayBuffer.isView(inputFrame)).toBe(true);
    expect((inputFrame as Uint8Array).constructor.name).toBe('Uint8Array');
    expect(new TextDecoder().decode(inputFrame as Uint8Array)).toBe('ls -la\n');

    socket.dispose();
  });

  it('drops input typed before the attach handshake completes, rather than risking a protocol-violation close', async () => {
    // The server 1008-closes a connection whose first frame after `open`
    // isn't the JSON `attach` message — a binary frame arriving in the
    // gap between raw `open` and `{type:'ready'}` would trip exactly
    // that. A user typing fast in that instant must not be able to
    // trigger it.
    const socket = createSocket();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].emitOpen();

    socket.sendInput('too fast');

    // Only the attach frame (JSON text) went out — no binary frame.
    expect(sockets[0].sent).toHaveLength(1);
    expect(typeof sockets[0].sent[0]).toBe('string');

    socket.dispose();
  });

  it('never decodes attach/resize/ping control frames as anything but JSON text', async () => {
    const socket = createSocket();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].emitOpen();

    const attachFrame = sockets[0].sent[0];
    expect(typeof attachFrame).toBe('string');
    expect(JSON.parse(attachFrame as string)).toEqual({ type: 'attach', cols: 80, rows: 24 });

    socket.dispose();
  });

  it('force-closes and lets the normal reconnect path run when no pong arrives within the window', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const socket = createSocket();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].emitOpen();
    sockets[0].emitMessage(readyMessage());

    // First ping goes out ~15s after ready.
    await vi.advanceTimersByTimeAsync(15000);
    const pingFrame = sockets[0].sent.find((f) => typeof f === 'string' && f.includes('"ping"'));
    expect(pingFrame).toBeDefined();
    expect(sockets[0].closeCalls).toBe(0);

    // No pong within 5s -> force close.
    await vi.advanceTimersByTimeAsync(5000);
    expect(sockets[0].closeCalls).toBe(1);

    // The server (or, here, the test) actually completing the close is
    // what drives the normal backoff-scheduled reconnect.
    sockets[0].emitClose();
    await vi.advanceTimersByTimeAsync(700);
    expect(sockets).toHaveLength(2);
    expect(mintTicket).toHaveBeenCalledTimes(2);

    socket.dispose();
  });

  it('does not force-close when a pong arrives in time, and keeps the heartbeat going', async () => {
    const socket = createSocket();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].emitOpen();
    sockets[0].emitMessage(readyMessage());

    await vi.advanceTimersByTimeAsync(15000);
    sockets[0].emitMessage(JSON.stringify({ type: 'pong' }));

    await vi.advanceTimersByTimeAsync(5000); // would have force-closed without the pong
    expect(sockets[0].closeCalls).toBe(0);

    socket.dispose();
  });

  it('sends a resize control frame immediately when attached, and stops after dispose', async () => {
    const socket = createSocket();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].emitOpen();
    sockets[0].emitMessage(readyMessage());

    socket.resize(120, 40);
    const resizeFrame = sockets[0].sent.find(
      (f) => typeof f === 'string' && f.includes('"resize"'),
    );
    expect(resizeFrame).toBeDefined();
    expect(JSON.parse(resizeFrame as string)).toEqual({ type: 'resize', cols: 120, rows: 40 });

    socket.dispose();
    expect(sockets[0].closeCalls).toBe(1);

    // No further reconnects after dispose.
    await vi.advanceTimersByTimeAsync(20000);
    expect(sockets).toHaveLength(1);
  });
});
