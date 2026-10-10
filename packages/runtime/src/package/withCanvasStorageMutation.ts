import { assertNoExecutorResultsWriteLease } from "./executorResultsWriteLease.js";
import { dirname } from "node:path";
import { withCanvasLock, type WithCanvasLockOptions } from "../fs/withCanvasLock.js";
import type { ProjectWorkspace } from "../types.js";
import { assertNoPendingImportTransactionWrite } from "./importTransaction.js";
import { withPackageFileConsistency } from "./packageFileConsistency.js";

/** Acquire actual workspace storage roots together before entering the canvas RMW lock. */
export async function withCanvasStorageMutation<T>(
  workspace: ProjectWorkspace,
  action: () => Promise<T>,
  options?: WithCanvasLockOptions
): Promise<T> {
  const targets = [workspace.packageDir, workspace.stateFile, workspace.resultsDir];
  return withPackageFileConsistency(targets, () =>
    withCanvasLock(
      dirname(workspace.stateFile),
      async () => {
        for (const target of targets) {
          await assertNoPendingImportTransactionWrite({
            workspaceRoot: dirname(workspace.projectFile),
            target
          });
        }
        return action();
      },
      options
    )
  );
}

/** Root replacement must preflight before backup, removal or moving the canvas lock directory. */
export async function withCanvasStorageReplacement<T>(
  workspace: ProjectWorkspace,
  action: () => Promise<T>
): Promise<T> {
  const targets = [workspace.packageDir, workspace.stateFile, workspace.resultsDir];
  return withPackageFileConsistency(targets, async () => {
    for (const target of targets) {
      await assertNoPendingImportTransactionWrite({
        workspaceRoot: dirname(workspace.projectFile),
        target
      });
      await assertNoExecutorResultsWriteLease(target);
    }
    return action();
  });
}
