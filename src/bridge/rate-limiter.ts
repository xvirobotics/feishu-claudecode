export class RateLimiter {
  private pending: (() => unknown | Promise<unknown>) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSent = 0;
  // Cumulative promise representing "all thunks ever fired that have not
  // been awaited-through by flush/cancelAndWait yet". We chain every fired
  // thunk into this so the ordering guarantee holds even when thunk A is
  // still in-flight while thunk B fires on a later immediate-path call
  // (thunk duration > intervalMs). Without this chaining, inFlight would
  // only track the last thunk and flush() could return while an older
  // stale update is still landing on the server — the bug that made
  // multi-turn frozen cards revert to thinking/running state.
  private inFlight: Promise<unknown> = Promise.resolve();
  // When paused, schedule() is a silent no-op and any pending thunk is
  // dropped. Designed for short critical sections (e.g. recreateCard, where
  // the caller briefly owns card-state transitions) in which ANY new
  // updateCard would reference closure-captured state that is about to
  // become stale — replaying such thunks after resume would reintroduce
  // the very freeze-race that flush() alone cannot close. See PR #12.
  private paused = false;

  constructor(private intervalMs: number = 1500) {}

  // Thunks may return a value or a Promise. For ordering guarantees (see
  // `flush`), callers that want the server side to quiesce must return the
  // underlying Promise from the thunk; a thunk returning undefined will still
  // throttle correctly but offers no ordering guarantee for its work.
  schedule(fn: () => unknown | Promise<unknown>): void {
    // Silent drop while paused — we do NOT queue for resume because the
    // thunk's closure typically captures variables (messageId, lastState)
    // that the pausing caller is about to invalidate. Queuing would
    // replay a stale update after resume and defeat the purpose.
    if (this.paused) return;
    const now = Date.now();
    const elapsed = now - this.lastSent;

    if (elapsed >= this.intervalMs) {
      // Can send immediately
      this.lastSent = now;
      this.track(fn());
    } else {
      // Queue for later, replacing any pending update
      this.pending = fn;

      if (!this.timer) {
        const delay = this.intervalMs - elapsed;
        this.timer = setTimeout(() => {
          this.timer = null;
          // Pause can land while the timer is armed; in that case we
          // already cleared `pending` in pause(), but a double-guard keeps
          // the timer fully inert.
          if (this.paused) return;
          if (this.pending) {
            this.lastSent = Date.now();
            const pendingFn = this.pending;
            this.pending = null;
            this.track(pendingFn());
          }
        }, delay);
      }
    }
  }

  /**
   * Chain this thunk's result into the cumulative inFlight promise so flush()
   * waits for every unsettled thunk, not just the latest. Thunks still
   * execute concurrently on the network; the chain is only for tracking.
   * Each individual promise is `.catch`-ed to undefined so a rejected thunk
   * never leaves inFlight in a rejected state (which would poison flush and
   * potentially surface as an unhandled rejection).
   */
  private track(result: unknown | Promise<unknown>): void {
    const p = Promise.resolve(result).catch(() => undefined);
    this.inFlight = Promise.all([this.inFlight, p]).then(() => undefined);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending) {
      const fn = this.pending;
      this.pending = null;
      this.lastSent = Date.now();
      this.track(fn());
    }
    // Snapshot the cumulative promise before awaiting so a concurrent
    // schedule() can extend inFlight without us clobbering its work.
    const snapshot = this.inFlight;
    await snapshot;
    if (this.inFlight === snapshot) {
      this.inFlight = Promise.resolve();
    }
  }

  /** Discard any pending update without executing it. */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }

  /**
   * Cancel pending update and wait until enough time has passed since the last
   * successfully sent update. Also awaits all in-flight thunks so the next
   * direct send can't lose an ordering race with any of them.
   */
  async cancelAndWait(): Promise<void> {
    this.cancel();
    const snapshot = this.inFlight;
    await snapshot;
    if (this.inFlight === snapshot) {
      this.inFlight = Promise.resolve();
    }
    const elapsed = Date.now() - this.lastSent;
    if (elapsed < this.intervalMs) {
      await new Promise((r) => setTimeout(r, this.intervalMs - elapsed));
    }
  }

  /**
   * Stop accepting new work. Any pending (queued) thunk is dropped and the
   * deferred timer is cleared. In-flight thunks are intentionally NOT
   * cancelled — the caller typically awaits flush() before pausing, and
   * any lingering requests will settle into the inFlight chain. New
   * schedule() calls during the paused window become silent no-ops.
   *
   * Intended lifecycle:
   *   await rateLimiter.flush();   // drain anything queued/fired pre-pause
   *   rateLimiter.pause();         // close the window
   *   try { ...critical section... }
   *   finally { rateLimiter.resume(); }
   */
  pause(): void {
    this.paused = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }

  /**
   * Reopen the limiter. We deliberately do NOT replay anything dropped
   * during the pause — callers rely on pause() to ELIDE stale updates, not
   * defer them. After resume, the next schedule() observes the normal
   * throttling rules; lastSent is preserved so the immediate-path interval
   * still applies relative to the pre-pause send.
   */
  resume(): void {
    this.paused = false;
  }

  /** Exposed for tests / diagnostics. */
  isPaused(): boolean {
    return this.paused;
  }
}
