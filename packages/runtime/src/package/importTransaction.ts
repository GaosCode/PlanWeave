import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isNodeFileNotFoundError, optionalStat } from "../fs/optionalFile.js";
import { readJsonFile, writeJsonFile } from "../json.js";

type ImportTransactionOperationPhase =
  | "planned"
  | "backedUp"
  | "installed"
  | "rollingBackFromInstalled"
  | "rollingBackFromBackedUp"
  | "rolledBack";

type ImportTransactionOperation = {
  id: string;
  type: "replace" | "remove";
  target: string;
  backupPath: string;
  targetExisted: boolean;
  phase: ImportTransactionOperationPhase;
};

type ImportTransactionRecoveryFile = {
  version: 1;
  transactionId: string;
  workspaceRoot: string;
  createdAt: string;
  operations: ImportTransactionOperation[];
};

export type ImportTransactionRecoverySummary = {
  transactionId: string;
  recoveryRoot: string;
  workspaceRoot: string;
  createdAt: string;
  operationCount: number;
  phases: string[];
};

type ImportTransactionFileSystem = {
  mkdir: typeof mkdir;
  rename: typeof rename;
  rm: typeof rm;
  optionalStat: typeof optionalStat;
  readJsonFile: typeof readJsonFile;
  writeJsonFile: typeof writeJsonFile;
};

const nodeFileSystem: ImportTransactionFileSystem = {
  mkdir,
  rename,
  rm,
  optionalStat,
  readJsonFile,
  writeJsonFile
};

function errorSummary(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertValidImportTransactionId(transactionId: string): void {
  if (
    transactionId.length === 0 ||
    transactionId === "." ||
    transactionId === ".." ||
    transactionId.includes("/") ||
    transactionId.includes("\\") ||
    /\s/.test(transactionId)
  ) {
    throw new Error(
      `Invalid import transaction id '${transactionId}'. Import transaction ids must be single recovery directory names.`
    );
  }
}

function assertWorkspaceTarget(workspaceRoot: string, target: string): void {
  const relativeTarget = relative(resolve(workspaceRoot), resolve(target));
  if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new Error(
      `Import transaction target '${target}' is outside the PlanWeave workspace or points at the workspace root.`
    );
  }
}

function assertRecoveryBackupPath(recoveryRoot: string, backupPath: string): void {
  const relativeBackup = relative(resolve(recoveryRoot), resolve(backupPath));
  if (!relativeBackup || relativeBackup.startsWith("..") || isAbsolute(relativeBackup)) {
    throw new Error(
      `Import transaction backup path '${backupPath}' is outside the recovery directory or points at the recovery root.`
    );
  }
}

async function removeRollbackTarget(
  fs: ImportTransactionFileSystem,
  target: string
): Promise<void> {
  try {
    await fs.rm(target, { recursive: true, force: true });
  } catch (error) {
    if (!isNodeFileNotFoundError(error)) {
      throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseOperation(raw: unknown, recoveryFile: string): ImportTransactionOperation {
  if (!isRecord(raw)) {
    throw new Error(`Invalid import transaction recovery operation in ${recoveryFile}.`);
  }
  const { id, type, target, backupPath, targetExisted, phase } = raw;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`Invalid import transaction recovery operation id in ${recoveryFile}.`);
  }
  if (type !== "replace" && type !== "remove") {
    throw new Error(`Invalid import transaction recovery operation type in ${recoveryFile}.`);
  }
  if (typeof target !== "string" || target.length === 0) {
    throw new Error(`Invalid import transaction recovery operation target in ${recoveryFile}.`);
  }
  if (typeof backupPath !== "string" || backupPath.length === 0) {
    throw new Error(`Invalid import transaction recovery operation backupPath in ${recoveryFile}.`);
  }
  if (typeof targetExisted !== "boolean") {
    throw new Error(
      `Invalid import transaction recovery operation targetExisted in ${recoveryFile}.`
    );
  }
  if (
    phase !== "planned" &&
    phase !== "backedUp" &&
    phase !== "installed" &&
    phase !== "rollingBackFromInstalled" &&
    phase !== "rollingBackFromBackedUp" &&
    phase !== "rolledBack"
  ) {
    throw new Error(`Invalid import transaction recovery operation phase in ${recoveryFile}.`);
  }
  if (type === "remove" && !targetExisted) {
    throw new Error(
      `Invalid import transaction remove operation without an original target in ${recoveryFile}.`
    );
  }
  return {
    id,
    type,
    target: resolve(target),
    backupPath: resolve(backupPath),
    targetExisted,
    phase
  };
}

function parseRecoveryFile(raw: unknown, recoveryFile: string): ImportTransactionRecoveryFile {
  if (!isRecord(raw)) {
    throw new Error(`Invalid import transaction recovery file at ${recoveryFile}.`);
  }
  const { version, transactionId, workspaceRoot, createdAt, operations } = raw;
  if (version !== 1) {
    throw new Error(`Unsupported import transaction recovery file version at ${recoveryFile}.`);
  }
  if (typeof transactionId !== "string" || transactionId.length === 0) {
    throw new Error(`Invalid import transaction id in ${recoveryFile}.`);
  }
  assertValidImportTransactionId(transactionId);
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new Error(`Invalid import transaction workspaceRoot in ${recoveryFile}.`);
  }
  if (typeof createdAt !== "string" || createdAt.length === 0) {
    throw new Error(`Invalid import transaction createdAt in ${recoveryFile}.`);
  }
  if (!Array.isArray(operations)) {
    throw new Error(`Invalid import transaction operations in ${recoveryFile}.`);
  }
  return {
    version,
    transactionId,
    workspaceRoot: resolve(workspaceRoot),
    createdAt,
    operations: operations.map((operation) => parseOperation(operation, recoveryFile))
  };
}

