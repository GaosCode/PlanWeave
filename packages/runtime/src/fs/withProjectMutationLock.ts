import { join } from "node:path";
import { withAdvisoryDirectoryLock } from "./advisoryDirectoryLock.js";

const LOCK_DIR_NAME = ".planweave-project-mutation.lock";

/** Stable domain default when callers do not supply an operation name. */
export const DEFAULT_PROJECT_MUTATION_LOCK_OPERATION = "project-mutation";

export type WithProjectMutationLockOptions = {
  /**
   * Non-empty operation name written to the lock holder and timeout diagnostics.
   * Prefer names such as `create-canvas:<id>` or `duplicate-canvas:<sourceId>`.
   * Empty or whitespace-only values fall back to {@link DEFAULT_PROJECT_MUTATION_LOCK_OPERATION}.
   */
  operation?: string;
  timeoutMs?: number;
  staleMs?: number;
};

/**
 * Serialize project-scoped canvas graph mutations with an advisory mkdir lock.
 *
 * `projectWorkspaceRoot` is the PlanWeave workspace root that owns `project-graph.json`
 * and `canvases/` (not the external source root). Nested calls for the same lock path
 * in the same async context reenter without blocking. Same-process waiters are queued
 * in memory; the file lock still serializes across processes.
 */
export async function withProjectMutationLock<T>(
  projectWorkspaceRoot: string,
  fn: () => Promise<T>,
  options?: WithProjectMutationLockOptions
): Promise<T> {
  const provided = options?.operation?.trim();
  const operation =
    provided && provided.length > 0 ? provided : DEFAULT_PROJECT_MUTATION_LOCK_OPERATION;

  return withAdvisoryDirectoryLock(
    {
      lockPath: join(projectWorkspaceRoot, LOCK_DIR_NAME),
      operation,
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.staleMs !== undefined ? { staleMs: options.staleMs } : {})
    },
    fn
  );
}
