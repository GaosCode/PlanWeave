import type { RemoteOperationRetentionResult } from "./remoteOperationRetention.js";

export const REMOTE_OPERATION_RETENTION_INTERVAL_MS = 60_000;
export const REMOTE_OPERATION_RETENTION_IDLE_MAX_INTERVAL_MS = 5 * 60_000;

export class RemoteCoordinationMaintenance {
  private timer: ReturnType<typeof setInterval> | undefined;
  private retentionTimer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private retentionRunning: Promise<void> | undefined;
  private failure: { error: unknown } | undefined;
  private retentionFailure: { error: unknown } | undefined;
  private retentionDelay = REMOTE_OPERATION_RETENTION_INTERVAL_MS;
  private closed = false;

  constructor(
    private readonly reconcile: () => Promise<unknown>,
    private readonly intervalMs: number,
    private readonly compactRetention?: () =>
      | RemoteOperationRetentionResult
      | Promise<RemoteOperationRetentionResult>
  ) {}

  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => this.runCoordination(), this.intervalMs);
    this.timer.unref?.();
    this.scheduleRetention();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retentionTimer) clearTimeout(this.retentionTimer);
    this.timer = undefined;
    this.retentionTimer = undefined;
    await Promise.all([this.running, this.retentionRunning]);
    const failures = [this.failure, this.retentionFailure].filter((error) => error !== undefined);
    if (failures.length === 1) throw failures[0]!.error;
    if (failures.length > 1) {
      throw new AggregateError(
        failures.map((failure) => failure!.error),
        "remote_coordination_maintenance_failed"
      );
    }
  }

  private runCoordination(): void {
    if (this.closed || this.running) return;
    this.running = Promise.resolve()
      .then(() => this.reconcile())
      .then(
        () => {
          this.failure = undefined;
        },
        (error: unknown) => {
          this.failure = { error };
        }
      )
      .then(() => {
        this.running = undefined;
      });
  }

  private scheduleRetention(): void {
    if (this.closed || !this.compactRetention) return;
    this.retentionTimer = setTimeout(() => {
      this.retentionTimer = undefined;
      this.runRetention();
    }, this.retentionDelay);
    this.retentionTimer.unref?.();
  }

  private runRetention(): void {
    const compact = this.compactRetention;
    if (this.closed || this.retentionRunning || !compact) return;
    this.retentionRunning = Promise.resolve()
      .then(() => compact())
      .then(
        (result) => {
          this.retentionFailure = undefined;
          // Empty means this bounded page has no eligible rows. Keep polling:
          // another scope or a later page can still contain pending compaction.
          this.retentionDelay =
            result.compacted > 0
              ? REMOTE_OPERATION_RETENTION_INTERVAL_MS
              : Math.min(this.retentionDelay * 2, REMOTE_OPERATION_RETENTION_IDLE_MAX_INTERVAL_MS);
        },
        (error: unknown) => {
          this.retentionFailure = { error };
          this.retentionDelay = REMOTE_OPERATION_RETENTION_INTERVAL_MS;
        }
      )
      .then(() => {
        this.retentionRunning = undefined;
        this.scheduleRetention();
      });
  }
}
