/**
 * Coalesces bursty PTY output into infrequent, larger WebSocket sends, and
 * applies hysteresis-based backpressure against the PTY when the socket
 * can't drain fast enough.
 *
 * Deliberately **pure** — no `ws` or `@lydell/node-pty` import anywhere in
 * this file. It depends only on the small `OutputCoalescerSink` interface
 * below, which is exactly the three primitives it needs (`send`,
 * `bufferedAmount`, `pause`/`resume`). That is what makes it unit-testable
 * with `jest.useFakeTimers()` and no real socket or PTY.
 */
export interface OutputCoalescerSink {
  /** Send one coalesced, concatenated chunk as a binary WebSocket frame. */
  send(data: Buffer): void;
  /** Mirrors `ws.WebSocket#bufferedAmount`. */
  bufferedAmount(): number;
  /** Mirrors `IPty#pause()`. */
  pause(): void;
  /** Mirrors `IPty#resume()`. */
  resume(): void;
}

/** Chunks are batched for this long before being flushed as one send — long
 * enough to coalesce a burst (a full-screen redraw arrives as dozens of tiny
 * writes), short enough that interactive typing still feels instant. */
export const FLUSH_DELAY_MS = 12;

/** Above this many buffered bytes on the socket, stop reading from the PTY.
 * 2 MiB is generous enough that ordinary bursts never trip it, but small
 * enough to bound memory when a client is on a slow/cellular link. */
export const HIGH_WATERMARK_BYTES = 2 * 1024 * 1024;

/** Below this many buffered bytes, resume reading. Deliberately well below
 * the high watermark (hysteresis) so a socket hovering right at 2 MiB
 * doesn't flap pause/resume on every flush. */
export const LOW_WATERMARK_BYTES = 512 * 1024;

/** How often the watchdog re-checks `bufferedAmount` while paused. */
export const WATCHDOG_INTERVAL_MS = 250;

export class OutputCoalescer {
  private queue: Buffer[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private disposed = false;

  constructor(private readonly sink: OutputCoalescerSink) {}

  /** Enqueue one PTY chunk. Arms the flush timer on the first chunk of a
   * batch only — subsequent chunks before the timer fires just extend the
   * same pending batch. */
  push(chunk: Buffer): void {
    if (this.disposed) {
      return;
    }
    this.queue.push(chunk);
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_DELAY_MS);
    }
  }

  /** Sends any buffered output immediately instead of waiting out the batch
   * timer. Call this before reporting an exit: the PTY's dying words are
   * usually the most important bytes of the session (a tmux usage error, a
   * build failure's last line), and they land inside the final unflushed
   * batch. Without this the socket closes on top of them and the terminal
   * just vanishes with no explanation. */
  flushPending(): void {
    if (this.disposed) {
      return;
    }
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  /** Stops all timers and drops any unflushed, unsent data. Call this once
   * the underlying connection is gone. Use `flushPending()` first if the
   * remaining bytes still matter. */
  dispose(): void {
    this.disposed = true;
    this.queue = [];
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private flush(): void {
    this.flushTimer = null;
    if (this.queue.length === 0) {
      return;
    }
    const batch =
      this.queue.length === 1 ? this.queue[0] : Buffer.concat(this.queue);
    this.queue = [];
    this.sink.send(batch);
    this.checkBackpressure();
  }

  private checkBackpressure(): void {
    if (this.paused) {
      // The watchdog owns un-pausing; nothing to do on a send while paused.
      return;
    }
    if (this.sink.bufferedAmount() > HIGH_WATERMARK_BYTES) {
      this.paused = true;
      this.sink.pause();
      this.armWatchdog();
    }
  }

  private armWatchdog(): void {
    if (this.watchdogTimer !== null || this.disposed) {
      return;
    }
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      if (this.disposed || !this.paused) {
        return;
      }
      if (this.sink.bufferedAmount() < LOW_WATERMARK_BYTES) {
        this.paused = false;
        this.sink.resume();
        return;
      }
      // Still congested — keep polling every WATCHDOG_INTERVAL_MS.
      this.armWatchdog();
    }, WATCHDOG_INTERVAL_MS);
  }
}
