import { dirname, join } from "node:path";
import { withAdvisoryDirectoryLock } from "./advisoryDirectoryLock.js";

const LOCK_DIR_NAME = ".planweave.lock";
/** Stable domain default when callers do not supply an operation name. */
export const DEFAULT_CANVAS_LOCK_OPERATION = "canvas-mutation";

/** Canvas directory that owns `state.json` / results — pass this to `withCanvasLock`. */
export function canvasDirFromStateFile(stateFile: string): string {
  return dirname(stateFile);
}

export type WithCanvasLockOptions = {
  /**
   * Optional non-empty operation name written to the lock holder and timeout diagnostics.
   * Empty or whitespace-only values fall back to {@link DEFAULT_CANVAS_LOCK_OPERATION}.
   */
  operation?: string;
};

/**
 * Serialize canvas-scoped read-modify-write sections with an advisory mkdir lock.
 * `lockDir` is the canvas directory that contains `state.json` (typically `dirname(stateFile)`).
 * Nested calls for the same lock path in the same async context reenter without blocking.
 * Same-process waiters are queued in memory; the file lock still serializes across processes.
 */
export async function withCanvasLock<T>(
  lockDir: string,
  fn: () => Promise<T>,
  options?: WithCanvasLockOptions
): Promise<T> {
  const provided = options?.operation?.trim();
  const operation = provided && provided.length > 0 ? provided : DEFAULT_CANVAS_LOCK_OPERATION;

  return withAdvisoryDirectoryLock(
    {
      lockPath: join(lockDir, LOCK_DIR_NAME),
      operation
    },
    fn
  );
}
