export class RateLimiter {
  private pending: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSent = 0;

  constructor(private intervalMs: number = 1500) {}

  schedule(fn: () => void): void {
    const now = Date.now();
    const elapsed = now - this.lastSent;

    if (elapsed >= this.intervalMs) {
      // Can send immediately
      this.lastSent = now;
      fn();
    } else {
      // Queue for later, replacing any pending update
      this.pending = fn;

      if (!this.timer) {
        const delay = this.intervalMs - elapsed;
        this.timer = setTimeout(() => {
          this.timer = null;
          if (this.pending) {
            this.lastSent = Date.now();
            const pendingFn = this.pending;
            this.pending = null;
            pendingFn();
          }
        }, delay);
      }
    }
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
      fn();
    }
  }
}
