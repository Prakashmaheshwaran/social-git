import type { SocialGitService } from "./service.ts";

export class SequentialActionWorker {
  private readonly service: SocialGitService;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private paused = false;
  private processed = 0;

  constructor(service: SocialGitService, options: { intervalMs?: number } = {}) {
    this.service = service;
    this.intervalMs = options.intervalMs ?? 250;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 25 || this.intervalMs > 60_000) {
      throw new TypeError("Action worker interval must be from 25 through 60000 milliseconds");
    }
  }

  start() {
    if (this.stopped || this.paused || this.timer) return;
    this.timer = setInterval(() => this.wake(), this.intervalMs);
    this.timer.unref();
    this.wake();
  }

  wake() {
    if (this.stopped || this.paused || this.running) return;
    this.running = this.drainOne().catch(() => undefined).finally(() => { this.running = null; });
  }

  diagnostics() {
    return Object.freeze({ running: !this.stopped, paused: this.paused, busy: this.running !== null, processed: this.processed });
  }

  async pause() {
    if (this.stopped) return;
    this.paused = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  resume() {
    if (this.stopped || !this.paused) return;
    this.paused = false;
    this.start();
  }

  async stop() {
    this.stopped = true;
    this.paused = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  private async drainOne() {
    const action = await this.service.runNextAction();
    if (action) this.processed += 1;
  }
}
