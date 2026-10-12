import { canvasStorageIdentityFile, resultsStorageIdentityFile } from "./packageStorageIdentity.js";
import { withImportTransactionMutationAdmission } from "./importTransactionLock.js";
import { assertNoExecutorResultsWriteLease } from "./executorResultsWriteLease.js";
import { dirname, join } from "node:path";
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
  const reservedTargets = [
    ...targets,
    canvasStorageIdentityFile(workspace),
    resultsStorageIdentityFile(workspace)
  ];
  return withPackageFileConsistency(targets, () =>
    withImportTransactionMutationAdmission(
      [workspace.workspaceRoot],
      [...reservedTargets, join(workspace.workspaceRoot, "desktop", "layout.json")],
      () =>
        withCanvasLock(
          dirname(workspace.stateFile),
          async () => {
            for (const target of reservedTargets) {
              await assertNoPendingImportTransactionWrite({
                workspaceRoot: dirname(workspace.projectFile),
                target
              });
            }
            return action();
          },
          options
        )
    )
  );
}

/** Root replacement must preflight before backup, removal or moving the canvas lock directory. */
export async function withCanvasStorageReplacement<T>(
  workspace: ProjectWorkspace,
  action: () => Promise<T>
): Promise<T> {
  const targets = [workspace.packageDir, workspace.stateFile, workspace.resultsDir];
  const reservedTargets = [
    ...targets,
    canvasStorageIdentityFile(workspace),
    resultsStorageIdentityFile(workspace)
  ];
  return withPackageFileConsistency(targets, () =>
    withImportTransactionMutationAdmission(
      [workspace.workspaceRoot],
      [...reservedTargets, join(workspace.workspaceRoot, "desktop", "layout.json")],
      async () => {
        for (const target of reservedTargets) {
          await assertNoPendingImportTransactionWrite({
            workspaceRoot: dirname(workspace.projectFile),
            target
          });
        }
        for (const target of targets) {
          await assertNoExecutorResultsWriteLease(target);
        }
        return action();
      }
    )
  );
}
