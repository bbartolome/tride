/**
 * Minimal chained-promise mutex. `runExclusive` queues callbacks behind the
 * previous call's completion (success or failure) so at most one runs at a
 * time. This is the whole implementation — no external dependency is worth
 * pulling in for something this small.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => fn());
    // Swallow the outcome here so a failed call never blocks the next one
    // from running; the real result/rejection still flows to the caller
    // through the returned `run` promise.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
