import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { withAdvisoryDirectoryLock } from "./advisoryDirectoryLock.js";
import { canonicalFileTarget } from "./canonicalFileTarget.js";

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
 * Roots own `project-graph.json` and `canvases/`, rather than external source files.
 * Keys stay outside moved workspaces; multi-project relocation takes the complete
 * sorted set before map/layout and storage locks. Canonical aliases share a key,
 * and nested calls for that key reenter in the same async context.
 */
export async function withProjectMutationLock<T>(
  projectWorkspaceRoot: string | readonly string[],
  fn: () => Promise<T>,
  options?: WithProjectMutationLockOptions
): Promise<T> {
  const provided = options?.operation?.trim();
  const operation =
    provided && provided.length > 0 ? provided : DEFAULT_PROJECT_MUTATION_LOCK_OPERATION;

  const lockRoot = join(userInfo().homedir, ".cache", "planweave", "project-locks");
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const roots =
    typeof projectWorkspaceRoot === "string" ? [projectWorkspaceRoot] : projectWorkspaceRoot;
  const targets = await Promise.all(roots.map(canonicalFileTarget));
  const keys = [
    ...new Set(targets.map((target) => createHash("sha256").update(target).digest("hex")))
  ].sort();
  async function acquire(index: number): Promise<T> {
    const key = keys[index];
    if (!key) return fn();
    return withAdvisoryDirectoryLock(
      {
        lockPath: join(lockRoot, key),
        operation,
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.staleMs !== undefined ? { staleMs: options.staleMs } : {})
      },
      () => acquire(index + 1)
    );
  }
  return acquire(0);
}
