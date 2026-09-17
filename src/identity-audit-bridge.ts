import type { IdentityStore } from "./identity.ts";
import type { LedgerStore } from "./persistence.ts";

/**
 * Replays the identity database's transactional outbox into the public audit
 * cursor. The public projection is idempotent, and acknowledgement happens
 * only afterward, so a crash between databases produces a safe replay.
 */
export class IdentityAuditBridge {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private failures = 0;
  private lastErrorAt: string | null = null;
  private readonly identity: IdentityStore;
  private readonly ledger: LedgerStore;
  private readonly options: { intervalMs?: number; afterPublicProjection?: () => void };

  constructor(
    identity: IdentityStore,
    ledger: LedgerStore,
    options: { intervalMs?: number; afterPublicProjection?: () => void } = {},
  ) {
    this.identity = identity;
    this.ledger = ledger;
    this.options = options;
  }

  start() {
    if (this.timer) return;
    try { this.drain(); } catch { /* diagnostics fail readiness until a later successful drain */ }
    this.timer = setInterval(() => {
      try { this.drain(); } catch { /* the durable event remains pending */ }
    }, this.options.intervalMs ?? 250);
    this.timer.unref();
  }

  diagnostics() {
    return Object.freeze({ healthy: this.lastErrorAt === null, failures: this.failures, lastErrorAt: this.lastErrorAt });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Stop periodic projection and synchronously empty the durable outbox. A
   * caller that has already closed identity-write admission can use this as a
   * cross-database snapshot barrier.
   */
  pause(): number {
    this.stop();
    return this.drain();
  }

  /** Resume periodic projection after a snapshot barrier. */
  resume() {
    this.start();
  }

  drain(maximum = 1_000): number {
    if (this.running) return 0;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 10_000) throw new TypeError("Identity audit drain limit is invalid");
    this.running = true;
    let projected = 0;
    try {
      while (projected < maximum) {
        const [event] = this.identity.pendingAuditProjections(1);
        if (!event) break;
        this.ledger.projectIdentityAudit(event);
        this.options.afterPublicProjection?.();
        this.identity.markAuditProjected(event.id, event.sequence);
        projected += 1;
      }
      this.lastErrorAt = null;
      return projected;
    } catch (error) {
      this.failures += 1;
      this.lastErrorAt = new Date().toISOString();
      throw error;
    } finally {
      this.running = false;
    }
  }
}