async function readValidatedRecoveryFile(options: {
  workspaceRoot: string;
  transactionId: string;
  fs: ImportTransactionFileSystem;
}): Promise<{
  workspaceRoot: string;
  recoveryRoot: string;
  recovery: ImportTransactionRecoveryFile;
}> {
  const workspaceRoot = resolve(options.workspaceRoot);
  assertValidImportTransactionId(options.transactionId);
  const recoveryRoot = join(
    workspaceRoot,
    "desktop",
    "recovery",
    "package-import",
    options.transactionId
  );
  const recoveryFile = join(recoveryRoot, "recovery.json");
  const recovery = parseRecoveryFile(
    await options.fs.readJsonFile<unknown>(recoveryFile),
    recoveryFile
  );
  if (recovery.transactionId !== options.transactionId) {
    throw new Error(
      `Import transaction recovery id mismatch: expected '${options.transactionId}', found '${recovery.transactionId}'.`
    );
  }
  if (recovery.workspaceRoot !== workspaceRoot) {
    throw new Error(
      `Import transaction recovery workspace mismatch: expected '${workspaceRoot}', found '${recovery.workspaceRoot}'.`
    );
  }
  for (const operation of recovery.operations) {
    assertWorkspaceTarget(workspaceRoot, operation.target);
    assertRecoveryBackupPath(recoveryRoot, operation.backupPath);
  }
  return { workspaceRoot, recoveryRoot, recovery };
}

export async function readImportTransactionRecoverySummary(options: {
  workspaceRoot: string;
  transactionId: string;
}): Promise<ImportTransactionRecoverySummary> {
  const { workspaceRoot, recoveryRoot, recovery } = await readValidatedRecoveryFile({
    workspaceRoot: options.workspaceRoot,
    transactionId: options.transactionId,
    fs: nodeFileSystem
  });
  return {
    transactionId: recovery.transactionId,
    recoveryRoot,
    workspaceRoot,
    createdAt: recovery.createdAt,
    operationCount: recovery.operations.length,
    phases: [...new Set(recovery.operations.map((operation) => operation.phase))]
  };
}

export class ImportTransaction {
  private readonly transactionId: string;
  private readonly recoveryRoot: string;
  private readonly workspaceRoot: string;
  private readonly createdAt: string;
  private readonly fs: ImportTransactionFileSystem;
  private operations: ImportTransactionOperation[] = [];

