import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { ServerDataArchiveError } from "./serverDataArchiveError.js";

export const SERVER_DATA_RESTORE_BACKUP_PREFIX = ".planweave-server-replaced-";

export type ServerDataRestorePromotionOperations = {
  createDirectory(path: string): Promise<void>;
  listNames(path: string): Promise<string[]>;
  move(source: string, destination: string): Promise<void>;
  remove(path: string): Promise<void>;
};

const filesystemPromotionOperations: ServerDataRestorePromotionOperations = {
  async createDirectory(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  async listNames(path) {
    return readdir(path);
  },
  async move(source, destination) {
    await rename(source, destination);
  },
  async remove(path) {
    await rm(path, { recursive: true, force: true });
  }
};

function promotionError(code: string, cause: unknown, recoveryFailures: unknown[] = []) {
  const preservedCause =
    recoveryFailures.length === 0 ? cause : new AggregateError([cause, ...recoveryFailures], code);
  return new ServerDataArchiveError(code, { cause: preservedCause });
}

async function restoreOriginalEntries(input: {
  target: string;
  backup: string;
  names: readonly string[];
  operations: ServerDataRestorePromotionOperations;
}): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const name of [...input.names].reverse()) {
    try {
      await input.operations.move(join(input.backup, name), join(input.target, name));
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function removePromotedEntries(input: {
  target: string;
  names: readonly string[];
  operations: ServerDataRestorePromotionOperations;
}): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const name of [...input.names].reverse()) {
    try {
      await input.operations.remove(join(input.target, name));
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function removeEmptyBackup(
  backup: string,
  operations: ServerDataRestorePromotionOperations,
  failures: unknown[]
): Promise<void> {
  if (failures.length > 0) return;
  try {
    await operations.remove(backup);
  } catch (error) {
    failures.push(error);
  }
}

export async function promoteRestoredDirectory(
  target: string,
  staging: string,
  operations: ServerDataRestorePromotionOperations = filesystemPromotionOperations
): Promise<void> {
  const stagingName = basename(staging);
  const backup = join(target, `${SERVER_DATA_RESTORE_BACKUP_PREFIX}${randomUUID()}`);
  try {
    await operations.createDirectory(backup);
  } catch (error) {
    throw promotionError("server_data_restore_backup_prepare_failed", error);
  }

  let originalNames: string[];
  try {
    originalNames = (await operations.listNames(target))
      .filter((name) => name !== stagingName && name !== basename(backup))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    const recoveryFailures: unknown[] = [];
    await removeEmptyBackup(backup, operations, recoveryFailures);
    throw promotionError("server_data_restore_backup_prepare_failed", error, recoveryFailures);
  }

  const backedUpNames: string[] = [];
  try {
    for (const name of originalNames) {
      await operations.move(join(target, name), join(backup, name));
      backedUpNames.push(name);
    }
  } catch (error) {
    const recoveryFailures = await restoreOriginalEntries({
      target,
      backup,
      names: backedUpNames,
      operations
    });
    await removeEmptyBackup(backup, operations, recoveryFailures);
    throw promotionError("server_data_restore_backup_prepare_failed", error, recoveryFailures);
  }

  let stagingNames: string[];
  try {
    stagingNames = (await operations.listNames(staging)).sort((left, right) =>
      left.localeCompare(right)
    );
  } catch (error) {
    const recoveryFailures = await restoreOriginalEntries({
      target,
      backup,
      names: backedUpNames,
      operations
    });
    await removeEmptyBackup(backup, operations, recoveryFailures);
    throw promotionError("server_data_restore_promotion_failed", error, recoveryFailures);
  }

  const promotedNames: string[] = [];
  try {
    for (const name of stagingNames) {
      await operations.move(join(staging, name), join(target, name));
      promotedNames.push(name);
    }
  } catch (error) {
    const recoveryFailures = await removePromotedEntries({
      target,
      names: promotedNames,
      operations
    });
    recoveryFailures.push(
      ...(await restoreOriginalEntries({
        target,
        backup,
        names: backedUpNames,
        operations
      }))
    );
    await removeEmptyBackup(backup, operations, recoveryFailures);
    throw promotionError("server_data_restore_promotion_failed", error, recoveryFailures);
  }

  const cleanupFailures: unknown[] = [];
  for (const path of [staging, backup]) {
    try {
      await operations.remove(path);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupFailures.length > 0) {
    throw promotionError(
      "server_data_restore_committed_cleanup_failed",
      cleanupFailures[0],
      cleanupFailures.slice(1)
    );
  }
}
