import { performance } from "node:perf_hooks";

export class AcpCleanupTimeoutError extends Error {
  constructor(step: string) {
    super(`ACP ${step} exceeded the cleanup deadline.`);
    this.name = "AcpCleanupTimeoutError";
  }
}

export type AcpCleanupDeadline = {
  readonly expiresAt: number;
  remainingMs(): number;
};

export function createAcpCleanupDeadline(
  timeoutMs: number,
  now: () => number = () => performance.now()
): AcpCleanupDeadline {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("ACP cleanup deadline must be a positive integer.");
  }
  const expiresAt = now() + timeoutMs;
  return Object.freeze({
    expiresAt,
    remainingMs: () => Math.max(0, Math.ceil(expiresAt - now()))
  });
}

export class AcpCleanupSequencer {
  constructor(readonly deadline: AcpCleanupDeadline) {}

  remaining(step: string, stepLimitMs?: number): number {
    const remaining = this.deadline.remainingMs();
    const timeoutMs = Math.min(remaining, stepLimitMs ?? remaining);
    if (timeoutMs <= 0) throw new AcpCleanupTimeoutError(step);
    return timeoutMs;
  }

  run<T>(
    step: string,
    operation: (timeoutMs: number) => Promise<T>,
    stepLimitMs?: number
  ): Promise<T> {
    return operation(this.remaining(step, stepLimitMs));
  }
}
