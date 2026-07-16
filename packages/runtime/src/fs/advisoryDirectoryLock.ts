import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { optionalStat } from "./optionalFile.js";

const HOLDER_FILE_NAME = "holder.json";
const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 25;

export type LockHolder = {
  pid: number;
  acquiredAt: string;
  operation: string;
  ownerToken?: string;
};

export type AdvisoryLockFs = {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
  optionalStat(path: string): Promise<{ mtimeMs: number } | null>;
};

export type AdvisoryLockClock = {
  /** Wall clock for lock age / holder age diagnostics (Date.now semantics). */
  nowMs(): number;
  /** Monotonic clock for acquire timeout loops (performance.now semantics). */
  performanceNow(): number;
  delay(ms: number): Promise<void>;
};

export type WithAdvisoryDirectoryLockOptions = {
  lockPath: string;
  /** Non-empty operation name recorded on the holder and timeout diagnostics. */
  operation: string;
  timeoutMs?: number;
  staleMs?: number;
  retryDelayMs?: number;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
  fs?: AdvisoryLockFs;
  clock?: AdvisoryLockClock;
};

const heldLockPaths = new AsyncLocalStorage<Set<string>>();

/** Same-process waiters for a lock path — avoids contending on the file lock under fake timers. */
const inProcessTails = new Map<string, Promise<unknown>>();

const defaultFs: AdvisoryLockFs = {
  mkdir: async (path) => {
    await mkdir(path);
  },
  writeFile: async (path, data, encoding) => {
    await writeFile(path, data, encoding);
  },
  readFile: async (path, encoding) => readFile(path, encoding),
  rename: async (from, to) => rename(from, to),
  rm: async (path, options) => {
    await rm(path, options);
  },
  optionalStat
};

const defaultClock: AdvisoryLockClock = {
  nowMs: () => Date.now(),
  performanceNow: () => performance.now(),
  delay: (ms) => delay(ms)
};

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === code
  );
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

function resolveOperation(operation: string): string {
  if (typeof operation !== "string" || operation.trim() === "") {
    throw new Error("Advisory directory lock operation must be a non-empty string");
  }
  return operation.trim();
}

type HolderReadResult =
  | { status: "ok"; holder: LockHolder; identity: string }
  | { status: "missing"; detail: string; identity: string }
  | { status: "invalid"; detail: string; identity: string }
  | { status: "error"; detail: string; identity: string };

