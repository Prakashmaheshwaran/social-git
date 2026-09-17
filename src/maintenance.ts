/**
 * Coordinates short Core maintenance windows without exposing filesystem or
 * key custody outside the Core process.
 */
export class RuntimeMaintenanceGate {
  private activeRequests = 0;
  private maintenance = false;
  private waiters: Array<() => void> = [];

  get active() { return this.maintenance; }

  /** Enter ordinary runtime work, or return null while maintenance is active. */
  tryEnter(): (() => void) | null {
    if (this.maintenance) return null;
    this.activeRequests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeRequests -= 1;
      if (this.activeRequests === 0) {
        const waiters = this.waiters;
        this.waiters = [];
        for (const resolve of waiters) resolve();
      }
    };
  }

  /**
   * Close admission first, wait for already admitted requests, pause background
   * writers, and then execute one maintenance callback.
   */
  async runExclusive<T>(options: {
    pause: () => Promise<void>;
    resume: () => void;
    task: () => Promise<T> | T;
  }): Promise<T> {
    if (this.maintenance) throw new Error("maintenance already active");
    this.maintenance = true;
    try {
      if (this.activeRequests > 0) {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
      await options.pause();
      return await options.task();
    } finally {
      try { options.resume(); }
      finally { this.maintenance = false; }
    }
  }
}
