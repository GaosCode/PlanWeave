import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ImportTransaction } from "../package/importTransaction.js";
import {
  tempWorkspace,
  writeText,
  recoveryRoot,
  realFs,
  fsFailWrite,
  fsWithCleanupFailure,
  fsInstallFail,
  readRecovery,
  recoverClean,
  expectOp,
  writeJsonFile
} from "./support/importTransactionTestHarness.js";

describe("ImportTransaction: recovery", () => {
  it("recovers an installed replace rollback after target removal interrupts backup restore", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "recover-installed-replace-rollback";
    const target = join(workspaceRoot, "canvases", "default", "package");
    const staged = join(workspaceRoot, "staged-package");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "manifest.json"), "old\n", "utf8");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "manifest.json"), "new\n", "utf8");
    let backupPath = "";
    let failBackupRestore = false;
    const transaction = await ImportTransaction.create({
      workspaceRoot,
      transactionId,
      fs: {
        ...realFs,
        rename: async (source, destination) => {
          if (failBackupRestore && source === backupPath && destination === target) {
            failBackupRestore = false;
            throw new Error("backup restore interrupted");
          }
          return rename(source, destination);
        }
      }
    });

    await transaction.replacePath(target, staged);
    const recovery = await readRecovery(workspaceRoot, transactionId);
    backupPath = recovery.operations[0]?.backupPath ?? "";
    failBackupRestore = true;

    await expect(transaction.rollback()).rejects.toThrow("backup restore interrupted");

    await expect(access(target)).rejects.toThrow();
    expect(await readFile(join(backupPath, "manifest.json"), "utf8")).toBe("old\n");
    await expect(
      access(join(recoveryRoot(workspaceRoot, transactionId), "recovery.json"))
    ).resolves.toBeUndefined();

    await recoverClean(workspaceRoot, transactionId);

    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe("old\n");
  });

  it("recovers an installed replace from disk and rolls back the backup over the installed target", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "recover-installed-replace";
    const target = join(workspaceRoot, "canvases", "default", "package");
    const staged = join(workspaceRoot, "staged-package");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "manifest.json"), "old\n", "utf8");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "manifest.json"), "new\n", "utf8");
    const transaction = await ImportTransaction.create({ workspaceRoot, transactionId });

    await transaction.replacePath(target, staged);
    const recovery = await readRecovery(workspaceRoot, transactionId);
    const backupPath = recovery.operations[0]?.backupPath ?? "";
    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe("new\n");
    expect(await readFile(join(backupPath, "manifest.json"), "utf8")).toBe("old\n");

    await recoverClean(workspaceRoot, transactionId);

    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe("old\n");
    await expect(access(backupPath)).rejects.toThrow();
  });

  it("recovers multiple operations and rolls them back in reverse order after a later operation is interrupted", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "recover-multiple-operations";
    const firstTarget = join(workspaceRoot, "canvases", "default", "package");
    const firstStaged = join(workspaceRoot, "staged-package");
    const secondTarget = join(workspaceRoot, "canvases", "default", "state.json");
    const secondStaged = join(workspaceRoot, "staged-state.json");
    await mkdir(firstTarget, { recursive: true });
    await writeFile(join(firstTarget, "manifest.json"), "old package\n", "utf8");
    await mkdir(firstStaged, { recursive: true });
    await writeFile(join(firstStaged, "manifest.json"), "new package\n", "utf8");
    await writeText(secondTarget, "old state\n");
    await writeFile(secondStaged, "new state\n", "utf8");
    const transaction = await ImportTransaction.create({
      workspaceRoot,
      transactionId,
      fs: {
        ...realFs,
        rename: async (source, destination) => {
          if (source === secondStaged && destination === secondTarget) {
            throw new Error("second staged install interrupted");
          }
          return rename(source, destination);
        }
      }
    });

    await transaction.replacePath(firstTarget, firstStaged);
    await expect(transaction.replacePath(secondTarget, secondStaged)).rejects.toThrow(
      "second staged install interrupted"
    );

    expect(await readFile(join(firstTarget, "manifest.json"), "utf8")).toBe("new package\n");
    await expect(access(secondTarget)).rejects.toThrow();
    await expect(readRecovery(workspaceRoot, transactionId)).resolves.toMatchObject({
      operations: [
        { target: firstTarget, type: "replace", targetExisted: true, phase: "installed" },
        { target: secondTarget, type: "replace", targetExisted: true, phase: "backedUp" }
      ]
    });

    await recoverClean(workspaceRoot, transactionId);

    expect(await readFile(join(firstTarget, "manifest.json"), "utf8")).toBe("old package\n");
    expect(await readFile(secondTarget, "utf8")).toBe("old state\n");
  });

  it("treats a recovered targetExisted=false installed rollback with missing target as complete", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "recover-installed-new-target-rollback";
    const target = join(workspaceRoot, "canvases", "new", "package");
    const staged = join(workspaceRoot, "staged-package");
    const recovery = recoveryRoot(workspaceRoot, transactionId);
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "manifest.json"), "new\n", "utf8");
    const transaction = await ImportTransaction.create({
      workspaceRoot,
      transactionId,
      fs: fsWithCleanupFailure(recovery)
    });

    await transaction.replacePath(target, staged);
    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe("new\n");

    await expect(transaction.rollback()).rejects.toThrow("recovery cleanup interrupted");

    await expect(access(target)).rejects.toThrow();
    await expect(access(join(recovery, "recovery.json"))).resolves.toBeUndefined();

    await recoverClean(workspaceRoot, transactionId);

    await expect(access(target)).rejects.toThrow();
  });

  it("persists installed replace rollback progress before recovery cleanup", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "installed-replace-rollback-progress";
    const target = join(workspaceRoot, "canvases", "default", "package");
    const staged = join(workspaceRoot, "staged-package");
    const recovery = recoveryRoot(workspaceRoot, transactionId);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "manifest.json"), "old\n", "utf8");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "manifest.json"), "new\n", "utf8");
    const transaction = await ImportTransaction.create({
      workspaceRoot,
      transactionId,
      fs: fsWithCleanupFailure(recovery)
    });

    await transaction.replacePath(target, staged);
    const backupPath =
      (await readRecovery(workspaceRoot, transactionId)).operations[0]?.backupPath ?? "";

    await expect(transaction.rollback()).rejects.toThrow("recovery cleanup interrupted");

    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe("old\n");
    await expect(access(backupPath)).rejects.toThrow();
    await expectOp(workspaceRoot, transactionId, {
      target,
      type: "replace",
      targetExisted: true,
      phase: "rolledBack"
    });

    await recoverClean(workspaceRoot, transactionId);

    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe("old\n");
  });

  it("recovers a replaced path from disk after backup succeeds before staged install", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "recover-backed-up-replace";
    const target = join(workspaceRoot, "canvases", "default", "package");
    const staged = join(workspaceRoot, "staged-package");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "manifest.json"), "old\n", "utf8");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "manifest.json"), "new\n", "utf8");
    const transaction = await ImportTransaction.create({
      workspaceRoot,
      transactionId,
      fs: fsInstallFail(staged, target)
    });

    await expect(transaction.replacePath(target, staged)).rejects.toThrow(
      "staged install interrupted"
    );
    await expect(access(target)).rejects.toThrow();
    await expectOp(workspaceRoot, transactionId, {
      target,
      type: "replace",
      targetExisted: true,
      phase: "backedUp"
    });

    await recoverClean(workspaceRoot, transactionId);

    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe("old\n");
  });

  it("persists backedUp replace rollback progress before recovery cleanup", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "backed-up-replace-rollback-progress";
    const target = join(workspaceRoot, "canvases", "default", "package");
    const staged = join(workspaceRoot, "staged-package");
    const recovery = recoveryRoot(workspaceRoot, transactionId);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "manifest.json"), "old\n", "utf8");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "manifest.json"), "new\n", "utf8");
    const transaction = await ImportTransaction.create({
      workspaceRoot,
      transactionId,
      fs: {
        ...fsWithCleanupFailure(recovery),
        rename: fsInstallFail(staged, target).rename
      }
    });

    await expect(transaction.replacePath(target, staged)).rejects.toThrow(
      "staged install interrupted"
    );
    const backupPath =
      (await readRecovery(workspaceRoot, transactionId)).operations[0]?.backupPath ?? "";
    await expect(access(target)).rejects.toThrow();
    expect(await readFile(join(backupPath, "manifest.json"), "utf8")).toBe("old\n");

    await expect(transaction.rollback()).rejects.toThrow("recovery cleanup interrupted");

    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe("old\n");
    await expect(access(backupPath)).rejects.toThrow();
    await expectOp(workspaceRoot, transactionId, {
      target,
      type: "replace",
      targetExisted: true,
      phase: "rolledBack"
    });

    await recoverClean(workspaceRoot, transactionId);

    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe("old\n");
  });

  it("persists backedUp remove rollback progress before recovery cleanup", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "backed-up-remove-rollback-progress";
    const target = join(workspaceRoot, "canvases", "stale", "results");
    const recovery = recoveryRoot(workspaceRoot, transactionId);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "old.txt"), "old result\n", "utf8");
    const transaction = await ImportTransaction.create({
      workspaceRoot,
      transactionId,
      fs: fsWithCleanupFailure(recovery)
    });

    await transaction.removePath(target);
    const backupPath =
      (await readRecovery(workspaceRoot, transactionId)).operations[0]?.backupPath ?? "";

    await expect(transaction.rollback()).rejects.toThrow("recovery cleanup interrupted");

    expect(await readFile(join(target, "old.txt"), "utf8")).toBe("old result\n");
    await expect(access(backupPath)).rejects.toThrow();
    await expectOp(workspaceRoot, transactionId, {
      target,
      type: "remove",
      targetExisted: true,
      phase: "rolledBack"
    });

    await recoverClean(workspaceRoot, transactionId);

    expect(await readFile(join(target, "old.txt"), "utf8")).toBe("old result\n");
  });

  it("recovers a removed path from disk after backup succeeds", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "recover-backed-up-remove";
    const target = join(workspaceRoot, "canvases", "stale", "results");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "old.txt"), "old result\n", "utf8");
    const transaction = await ImportTransaction.create({ workspaceRoot, transactionId });

    await transaction.removePath(target);
    await expect(access(target)).rejects.toThrow();
    await expectOp(workspaceRoot, transactionId, {
      target,
      type: "remove",
      targetExisted: true,
      phase: "backedUp"
    });

    await recoverClean(workspaceRoot, transactionId);

    expect(await readFile(join(target, "old.txt"), "utf8")).toBe("old result\n");
  });

  it("persists recovery intent before backing up the target", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "backup-phase-write-fails";
    const target = join(workspaceRoot, "canvases", "default", "package");
    const staged = join(workspaceRoot, "staged-package");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "manifest.json"), "old\n", "utf8");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "manifest.json"), "new\n", "utf8");
    let recoveryWrites = 0;
    const transaction = await ImportTransaction.create({
      workspaceRoot,
      transactionId,
      fs: {
        ...realFs,
        writeJsonFile: async (path, value) => {
          recoveryWrites += 1;
          if (recoveryWrites === 3) {
            throw new Error("backedUp phase write failed");
          }
          return writeJsonFile(path, value);
        }
      }
    });

    await expect(transaction.replacePath(target, staged)).rejects.toThrow(
      "backedUp phase write failed"
    );

    const recovery = await readRecovery(workspaceRoot, transactionId);
    expect(recovery.operations).toMatchObject([
      { target, type: "replace", targetExisted: true, phase: "planned" }
    ]);
    const backupPath = recovery.operations[0]?.backupPath ?? "";
    expect(await readFile(join(backupPath, "manifest.json"), "utf8")).toBe("old\n");
    await expect(access(target)).rejects.toThrow();
    expect(await readFile(join(staged, "manifest.json"), "utf8")).toBe("new\n");
  });

  it("keeps recovery when persisted phase conflicts with disk state", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "phase-conflict";
    const target = join(workspaceRoot, "canvases", "default", "package");
    const staged = join(workspaceRoot, "staged-package");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "manifest.json"), "old\n", "utf8");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "manifest.json"), "new\n", "utf8");
    let recoveryWrites = 0;
    const transaction = await ImportTransaction.create({
      workspaceRoot,
      transactionId,
      fs: {
        ...realFs,
        writeJsonFile: async (path, value) => {
          recoveryWrites += 1;
          if (recoveryWrites === 3) {
            throw new Error("backedUp phase write failed");
          }
          return writeJsonFile(path, value);
        }
      }
    });

    await expect(transaction.replacePath(target, staged)).rejects.toThrow(
      "backedUp phase write failed"
    );

    const recovered = await ImportTransaction.recover({ workspaceRoot, transactionId });
    await expect(recovered.rollback()).rejects.toThrow("planned operation has a backup");
    await expect(
      access(join(recoveryRoot(workspaceRoot, transactionId), "recovery.json"))
    ).resolves.toBeUndefined();
  });

  it("does not delete an installed replacement when persisted phase is still backedUp", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "installed-phase-write-fails";
    const target = join(workspaceRoot, "canvases", "default", "package");
    const staged = join(workspaceRoot, "staged-package");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "manifest.json"), "old\n", "utf8");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "manifest.json"), "new\n", "utf8");
    let recoveryWrites = 0;
    const transaction = await ImportTransaction.create({
      workspaceRoot,
      transactionId,
      fs: {
        ...realFs,
        writeJsonFile: async (path, value) => {
          recoveryWrites += 1;
          if (recoveryWrites === 4) {
            throw new Error("installed phase write failed");
          }
          return writeJsonFile(path, value);
        }
      }
    });

    await expect(transaction.replacePath(target, staged)).rejects.toThrow(
      "installed phase write failed"
    );

    const recovery = await readRecovery(workspaceRoot, transactionId);
    expect(recovery.operations).toMatchObject([
      { target, type: "replace", targetExisted: true, phase: "backedUp" }
    ]);
    const backupPath = recovery.operations[0]?.backupPath ?? "";
    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe("new\n");
    expect(await readFile(join(backupPath, "manifest.json"), "utf8")).toBe("old\n");

    const recovered = await ImportTransaction.recover({ workspaceRoot, transactionId });
    await expect(recovered.rollback()).rejects.toThrow(
      "replace operation target unexpectedly exists while backup is present"
    );

    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe("new\n");
    expect(await readFile(join(backupPath, "manifest.json"), "utf8")).toBe("old\n");
    await expect(
      access(join(recoveryRoot(workspaceRoot, transactionId), "recovery.json"))
    ).resolves.toBeUndefined();
  });

  it("skips rollback operations that were already persisted as rolledBack after a later operation succeeds", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "multi-operation-rollback-progress";
    const firstTarget = join(workspaceRoot, "canvases", "default", "package");
    const firstStaged = join(workspaceRoot, "staged-package");
    const secondTarget = join(workspaceRoot, "canvases", "default", "state.json");
    const secondStaged = join(workspaceRoot, "staged-state.json");
    await mkdir(firstTarget, { recursive: true });
    await writeFile(join(firstTarget, "manifest.json"), "old package\n", "utf8");
    await mkdir(firstStaged, { recursive: true });
    await writeFile(join(firstStaged, "manifest.json"), "new package\n", "utf8");
    await writeText(secondTarget, "old state\n");
    await writeFile(secondStaged, "new state\n", "utf8");
    let firstBackupPath = "";
    let failFirstBackupRestore = false;
    const transaction = await ImportTransaction.create({
      workspaceRoot,
      transactionId,
      fs: {
        ...realFs,
        rename: async (source, destination) => {
          if (failFirstBackupRestore && source === firstBackupPath && destination === firstTarget) {
            failFirstBackupRestore = false;
            throw new Error("first backup restore interrupted");
          }
          return rename(source, destination);
        }
      }
    });

    await transaction.replacePath(firstTarget, firstStaged);
    await transaction.replacePath(secondTarget, secondStaged);
    const recoveryBeforeRollback = await readRecovery(workspaceRoot, transactionId);
    firstBackupPath = recoveryBeforeRollback.operations[0]?.backupPath ?? "";
    const secondBackupPath = recoveryBeforeRollback.operations[1]?.backupPath ?? "";
    failFirstBackupRestore = true;

    await expect(transaction.rollback()).rejects.toThrow("first backup restore interrupted");

    await expect(access(firstTarget)).rejects.toThrow();
    expect(await readFile(join(firstBackupPath, "manifest.json"), "utf8")).toBe("old package\n");
    expect(await readFile(secondTarget, "utf8")).toBe("old state\n");
    await expect(access(secondBackupPath)).rejects.toThrow();
    await expect(readRecovery(workspaceRoot, transactionId)).resolves.toMatchObject({
      operations: [
        {
          target: firstTarget,
          type: "replace",
          targetExisted: true,
          phase: "rollingBackFromInstalled"
        },
        { target: secondTarget, type: "replace", targetExisted: true, phase: "rolledBack" }
      ]
    });

    const recovered = await ImportTransaction.recover({ workspaceRoot, transactionId });
    await recovered.rollback();

    expect(await readFile(join(firstTarget, "manifest.json"), "utf8")).toBe("old package\n");
    expect(await readFile(secondTarget, "utf8")).toBe("old state\n");
    await expect(access(recoveryRoot(workspaceRoot, transactionId))).rejects.toThrow();
  });

  it("rolls back a recovered installed replace when target and backup both exist", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "recovered-installed-normal";
    const target = join(workspaceRoot, "canvases", "default", "package");
    const staged = join(workspaceRoot, "staged-package");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "manifest.json"), "old\n", "utf8");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "manifest.json"), "new\n", "utf8");
    const transaction = await ImportTransaction.create({ workspaceRoot, transactionId });

    await transaction.replacePath(target, staged);
    const recovery = await readRecovery(workspaceRoot, transactionId);
    const backupPath = recovery.operations[0]?.backupPath ?? "";
    const recovered = await ImportTransaction.recover({ workspaceRoot, transactionId });

    await recovered.rollback();

    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe("old\n");
    await expect(access(backupPath)).rejects.toThrow();
    await expect(access(recoveryRoot(workspaceRoot, transactionId))).rejects.toThrow();
  });

  it("keeps recovery when a backedUp rollback sees an external target next to the backup", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "backed-up-external-target";
    const target = join(workspaceRoot, "state.json");
    const staged = join(workspaceRoot, "staged.json");
    await writeText(target, "old state\n");
    await writeFile(staged, "new state\n", "utf8");
    let backupPath = "";
    const transaction = await ImportTransaction.create({
      workspaceRoot,
      transactionId,
      fs: {
        ...realFs,
        rename: async (source, destination) => {
          if (source === staged && destination === target) {
            throw new Error("staged install interrupted");
          }
          if (source === backupPath && destination === target) {
            throw new Error("backup restore interrupted");
          }
          return rename(source, destination);
        }
      }
    });

    await expect(transaction.replacePath(target, staged)).rejects.toThrow(
      "staged install interrupted"
    );
    backupPath = (await readRecovery(workspaceRoot, transactionId)).operations[0]?.backupPath ?? "";
    await expect(transaction.rollback()).rejects.toThrow("backup restore interrupted");

    await writeText(target, "external state\n");
    const recovered = await ImportTransaction.recover({ workspaceRoot, transactionId });
    await expect(recovered.rollback()).rejects.toThrow(
      "backedUp rollback target unexpectedly exists while backup is present"
    );

    expect(await readFile(target, "utf8")).toBe("external state\n");
    expect(await readFile(backupPath, "utf8")).toBe("old state\n");
    await expectOp(workspaceRoot, transactionId, {
      target,
      type: "replace",
      targetExisted: true,
      phase: "rollingBackFromBackedUp"
    });
  });

  it("recovers an installed replace when rolledBack progress cannot be persisted after target restore", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "installed-rolled-back-write-fails";
    const target = join(workspaceRoot, "canvases", "default", "state.json");
    const staged = join(workspaceRoot, "staged-state.json");
    await writeText(target, "old state\n");
    await writeFile(staged, "new state\n", "utf8");
    const transaction = await ImportTransaction.create({
      workspaceRoot,
      transactionId,
      fs: fsFailWrite(6, "rolledBack phase write failed")
    });

    await transaction.replacePath(target, staged);
    await expect(transaction.rollback()).rejects.toThrow("rolledBack phase write failed");

    expect(await readFile(target, "utf8")).toBe("old state\n");
    await expectOp(workspaceRoot, transactionId, {
      target,
      type: "replace",
      targetExisted: true,
      phase: "rollingBackFromInstalled"
    });

    await recoverClean(workspaceRoot, transactionId);

    expect(await readFile(target, "utf8")).toBe("old state\n");
  });

  it("recovers a backedUp replace when rolledBack progress cannot be persisted after target restore", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "backed-up-replace-rolled-back-write-fails";
    const target = join(workspaceRoot, "canvases", "default", "package");
    const staged = join(workspaceRoot, "staged-package");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "manifest.json"), "old\n", "utf8");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "manifest.json"), "new\n", "utf8");
    const transaction = await ImportTransaction.create({
      workspaceRoot,
      transactionId,
      fs: {
        ...fsFailWrite(5, "rolledBack phase write failed"),
        rename: fsInstallFail(staged, target).rename
      }
    });

    await expect(transaction.replacePath(target, staged)).rejects.toThrow(
      "staged install interrupted"
    );
    await expect(transaction.rollback()).rejects.toThrow("rolledBack phase write failed");

    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe("old\n");
    await expectOp(workspaceRoot, transactionId, {
      target,
      type: "replace",
      targetExisted: true,
      phase: "rollingBackFromBackedUp"
    });

    await recoverClean(workspaceRoot, transactionId);

    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe("old\n");
  });

  it("recovers a backedUp remove when rolledBack progress cannot be persisted after target restore", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "backed-up-remove-rolled-back-write-fails";
    const target = join(workspaceRoot, "canvases", "stale", "results");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "old.txt"), "old result\n", "utf8");
    const transaction = await ImportTransaction.create({
      workspaceRoot,
      transactionId,
      fs: fsFailWrite(5, "rolledBack phase write failed")
    });

    await transaction.removePath(target);
    await expect(transaction.rollback()).rejects.toThrow("rolledBack phase write failed");

    expect(await readFile(join(target, "old.txt"), "utf8")).toBe("old result\n");
    await expectOp(workspaceRoot, transactionId, {
      target,
      type: "remove",
      targetExisted: true,
      phase: "rollingBackFromBackedUp"
    });

    await recoverClean(workspaceRoot, transactionId);

    expect(await readFile(join(target, "old.txt"), "utf8")).toBe("old result\n");
  });

  it("recovers a new target rollback when rolledBack progress cannot be persisted after target removal", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "new-target-rolled-back-write-fails";
    const target = join(workspaceRoot, "canvases", "new", "package");
    const staged = join(workspaceRoot, "staged-package");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "manifest.json"), "new\n", "utf8");
    const transaction = await ImportTransaction.create({
      workspaceRoot,
      transactionId,
      fs: fsFailWrite(5, "rolledBack phase write failed")
    });

    await transaction.replacePath(target, staged);
    await expect(transaction.rollback()).rejects.toThrow("rolledBack phase write failed");

    await expect(access(target)).rejects.toThrow();
    await expectOp(workspaceRoot, transactionId, {
      target,
      type: "replace",
      targetExisted: false,
      phase: "rollingBackFromInstalled"
    });

    await recoverClean(workspaceRoot, transactionId);

    await expect(access(target)).rejects.toThrow();
  });
});