  private constructor(options: {
    workspaceRoot: string;
    transactionId: string;
    createdAt?: string;
    fs: ImportTransactionFileSystem;
  }) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.transactionId = options.transactionId;
    this.recoveryRoot = join(
      this.workspaceRoot,
      "desktop",
      "recovery",
      "package-import",
      this.transactionId
    );
    this.createdAt = options.createdAt ?? new Date().toISOString();
    this.fs = options.fs;
  }

  static async create(options: {
    workspaceRoot: string;
    transactionId?: string;
    fs?: ImportTransactionFileSystem;
  }): Promise<ImportTransaction> {
    const transactionId = options.transactionId ?? randomUUID();
    assertValidImportTransactionId(transactionId);
    const transaction = new ImportTransaction({
      workspaceRoot: options.workspaceRoot,
      transactionId,
      fs: options.fs ?? nodeFileSystem
    });
    await transaction.fs.mkdir(transaction.recoveryRoot, { recursive: true });
    await transaction.writeRecoveryFile();
    return transaction;
  }

  static async recover(options: {
    workspaceRoot: string;
    transactionId: string;
    fs?: ImportTransactionFileSystem;
  }): Promise<ImportTransaction> {
    const fs = options.fs ?? nodeFileSystem;
    const { workspaceRoot, recovery } = await readValidatedRecoveryFile({
      workspaceRoot: options.workspaceRoot,
      transactionId: options.transactionId,
      fs
    });
    const transaction = new ImportTransaction({
      workspaceRoot,
      transactionId: recovery.transactionId,
      createdAt: recovery.createdAt,
      fs
    });
    transaction.operations = recovery.operations;
    return transaction;
  }

  async replacePath(target: string, staged: string): Promise<void> {
    assertWorkspaceTarget(this.workspaceRoot, target);
    const operation = this.nextOperation(
      "replace",
      target,
      (await this.fs.optionalStat(target)) !== null
    );
    this.operations.push(operation);
    await this.writeRecoveryFile();
    if (operation.targetExisted) {
      await this.fs.mkdir(dirname(operation.backupPath), { recursive: true });
      await this.fs.rename(target, operation.backupPath);
      operation.phase = "backedUp";
      await this.writeRecoveryFile();
    }
    await this.fs.mkdir(dirname(target), { recursive: true });
    await this.fs.rename(staged, target);
    operation.phase = "installed";
    await this.writeRecoveryFile();
  }

  async removePath(target: string): Promise<void> {
    assertWorkspaceTarget(this.workspaceRoot, target);
    if (!(await this.fs.optionalStat(target))) {
      return;
    }
    const operation = this.nextOperation("remove", target, true);
    this.operations.push(operation);
    await this.writeRecoveryFile();
    await this.fs.mkdir(dirname(operation.backupPath), { recursive: true });
    await this.fs.rename(target, operation.backupPath);
    operation.phase = "backedUp";
    await this.writeRecoveryFile();
  }

  async rollback(): Promise<void> {
    const failures: string[] = [];
    for (const operation of [...this.operations].reverse()) {
      if (operation.phase === "rolledBack") {
        continue;
      }
      if (operation.phase === "planned") {
        try {
          await this.assertPlannedOperationMatchesDisk(operation);
        } catch (error) {
          failures.push(`${operation.target}: ${errorSummary(error)}`);
          continue;
        }
        operation.phase = "rolledBack";
        await this.writeRecoveryFile();
        continue;
      }
      if (!this.isRollingBackPhase(operation.phase)) {
        try {
          await this.assertRollbackCanStart(operation);
        } catch (error) {
          failures.push(`${operation.target}: ${errorSummary(error)}`);
          continue;
        }
        const previousPhase = operation.phase;
        operation.phase =
          previousPhase === "installed" ? "rollingBackFromInstalled" : "rollingBackFromBackedUp";
        try {
          await this.writeRecoveryFile();
        } catch (error) {
          operation.phase = previousPhase;
          throw error;
        }
      }
      try {
        await this.rollbackOperation(operation);
      } catch (error) {
        failures.push(`${operation.target}: ${errorSummary(error)}`);
        continue;
      }
      operation.phase = "rolledBack";
      await this.writeRecoveryFile();
    }
    if (failures.length > 0) {
      throw new Error(`Import transaction rollback failed: ${failures.join("; ")}`);
    }
    await this.fs.rm(this.recoveryRoot, { recursive: true, force: true });
  }

  async commit(): Promise<void> {
    await this.fs.rm(this.recoveryRoot, { recursive: true, force: true });
    this.operations = [];
  }

  private nextOperation(
    type: ImportTransactionOperation["type"],
    target: string,
    targetExisted: boolean
  ): ImportTransactionOperation {
    const id = String(this.operations.length + 1).padStart(6, "0");
    return {
      id,
      type,
      target: resolve(target),
      backupPath: join(this.recoveryRoot, "backups", id),
      targetExisted,
      phase: "planned"
    };
  }

  private async rollbackOperation(operation: ImportTransactionOperation): Promise<void> {
    if (!this.isRollingBackPhase(operation.phase)) {
      throw new Error(`rollback operation must be rollingBack, found ${operation.phase}`);
    }
    await this.restoreRollingBackOperation(operation);
  }

  private isRollingBackPhase(
    phase: ImportTransactionOperationPhase
  ): phase is "rollingBackFromInstalled" | "rollingBackFromBackedUp" {
    return phase === "rollingBackFromInstalled" || phase === "rollingBackFromBackedUp";
  }

  private async assertPlannedOperationMatchesDisk(
    operation: ImportTransactionOperation
  ): Promise<void> {
    const targetExists = (await this.fs.optionalStat(operation.target)) !== null;
    const backupExists = (await this.fs.optionalStat(operation.backupPath)) !== null;
    if (backupExists) {
      throw new Error(`planned operation has a backup at ${operation.backupPath}`);
    }
    if (operation.targetExisted && !targetExists) {
      throw new Error("planned operation target is missing");
    }
    if (!operation.targetExisted && targetExists) {
      throw new Error("planned operation has an unexpected target");
    }
  }

  private async assertRollbackCanStart(operation: ImportTransactionOperation): Promise<void> {
    const targetExists = (await this.fs.optionalStat(operation.target)) !== null;
    const backupExists = (await this.fs.optionalStat(operation.backupPath)) !== null;
    switch (operation.phase) {
      case "backedUp":
        if (!operation.targetExisted) {
          throw new Error("backedUp operation cannot target a path that did not exist");
        }
        if (!backupExists) {
          throw new Error(`backup missing at ${operation.backupPath}`);
        }
        if (targetExists) {
          throw new Error(
            `${operation.type} operation target unexpectedly exists while backup is present`
          );
        }
        return;
      case "installed":
        if (operation.targetExisted && !backupExists) {
          throw new Error(`backup missing at ${operation.backupPath}`);
        }
        if (!operation.targetExisted && backupExists) {
          throw new Error(`unexpected backup at ${operation.backupPath}`);
        }
        if (!operation.targetExisted && !targetExists) {
          throw new Error("installed operation target is missing before rollback");
        }
        return;
      default:
        throw new Error(`rollback cannot start from phase ${operation.phase}`);
    }
  }

  private async restoreRollingBackOperation(operation: ImportTransactionOperation): Promise<void> {
    const targetExists = (await this.fs.optionalStat(operation.target)) !== null;
    const backupExists = (await this.fs.optionalStat(operation.backupPath)) !== null;
    if (operation.targetExisted) {
      if (targetExists && !backupExists) {
        return;
      }
      if (!targetExists && backupExists) {
        await this.fs.mkdir(dirname(operation.target), { recursive: true });
        await this.fs.rename(operation.backupPath, operation.target);
        return;
      }
      if (targetExists && backupExists) {
        if (operation.phase === "rollingBackFromBackedUp") {
          throw new Error("backedUp rollback target unexpectedly exists while backup is present");
        }
        await removeRollbackTarget(this.fs, operation.target);
        await this.fs.mkdir(dirname(operation.target), { recursive: true });
        await this.fs.rename(operation.backupPath, operation.target);
        return;
      }
      throw new Error(
        `rollingBack operation cannot be resolved because target and backup are both missing at ${operation.target}`
      );
    }
    if (!targetExists && !backupExists) {
      return;
    }
    if (targetExists && !backupExists) {
      await removeRollbackTarget(this.fs, operation.target);
      return;
    }
    throw new Error(`rollingBack operation has an unexpected backup at ${operation.backupPath}`);
  }

  private async writeRecoveryFile(): Promise<void> {
    const recovery: ImportTransactionRecoveryFile = {
      version: 1,
      transactionId: this.transactionId,
      workspaceRoot: this.workspaceRoot,
      createdAt: this.createdAt,
      operations: this.operations
    };
    await this.fs.writeJsonFile(join(this.recoveryRoot, "recovery.json"), recovery);
  }
}
