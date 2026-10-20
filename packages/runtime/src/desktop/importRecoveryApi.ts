import { realpath } from "node:fs/promises";
import {
  listPendingImportTransactions,
  rollbackPendingImportTransaction,
  type PendingImportTransaction
} from "../package/importRecovery.js";
import { requireInitializedProjectWorkspace, withCurrentProjectWorkspace } from "../project.js";
import type { ProjectWorkspace } from "../types.js";

async function projectRecoveries(workspace: ProjectWorkspace) {
  const home = await realpath(workspace.planweaveHome);
  const owners = [workspace.workspaceRoot, ...(home === workspace.workspaceRoot ? [] : [home])];
  const entries = await Promise.all(
    owners.map(async (workspaceRoot) => {
      const scope =
        workspaceRoot === workspace.workspaceRoot
          ? undefined
          : { targetRoot: workspace.workspaceRoot };
      const pending = await listPendingImportTransactions(workspaceRoot, scope);
      return pending.map((transaction) => ({ workspaceRoot, transaction }));
    })
  );
  return entries.flat();
}

export async function listPendingImportRecoveries(
  projectRoot: string
): Promise<PendingImportTransaction[]> {
  const workspace = await requireInitializedProjectWorkspace(projectRoot);
  return (await projectRecoveries(workspace))
    .map((entry) => entry.transaction)
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.transactionId.localeCompare(right.transactionId)
    );
}

export async function rollbackPendingImportRecovery(
  projectRoot: string,
  transactionId: string
): Promise<void> {
  const workspace = await requireInitializedProjectWorkspace(projectRoot);
  await withCurrentProjectWorkspace(workspace, async () => {
    const entries = (await projectRecoveries(workspace)).filter(
      (entry) => entry.transaction.transactionId === transactionId
    );
    if (entries.length !== 1) {
      throw new Error(
        entries.length === 0
          ? `Import recovery '${transactionId}' does not belong to project '${projectRoot}'.`
          : `Import recovery '${transactionId}' has ambiguous journal owners for project '${projectRoot}'.`
      );
    }
    await rollbackPendingImportTransaction({
      workspaceRoot: entries[0].workspaceRoot,
      transactionId,
      ...(entries[0].workspaceRoot === workspace.workspaceRoot
        ? {}
        : { targetRoot: workspace.workspaceRoot })
    });
  });
}