async function readHolder(
  lockPath: string,
  fsAdapter: AdvisoryLockFs
): Promise<HolderReadResult> {
  const holderPath = join(lockPath, HOLDER_FILE_NAME);
  let rawText: string;
  try {
    rawText = await fsAdapter.readFile(holderPath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
      return { status: "missing", detail: `holder file missing at ${holderPath}`, identity: "missing" };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { status: "error", detail: `holder file unreadable at ${holderPath}: ${message}`, identity: `error:${message}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "invalid", detail: `holder JSON invalid at ${holderPath}: ${message}`, identity: `raw:${rawText}` };
  }

  if (!raw || typeof raw !== "object") {
    return { status: "invalid", detail: `holder JSON is not an object at ${holderPath}`, identity: `raw:${rawText}` };
  }

  const record = raw as Partial<LockHolder>;
  if (typeof record.pid !== "number" || !Number.isFinite(record.pid)) {
    return { status: "invalid", detail: `holder pid missing or invalid at ${holderPath}`, identity: `raw:${rawText}` };
  }
  if (typeof record.acquiredAt !== "string" || record.acquiredAt.trim() === "") {
    return {
      status: "invalid",
      detail: `holder acquiredAt missing or invalid at ${holderPath}`,
      identity: `raw:${rawText}`
    };
  }
  if (typeof record.operation !== "string" || record.operation.trim() === "") {
    return {
      status: "invalid",
      detail: `holder operation missing or invalid at ${holderPath}`,
      identity: `raw:${rawText}`
    };
  }

  return {
    status: "ok",
    identity: typeof record.ownerToken === "string" && record.ownerToken !== ""
      ? `token:${record.ownerToken}`
      : `raw:${rawText}`,
    holder: {
      pid: record.pid,
      acquiredAt: record.acquiredAt,
      operation: record.operation.trim(),
      ...(typeof record.ownerToken === "string" && record.ownerToken !== ""
        ? { ownerToken: record.ownerToken }
        : {})
    }
  };
}

async function writeHolder(
  lockPath: string,
  operation: string,
  pid: number,
  ownerToken: string,
  clock: AdvisoryLockClock,
  fsAdapter: AdvisoryLockFs
): Promise<void> {
  const holder: LockHolder = {
    pid,
    acquiredAt: new Date(clock.nowMs()).toISOString(),
    operation,
    ownerToken
  };
  await fsAdapter.writeFile(
    join(lockPath, HOLDER_FILE_NAME),
    `${JSON.stringify(holder, null, 2)}\n`,
    "utf8"
  );
}

async function removeLockIfIdentityMatches(
  lockPath: string,
  expectedIdentity: string,
  fsAdapter: AdvisoryLockFs
): Promise<boolean> {
  const current = await readHolder(lockPath, fsAdapter);
  if (current.identity !== expectedIdentity) return false;
  const tombstonePath = `${lockPath}.release-${randomUUID()}`;
  try {
    // Atomic rename is the fencing point: cleanup never recursively removes the
    // shared lock path after a separately observed identity comparison.
    await fsAdapter.rename(lockPath, tombstonePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
  const moved = await readHolder(tombstonePath, fsAdapter);
  if (moved.identity !== expectedIdentity) {
    try {
      await fsAdapter.rename(tombstonePath, lockPath);
    } catch (restoreError) {
      throw new AggregateError(
        [restoreError],
        `Lock ownership changed while fencing '${lockPath}'; replacement preserved at '${tombstonePath}'`
      );
    }
    return false;
  }
  await fsAdapter.rm(tombstonePath, { recursive: true, force: true });
  return true;
}

/**
 * Only the caller that successfully created `lockPath` via mkdir may clean it up
 * when subsequent holder write fails. Other waiters never remove a lock they did not create.
 */
async function cleanupOwnLockAfterHolderWriteFailure(
  lockPath: string,
  writeError: unknown,
  fsAdapter: AdvisoryLockFs
): Promise<never> {
  try {
    await fsAdapter.rm(lockPath, { recursive: true, force: true });
  } catch (cleanupError) {
    throw new AggregateError(
      [writeError, cleanupError],
      `Failed to write lock holder at ${lockPath}; cleanup of newly created lock also failed`
    );
  }
  throw writeError;
}

async function tryReclaimStaleLock(
  lockPath: string,
  staleMs: number,
  clock: AdvisoryLockClock,
  fsAdapter: AdvisoryLockFs,
  isPidAlive: (pid: number) => boolean
): Promise<boolean> {
  const stats = await fsAdapter.optionalStat(lockPath);
  if (!stats) {
    return false;
  }
  const ageMs = clock.nowMs() - stats.mtimeMs;
  if (ageMs < staleMs) {
    return false;
  }

  const holderResult = await readHolder(lockPath, fsAdapter);
  if (holderResult.status === "ok" && isPidAlive(holderResult.holder.pid)) {
    return false;
  }

  // Stale and holder dead, missing, invalid, or unreadable — reclaim conservatively.
  return removeLockIfIdentityMatches(lockPath, holderResult.identity, fsAdapter);
}

function formatAgeMs(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs)) {
    return "unknown";
  }
  return `${Math.max(0, Math.round(ageMs))}ms`;
}

async function buildTimeoutError(
  lockPath: string,
  operation: string,
  waitedMs: number,
  clock: AdvisoryLockClock,
  fsAdapter: AdvisoryLockFs,
  isPidAlive: (pid: number) => boolean
): Promise<Error> {
  const stats = await fsAdapter.optionalStat(lockPath);
  const lockAgeMs = stats ? clock.nowMs() - stats.mtimeMs : null;
  const holderResult = await readHolder(lockPath, fsAdapter);

  const parts = [
    `Timed out acquiring directory lock at ${lockPath}`,
    `after ${Math.round(waitedMs)}ms`,
    `requested operation=${operation}`
  ];

  if (holderResult.status === "ok") {
    const holder = holderResult.holder;
    const acquiredAtMs = Date.parse(holder.acquiredAt);
    const holderAgeMs = Number.isFinite(acquiredAtMs) ? clock.nowMs() - acquiredAtMs : null;
    const alive = isPidAlive(holder.pid);
    parts.push(
      `holder pid=${holder.pid}`,
      `holder operation=${holder.operation}`,
      `holder acquiredAt=${holder.acquiredAt}`,
      `holder age=${formatAgeMs(holderAgeMs)}`,
      `holder pidAlive=${alive}`,
      `lock age=${formatAgeMs(lockAgeMs)}`
    );
  } else {
    parts.push(
      `holder unreadable (${holderResult.status}: ${holderResult.detail})`,
      `lock age=${formatAgeMs(lockAgeMs)}`
    );
  }

  return new Error(parts.join("; "));
}

async function acquireFileLock(
  lockPath: string,
  operation: string,
  timeoutMs: number,
  staleMs: number,
  retryDelayMs: number,
  pid: number,
  isPidAlive: (pid: number) => boolean,
  fsAdapter: AdvisoryLockFs,
  clock: AdvisoryLockClock
): Promise<string> {
  // Use performance.now() so Vitest fake Date cannot freeze the timeout loop.
  const started = clock.performanceNow();
  let attemptedStaleReclaim = false;

  while (clock.performanceNow() - started < timeoutMs) {
    try {
      await fsAdapter.mkdir(lockPath);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }
      if (!attemptedStaleReclaim) {
        attemptedStaleReclaim = true;
        if (await tryReclaimStaleLock(lockPath, staleMs, clock, fsAdapter, isPidAlive)) {
          continue;
        }
      }
      // Prefer injected delay so Vitest fake timers on the global do not freeze backoff.
      await clock.delay(retryDelayMs);
      continue;
    }

    // mkdir succeeded: this caller owns the lock directory until release or cleanup.
    const ownerToken = randomUUID();
    try {
      await writeHolder(lockPath, operation, pid, ownerToken, clock, fsAdapter);
      return ownerToken;
    } catch (writeError) {
      await cleanupOwnLockAfterHolderWriteFailure(lockPath, writeError, fsAdapter);
    }
  }

  throw await buildTimeoutError(
    lockPath,
    operation,
    clock.performanceNow() - started,
    clock,
    fsAdapter,
    isPidAlive
  );
}

/**
 * Serialize critical sections with an advisory mkdir-based directory lock.
 * Nested calls for the same lock path in the same async context reenter without blocking.
 * Same-process waiters are queued in memory; the file lock still serializes across processes.
 */
export async function withAdvisoryDirectoryLock<T>(
  options: WithAdvisoryDirectoryLockOptions,
  fn: () => Promise<T>
): Promise<T> {
  const lockPath = options.lockPath;
  const operation = resolveOperation(options.operation);
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const pid = options.pid ?? process.pid;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const fsAdapter = options.fs ?? defaultFs;
  const clock = options.clock ?? defaultClock;

  const existing = heldLockPaths.getStore();
  if (existing?.has(lockPath)) {
    return fn();
  }

  const previous = inProcessTails.get(lockPath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  inProcessTails.set(lockPath, tail);

  await previous.catch(() => undefined);

  const nextHeld = new Set(existing ?? []);
  nextHeld.add(lockPath);
  try {
    const ownerToken = await acquireFileLock(
      lockPath,
      operation,
      timeoutMs,
      staleMs,
      retryDelayMs,
      pid,
      isPidAlive,
      fsAdapter,
      clock
    );
    try {
      return await heldLockPaths.run(nextHeld, fn);
    } finally {
      await removeLockIfIdentityMatches(lockPath, `token:${ownerToken}`, fsAdapter);
    }
  } finally {
    release();
    if (inProcessTails.get(lockPath) === tail) {
      inProcessTails.delete(lockPath);
    }
  }
}
