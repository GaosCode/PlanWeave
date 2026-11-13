import {
  type AgentHostTerminalCompactionRepository,
  type TerminalCompactionCursor,
  TERMINAL_MAINTENANCE_INTERVAL_MS
} from "./agentHostTerminalCompaction.js";

type MaintenanceTimer = ReturnType<typeof setTimeout>;
const yieldDelayMs = 1;

export class AgentHostTerminalMaintenance {
  private closed = false;
  private requested = false;
  private cursor?: TerminalCompactionCursor;
  private timer?: { handle: MaintenanceTimer; work: boolean };
  private retryAt?: number;
  private warned = false;

  constructor(private readonly repository: AgentHostTerminalCompactionRepository) {}

  start(): void {
    const batch = this.repository.compact();
    this.cursor = batch.nextCandidate;
    this.scheduleNext(batch.needsPruning || this.cursor !== undefined);
  }

  request(): void {
    if (this.closed) return;
    this.requested = true;
    if (!this.timer?.work && this.retryAt === undefined) this.schedule(true, yieldDelayMs);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer.handle);
    this.timer = undefined;
  }

  private scheduleNext(work: boolean): void {
    if (work) {
      this.schedule(true, yieldDelayMs);
      return;
    }
    const expiry = this.repository.nextReceiptExpiryMs();
    const delay = expiry === undefined ? TERMINAL_MAINTENANCE_INTERVAL_MS : expiry - Date.now();
    this.schedule(false, Math.max(yieldDelayMs, Math.min(TERMINAL_MAINTENANCE_INTERVAL_MS, delay)));
  }

  private schedule(work: boolean, delayMs: number): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer.handle);
    const handle = setTimeout(() => {
      if (this.closed || this.timer?.handle !== handle) return;
      this.timer = undefined;
      this.run();
    }, delayMs);
    handle.unref?.();
    this.timer = { handle, work };
  }

  private run(): void {
    if (!this.cursor) this.requested = false;
    try {
      const batch = this.repository.compact(new Date(), this.cursor);
      this.cursor = batch.nextCandidate;
      this.scheduleNext(batch.needsPruning || this.cursor !== undefined || this.requested);
      this.retryAt = undefined;
      this.warned = false;
    } catch (error) {
      if (!this.warned) {
        process.emitWarning(error instanceof Error ? error.message : String(error), {
          code: "agent_host_terminal_maintenance_failed"
        });
        this.warned = true;
      }
      const delay = this.retryAt === undefined ? 1_000 : TERMINAL_MAINTENANCE_INTERVAL_MS;
      this.retryAt = Date.now() + delay;
      this.schedule(false, delay);
    }
  }
}
