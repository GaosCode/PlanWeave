import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { type AdvisoryLockScope, createLockWriterScope } from "../process/lockWriterGroup.js";
import { type AdvisoryLockClock, acquireDirectoryLockLease } from "./advisoryLockLease.js";
import {
  type AdvisoryLockFs,
  defaultLockFs,
  isErrno,
  removeExactLockOwner
} from "./advisoryLockOwner.js";
export type { AdvisoryLockClock } from "./advisoryLockLease.js";
export type { AdvisoryLockFs, LockHolder } from "./advisoryLockOwner.js";
export type { AdvisoryLockScope } from "../process/lockWriterGroup.js";

const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 25;
export type WithAdvisoryDirectoryLockOptions = {
  lockPath: string;
  /** Non-empty operation name recorded on the holder and timeout diagnostics. */
  operation: string;
  timeoutMs?: number;
  /** Retained for caller compatibility; age never authorizes reclaiming an unknown/live lease. */
  staleMs?: number;
  retryDelayMs?: number;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
  fs?: AdvisoryLockFs;
  clock?: AdvisoryLockClock;
};

const heldLockPaths = new AsyncLocalStorage<Map<string, AdvisoryLockScope>>();
const inProcessTails = new Map<string, Promise<unknown>>();
const defaultClock: AdvisoryLockClock = {
  nowMs: () => Date.now(),
  performanceNow: () => performance.now(),
  delay: (ms) => delay(ms)
};
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}
function resolveOperation(operation: string): string {
  if (typeof operation !== "string" || operation.trim() === "")
    throw new Error("Advisory directory lock operation must be a non-empty string");
  return operation.trim();
}
/**
 * Serialize critical sections with an advisory atomically published directory lease.
 * Nested calls for the same lock path in the same async context reenter without blocking.
 * Same-process waiters are queued in memory; the file lock still serializes across processes.
 */
export async function withAdvisoryDirectoryLock<T>(
  options: WithAdvisoryDirectoryLockOptions,
  fn: (scope: AdvisoryLockScope) => Promise<T>
): Promise<T> {
  const lockPath = options.lockPath;
  const operation = resolveOperation(options.operation);
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const pid = options.pid ?? process.pid;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const fsAdapter = options.fs ?? defaultLockFs;
  const clock = options.clock ?? defaultClock;

  const existing = heldLockPaths.getStore();
  if (existing?.has(lockPath)) {
    return fn(existing.get(lockPath)!);
  }

  const previous = inProcessTails.get(lockPath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  inProcessTails.set(lockPath, tail);

  await previous.catch(() => undefined);

  const nextHeld = new Map(existing ?? []);
  try {
    const lease = await acquireDirectoryLockLease({
      lockPath,
      operation,
      timeoutMs,
      retryDelayMs,
      pid,
      isPidAlive,
      fs: fsAdapter,
      clock
    });
    const writer = createLockWriterScope(lease.ownerPath, fsAdapter);
    nextHeld.set(lockPath, writer.scope);
    let result: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      result = { ok: true, value: await heldLockPaths.run(nextHeld, () => fn(writer.scope)) };
    } catch (error) {
      result = { ok: false, error };
    }
    // Callback failure cannot skip writer drainage; failure retains the token.
    let drainState: { ok: true } | { ok: false; error: unknown } = { ok: true };
    try {
      const drained = await writer.drain();
      if (drained) {
        if (result.ok) result = { ok: false, error: drained.commandError };
        else if (result.error !== drained.commandError)
          result = {
            ok: false,
            error: new AggregateError(
              [result.error, drained.commandError],
              "Callback and managed command failed"
            )
          };
      }
    } catch (error) {
      drainState = { ok: false, error };
    }
    if (!drainState.ok) {
      if (!result.ok && result.error !== drainState.error)
        throw new AggregateError(
          [result.error, drainState.error],
          `Directory lock writer drain failed at '${lockPath}'`
        );
      throw drainState.error;
    }
    try {
      await removeExactLockOwner(lockPath, lease.name, fsAdapter);
    } catch (releaseError) {
      const failures = result.ok ? [releaseError] : [result.error, releaseError];
      try {
        await removeExactLockOwner(lockPath, lease.name, fsAdapter);
      } catch (retryError) {
        failures.push(retryError);
      }
      if (failures.length === 1) throw releaseError;
      throw new AggregateError(failures, `Directory lock release failed at '${lockPath}'`);
    }
    if (!result.ok) throw result.error;
    return result.value;
  } finally {
    release();
    if (inProcessTails.get(lockPath) === tail) {
      inProcessTails.delete(lockPath);
    }
  }
}
