import { CANVAS_COMMAND_OPERATION_MAINTENANCE_INTERVAL_MS } from "./limits.js";
import type { CanvasOperationRetention } from "./operationRetention.js";

export class CanvasOperationRetentionMaintenance {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private closed = false;
  private failure: unknown;

  constructor(
    private readonly retention: CanvasOperationRetention,
    private readonly afterBatch: (remainingBudget: number) => Promise<unknown>,
    private readonly intervalMs = CANVAS_COMMAND_OPERATION_MAINTENANCE_INTERVAL_MS
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
      throw new Error("canvas_operation_maintenance_interval_invalid");
    }
  }

  async start(): Promise<void> {
    if (this.closed || this.timer) return;
    await this.run();
    if (this.closed) return;
    this.timer = setInterval(() => {
      void this.run().catch((error: unknown) => {
        this.failure = error;
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
    if (this.failure) throw this.failure;
  }

  private async run(): Promise<void> {
    if (this.closed) return;
    if (this.running) return this.running;
    this.running = Promise.resolve().then(async () => {
      const reconciliation = this.retention.reconcileBatch(100);
      await this.afterBatch(100 - reconciliation.consumed);
    });
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }
}
