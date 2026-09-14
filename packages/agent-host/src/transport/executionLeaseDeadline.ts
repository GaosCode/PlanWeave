import type { HostTransportClock } from "./hostTransport.js";

// Recheck wall time after sleep or a clock adjustment even for a distant lease.
export const EXECUTION_LEASE_RECHECK_MS = 1_000;

export class ExecutionLeaseDeadline {
  private timer: unknown;
  private generation = 0;

  constructor(
    private readonly clock: HostTransportClock,
    private readonly onDue: () => void
  ) {}

  reschedule(localDeadlineMs: number | undefined): void {
    this.stop();
    if (localDeadlineMs === undefined) return;
    const generation = this.generation;
    this.timer = this.clock.setTimeout(
      () => {
        if (generation !== this.generation) return;
        this.timer = undefined;
        this.onDue();
      },
      Math.min(
        EXECUTION_LEASE_RECHECK_MS,
        Math.max(0, localDeadlineMs - this.clock.now().getTime())
      )
    );
  }

  stop(): void {
    this.generation += 1;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
