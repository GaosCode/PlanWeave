import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { optionalStat } from "./optionalFile.js";

const LOCK_DIR_NAME = ".planweave.lock";
const HOLDER_FILE_NAME = "holder.json";
const ACQUIRE_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 60_000;
const RETRY_DELAY_MS = 25;

type LockHolder = {
  pid: number;
  acquiredAt: string;
};

const heldLockPaths = new AsyncLocalStorage<Set<string>>();

/** Same-process waiters for a lock path — avoids contending on the file lock under fake timers. */
const inProcessTails = new Map<string, Promise<unknown>>();

/** Canvas directory that owns `state.json` / results — pass this to `withCanvasLock`. */
export function canvasDirFromStateFile(stateFile: string): string {
  return dirname(stateFile);
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}

function isPidAlive(pid: number): boolean {
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

async function readHolder(lockPath: string): Promise<LockHolder | null> {
  try {
    const raw = JSON.parse(await readFile(join(lockPath, HOLDER_FILE_NAME), "utf8")) as Partial<LockHolder>;
    if (typeof raw.pid !== "number" || typeof raw.acquiredAt !== "string") {
      return null;
    }
    return { pid: raw.pid, acquiredAt: raw.acquiredAt };
  } catch {
    return null;
  }
}

async function writeHolder(lockPath: string): Promise<void> {
  const holder: LockHolder = {
    pid: process.pid,
    acquiredAt: new Date().toISOString()
  };
  await writeFile(join(lockPath, HOLDER_FILE_NAME), `${JSON.stringify(holder, null, 2)}\n`, "utf8");
}

async function tryReclaimStaleLock(lockPath: string): Promise<boolean> {
  const stats = await optionalStat(lockPath);
  if (!stats) {
    return false;
  }
  const ageMs = Date.now() - stats.mtimeMs;
  if (ageMs < STALE_LOCK_MS) {
    return false;
  }
  const holder = await readHolder(lockPath);
  if (holder && isPidAlive(holder.pid)) {
    return false;
  }
  await rm(lockPath, { recursive: true, force: true });
  return true;
}

async function acquireFileLock(lockPath: string): Promise<void> {
  // Use performance.now() so Vitest fake Date cannot freeze the timeout loop.
  const started = performance.now();
  let attemptedStaleReclaim = false;
  while (performance.now() - started < ACQUIRE_TIMEOUT_MS) {
    try {
      await mkdir(lockPath);
      await writeHolder(lockPath);
      return;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }
      if (!attemptedStaleReclaim) {
        attemptedStaleReclaim = true;
        if (await tryReclaimStaleLock(lockPath)) {
          continue;
        }
      }
      // Prefer node:timers/promises so Vitest fake timers on the global do not freeze backoff.
      await delay(RETRY_DELAY_MS);
    }
  }
  throw new Error(`Timed out acquiring canvas lock at ${lockPath}`);
}

/**
 * Serialize canvas-scoped read-modify-write sections with an advisory mkdir lock.
 * `lockDir` is the canvas directory that contains `state.json` (typically `dirname(stateFile)`).
 * Nested calls for the same lock path in the same async context reenter without blocking.
 * Same-process waiters are queued in memory; the file lock still serializes across processes.
 */
export async function withCanvasLock<T>(lockDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = join(lockDir, LOCK_DIR_NAME);
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
    await acquireFileLock(lockPath);
    try {
      return await heldLockPaths.run(nextHeld, fn);
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  } finally {
    release();
    if (inProcessTails.get(lockPath) === tail) {
      inProcessTails.delete(lockPath);
    }
  }
}
