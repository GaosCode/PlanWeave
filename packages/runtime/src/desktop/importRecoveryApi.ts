import {
  listPendingImportTransactions,
  rollbackPendingImportTransaction,
  type PendingImportTransaction
} from "../package/importRecovery.js";
import { requireInitializedProjectWorkspace } from "../project.js";

export async function listPendingImportRecoveries(
  projectRoot: string
): Promise<PendingImportTransaction[]> {
  const workspace = await requireInitializedProjectWorkspace(projectRoot);
  return listPendingImportTransactions(workspace.workspaceRoot);
}

export async function rollbackPendingImportRecovery(
  projectRoot: string,
  transactionId: string
): Promise<void> {
  const workspace = await requireInitializedProjectWorkspace(projectRoot);
  await rollbackPendingImportTransaction({ workspaceRoot: workspace.workspaceRoot, transactionId });
}
