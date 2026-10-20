import { PendingImportTransactionConflictError } from "../package/importTransaction.js";
import { withCurrentProjectWorkspace } from "../project.js";
import { assertCurrentCanvasWorkspace } from "../package/assertCurrentCanvasWorkspace.js";
import { assertResultsStorageIdentity } from "../package/packageStorageIdentity.js";
import { withCanvasStorageMutation } from "../package/withCanvasStorageMutation.js";
import type { ProjectWorkspace } from "../types.js";

/** Admit a captured session owner before any result or state mutation. */
export function withCurrentRunSessionStorage<T>(
  workspace: ProjectWorkspace,
  action: () => Promise<T>
): Promise<T> {
  return withCurrentProjectWorkspace(workspace, () =>
    withCanvasStorageMutation(workspace, async () => {
      await assertCurrentCanvasWorkspace(workspace);
      await assertResultsStorageIdentity(workspace);
      return action();
    })
  );
}

/** Read queries may defer their persisted repairs while an import owns the storage. */
export async function withCurrentRunSessionReadRepair<T>(
  workspace: ProjectWorkspace,
  repair: () => Promise<T>,
  readOnly: (conflict: PendingImportTransactionConflictError) => Promise<T>
): Promise<T> {
  let admitted = false;
  try {
    return await withCurrentRunSessionStorage(workspace, () => {
      admitted = true;
      return repair();
    });
  } catch (error) {
    if (!admitted && error instanceof PendingImportTransactionConflictError) {
      return readOnly(error);
    }
    throw error;
  }
}
