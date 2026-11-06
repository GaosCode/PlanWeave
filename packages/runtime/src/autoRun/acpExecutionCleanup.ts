import { performance } from "node:perf_hooks";

export class AcpCleanupTimeoutError extends Error {
  constructor(step: string, stepLimitMs?: number) {
    super(
      stepLimitMs === undefined
        ? `ACP ${step} exceeded the cleanup deadline.`
        : `ACP ${step} timed out after ${stepLimitMs}ms.`
    );
    this.name = "AcpCleanupTimeoutError";
  }
}

export type AcpCleanupDeadline = {
  readonly expiresAt: number;
  remainingMs(): number;
};

export function createAcpCleanupDeadline(
  timeoutMs: number,
  now: () => number = () => performance.now(),
  startedAt: number = now()
): AcpCleanupDeadline {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("ACP cleanup deadline must be a positive integer.");
  }
  if (!Number.isFinite(startedAt)) throw new Error("ACP cleanup start must be finite.");
  const expiresAt = startedAt + timeoutMs;
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

  async run<T>(
    step: string,
    operation: (timeoutMs: number) => Promise<T>,
    stepLimitMs?: number
  ): Promise<T> {
    const timeoutMs = this.remaining(step, stepLimitMs);
    const operationPromise = operation(timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const boundary = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new AcpCleanupTimeoutError(
              step,
              this.deadline.remainingMs() > 0 ? stepLimitMs : undefined
            )
          ),
        Math.min(timeoutMs, this.deadline.remainingMs())
      );
    });
    try {
      return await Promise.race([operationPromise, boundary]);
    } finally {
      clearTimeout(timer);
    }
  }
}
