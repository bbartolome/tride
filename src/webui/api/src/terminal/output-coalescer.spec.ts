import {
  FLUSH_DELAY_MS,
  HIGH_WATERMARK_BYTES,
  LOW_WATERMARK_BYTES,
  OutputCoalescer,
  WATCHDOG_INTERVAL_MS,
} from './output-coalescer';

/** Fake sink: records every `send` and lets a test dictate `bufferedAmount`
 * so backpressure can be exercised deterministically with no real socket. */
function createSink() {
  let buffered = 0;
  return {
    sends: [] as Buffer[],
    pauseCalls: 0,
    resumeCalls: 0,
    setBufferedAmount(n: number) {
      buffered = n;
    },
    send(data: Buffer) {
      this.sends.push(data);
    },
    bufferedAmount() {
      return buffered;
    },
    pause() {
      this.pauseCalls++;
    },
    resume() {
      this.resumeCalls++;
    },
  };
}

describe('OutputCoalescer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('coalesces N chunks pushed in one tick into exactly one concatenated send after the flush delay', () => {
    const sink = createSink();
    const coalescer = new OutputCoalescer(sink);

    coalescer.push(Buffer.from('ab'));
    coalescer.push(Buffer.from('cd'));
    coalescer.push(Buffer.from('ef'));

    // Nothing sent yet — still within the same batch window.
    expect(sink.sends).toHaveLength(0);

    jest.advanceTimersByTime(FLUSH_DELAY_MS);

    expect(sink.sends).toHaveLength(1);
    expect(sink.sends[0].toString('utf8')).toBe('abcdef');

    coalescer.dispose();
  });

  it('arms only one flush timer per batch — a second push before the timer fires does not schedule a second flush', () => {
    const sink = createSink();
    const coalescer = new OutputCoalescer(sink);

    coalescer.push(Buffer.from('x'));
    expect(jest.getTimerCount()).toBe(1);
    coalescer.push(Buffer.from('y'));
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(FLUSH_DELAY_MS);
    expect(sink.sends).toHaveLength(1);

    coalescer.dispose();
  });

  it('starts a fresh batch (and timer) after a flush has already fired', () => {
    const sink = createSink();
    const coalescer = new OutputCoalescer(sink);

    coalescer.push(Buffer.from('first'));
    jest.advanceTimersByTime(FLUSH_DELAY_MS);
    expect(sink.sends).toHaveLength(1);

    coalescer.push(Buffer.from('second'));
    jest.advanceTimersByTime(FLUSH_DELAY_MS);
    expect(sink.sends).toHaveLength(2);
    expect(sink.sends[1].toString('utf8')).toBe('second');

    coalescer.dispose();
  });

  it('does not send anything if the batch is flushed with an empty queue', () => {
    const sink = createSink();
    const coalescer = new OutputCoalescer(sink);
    // No push at all — nothing should ever fire.
    jest.advanceTimersByTime(FLUSH_DELAY_MS * 5);
    expect(sink.sends).toHaveLength(0);
    coalescer.dispose();
  });

  it('pauses once bufferedAmount exceeds the high watermark after a send', () => {
    const sink = createSink();
    const coalescer = new OutputCoalescer(sink);

    sink.setBufferedAmount(HIGH_WATERMARK_BYTES + 1);
    coalescer.push(Buffer.from('chunk'));
    jest.advanceTimersByTime(FLUSH_DELAY_MS);

    expect(sink.pauseCalls).toBe(1);
    expect(sink.resumeCalls).toBe(0);

    coalescer.dispose();
  });

  it('does not pause when bufferedAmount stays at or below the high watermark', () => {
    const sink = createSink();
    const coalescer = new OutputCoalescer(sink);

    sink.setBufferedAmount(HIGH_WATERMARK_BYTES);
    coalescer.push(Buffer.from('chunk'));
    jest.advanceTimersByTime(FLUSH_DELAY_MS);

    expect(sink.pauseCalls).toBe(0);

    coalescer.dispose();
  });

  it('resumes via the watchdog once bufferedAmount drops below the low watermark', () => {
    const sink = createSink();
    const coalescer = new OutputCoalescer(sink);

    sink.setBufferedAmount(HIGH_WATERMARK_BYTES + 1);
    coalescer.push(Buffer.from('chunk'));
    jest.advanceTimersByTime(FLUSH_DELAY_MS);
    expect(sink.pauseCalls).toBe(1);

    // Still congested at the first watchdog tick — no resume yet.
    sink.setBufferedAmount(LOW_WATERMARK_BYTES + 1);
    jest.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
    expect(sink.resumeCalls).toBe(0);

    // Drains below the low watermark by the next tick.
    sink.setBufferedAmount(LOW_WATERMARK_BYTES - 1);
    jest.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
    expect(sink.resumeCalls).toBe(1);
    expect(sink.pauseCalls).toBe(1);

    coalescer.dispose();
  });

  it('does not flap: exactly one pause/resume cycle even with several sends while congested', () => {
    const sink = createSink();
    const coalescer = new OutputCoalescer(sink);

    sink.setBufferedAmount(HIGH_WATERMARK_BYTES + 1);
    coalescer.push(Buffer.from('a'));
    jest.advanceTimersByTime(FLUSH_DELAY_MS);
    coalescer.push(Buffer.from('b'));
    jest.advanceTimersByTime(FLUSH_DELAY_MS);
    coalescer.push(Buffer.from('c'));
    jest.advanceTimersByTime(FLUSH_DELAY_MS);

    // Still above the high watermark the whole time, but pause() must only
    // ever be called once per congestion episode, not once per send.
    expect(sink.pauseCalls).toBe(1);
    expect(sink.resumeCalls).toBe(0);

    sink.setBufferedAmount(0);
    jest.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
    expect(sink.resumeCalls).toBe(1);
    expect(sink.pauseCalls).toBe(1);

    coalescer.dispose();
  });

  it('dispose() clears pending timers so nothing fires afterward', () => {
    const sink = createSink();
    const coalescer = new OutputCoalescer(sink);

    coalescer.push(Buffer.from('never sent'));
    coalescer.dispose();

    jest.advanceTimersByTime(FLUSH_DELAY_MS + WATCHDOG_INTERVAL_MS * 3);
    expect(sink.sends).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('dispose() while paused stops the watchdog from ever resuming', () => {
    const sink = createSink();
    const coalescer = new OutputCoalescer(sink);

    sink.setBufferedAmount(HIGH_WATERMARK_BYTES + 1);
    coalescer.push(Buffer.from('chunk'));
    jest.advanceTimersByTime(FLUSH_DELAY_MS);
    expect(sink.pauseCalls).toBe(1);

    coalescer.dispose();
    sink.setBufferedAmount(0);
    jest.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 5);
    expect(sink.resumeCalls).toBe(0);
  });
});
