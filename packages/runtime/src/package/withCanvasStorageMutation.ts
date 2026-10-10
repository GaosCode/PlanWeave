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
