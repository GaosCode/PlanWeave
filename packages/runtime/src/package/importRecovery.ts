import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { optionalStat } from "../fs/optionalFile.js";
import { ImportTransaction, readImportTransactionRecoverySummary } from "./importTransaction.js";

export type PendingImportTransaction = {
  transactionId: string;
  recoveryRoot: string;
  createdAt: string;
  operationCount: number;
  phases: string[];
};

function packageImportRecoveryRoot(workspaceRoot: string): string {
  return join(resolve(workspaceRoot), "desktop", "recovery", "package-import");
}

async function listRecoveryTransactionIds(recoveryRoot: string): Promise<string[]> {
  const stat = await optionalStat(recoveryRoot);
  if (stat === null) {
    return [];
  }
  if (!stat.isDirectory()) {
    throw new Error(`Import recovery root '${recoveryRoot}' is not a directory.`);
  }
  const entries = await readdir(recoveryRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export async function listPendingImportTransactions(
  workspaceRoot: string
): Promise<PendingImportTransaction[]> {
  const resolvedWorkspaceRoot = resolve(workspaceRoot);
  const transactionIds = await listRecoveryTransactionIds(
    packageImportRecoveryRoot(resolvedWorkspaceRoot)
  );
  const pending: PendingImportTransaction[] = [];
  for (const transactionId of transactionIds) {
    const summary = await readImportTransactionRecoverySummary({
      workspaceRoot: resolvedWorkspaceRoot,
      transactionId
    });
    pending.push({
      transactionId: summary.transactionId,
      recoveryRoot: summary.recoveryRoot,
      createdAt: summary.createdAt,
      operationCount: summary.operationCount,
      phases: summary.phases
    });
  }
  return pending.sort((left, right) => {
    const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
    return createdAtOrder === 0
      ? left.transactionId.localeCompare(right.transactionId)
      : createdAtOrder;
  });
}

export async function rollbackPendingImportTransaction(options: {
  workspaceRoot: string;
  transactionId: string;
}): Promise<void> {
  const transaction = await ImportTransaction.recover({
    workspaceRoot: options.workspaceRoot,
    transactionId: options.transactionId
  });
  await transaction.rollback();
}
