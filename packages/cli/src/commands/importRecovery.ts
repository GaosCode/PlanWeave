import type { Command } from "commander";
import {
  listPendingImportRecoveries,
  rollbackPendingImportRecovery,
  type PendingImportTransaction
} from "@planweave-ai/runtime";
import { resolveCliProjectRoot } from "../projectRoot.js";

type ImportRecoveryOptions = {
  json?: boolean;
};

function formatPendingImportTransactionsHuman(transactions: PendingImportTransaction[]): string {
  if (transactions.length === 0) {
    return "No pending package import recovery transactions.";
  }
  return [
    `Pending package import recovery transactions: ${transactions.length}`,
    ...transactions.map((transaction) =>
      [
        `- ${transaction.transactionId}`,
        `  created: ${transaction.createdAt}`,
        `  operations: ${transaction.operationCount}`,
        `  phases: ${transaction.phases.length === 0 ? "none" : transaction.phases.join(", ")}`,
        `  recovery: ${transaction.recoveryRoot}`
      ].join("\n")
    )
  ].join("\n");
}

export function registerImportRecoveryCommand(program: Command): void {
  const importRecovery = program
    .command("import-recovery")
    .description("Inspect and roll back pending package import recovery transactions");

  importRecovery
    .command("list")
    .description("List pending package import recovery transactions")
    .option("--json", "print machine-readable output")
    .action(async (options: ImportRecoveryOptions) => {
      const transactions = await listPendingImportRecoveries(await resolveCliProjectRoot());
      console.log(options.json ? JSON.stringify({ pending: transactions }, null, 2) : formatPendingImportTransactionsHuman(transactions));
    });

  importRecovery
    .command("rollback")
    .argument("<transactionId>")
    .description("Roll back a pending package import recovery transaction")
    .option("--json", "print machine-readable output")
    .action(async (transactionId: string, options: ImportRecoveryOptions) => {
      await rollbackPendingImportRecovery(await resolveCliProjectRoot(), transactionId);
      const result = { ok: true, transactionId };
      console.log(options.json ? JSON.stringify(result, null, 2) : `Rolled back package import recovery transaction: ${transactionId}`);
    });
}
