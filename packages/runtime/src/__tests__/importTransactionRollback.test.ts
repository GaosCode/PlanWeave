import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ImportTransaction } from "../package/importTransaction.js";
import { tempWorkspace, writeText, recoveryRoot, fsFailWrite, expectOp } from "./support/importTransactionTestHarness.js";

describe("ImportTransaction: rollback", () => {
  it("restores a replaced path on rollback", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "replace-rollback";
    const target = join(workspaceRoot, "canvases", "default", "package");
    const staged = join(workspaceRoot, "staged-package");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "manifest.json"), "old\n", "utf8");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "manifest.json"), "new\n", "utf8");
    const transaction = await ImportTransaction.create({ workspaceRoot, transactionId });

    await transaction.replacePath(target, staged);
    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe("new\n");
    await expectOp(workspaceRoot, transactionId, { target, type: "replace", targetExisted: true, phase: "installed" });

    await transaction.rollback();

    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe("old\n");
    await expect(access(recoveryRoot(workspaceRoot, transactionId))).rejects.toThrow();
  });

  it("removes a replacement when the target did not exist before rollback", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "missing-target-rollback";
    const target = join(workspaceRoot, "canvases", "new", "package");
    const staged = join(workspaceRoot, "staged-package");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "manifest.json"), "new\n", "utf8");
    const transaction = await ImportTransaction.create({ workspaceRoot, transactionId });

    await transaction.replacePath(target, staged);
    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe("new\n");

    await transaction.rollback();

    await expect(access(target)).rejects.toThrow();
    await expect(access(recoveryRoot(workspaceRoot, transactionId))).rejects.toThrow();
  });

  it("restores a removed path on rollback", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "remove-rollback";
    const target = join(workspaceRoot, "canvases", "stale", "results");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "old.txt"), "old result\n", "utf8");
    const transaction = await ImportTransaction.create({ workspaceRoot, transactionId });

    await transaction.removePath(target);
    await expect(access(target)).rejects.toThrow();

    await transaction.rollback();

    expect(await readFile(join(target, "old.txt"), "utf8")).toBe("old result\n");
    await expect(access(recoveryRoot(workspaceRoot, transactionId))).rejects.toThrow();
  });

  it("reports a missing backup without deleting the replacement target", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "missing-backup";
    const target = join(workspaceRoot, "canvases", "default", "state.json");
    const staged = join(workspaceRoot, "staged-state.json");
    await writeText(target, "old state\n");
    await writeFile(staged, "new state\n", "utf8");
    const transaction = await ImportTransaction.create({ workspaceRoot, transactionId });

    await transaction.replacePath(target, staged);
    await rm(join(recoveryRoot(workspaceRoot, transactionId), "backups", "000001"), { recursive: true, force: true });

    await expect(transaction.rollback()).rejects.toThrow("backup missing");

    expect(await readFile(target, "utf8")).toBe("new state\n");
    await expect(access(join(recoveryRoot(workspaceRoot, transactionId), "recovery.json"))).resolves.toBeUndefined();
  });

  it("reports a backedUp missing backup without treating rollback as complete", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "backed-up-missing-backup";
    const target = join(workspaceRoot, "canvases", "stale", "results");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "old.txt"), "old result\n", "utf8");
    const transaction = await ImportTransaction.create({ workspaceRoot, transactionId });

    await transaction.removePath(target);
    await rm(join(recoveryRoot(workspaceRoot, transactionId), "backups", "000001"), { recursive: true, force: true });

    await expect(transaction.rollback()).rejects.toThrow("backup missing");

    await expect(access(target)).rejects.toThrow();
    await expectOp(workspaceRoot, transactionId, { target, type: "remove", targetExisted: true, phase: "backedUp" });
  });

  it("does not mutate disk when rollingBack progress cannot be persisted", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "rolling-back-progress-write-fails";
    const target = join(workspaceRoot, "canvases", "default", "state.json");
    const staged = join(workspaceRoot, "staged-state.json");
    await writeText(target, "old state\n");
    await writeFile(staged, "new state\n", "utf8");
    const transaction = await ImportTransaction.create({
      workspaceRoot,
      transactionId,
      fs: fsFailWrite(5, "rollback progress write failed")
    });

    await transaction.replacePath(target, staged);
    await expect(transaction.rollback()).rejects.toThrow("rollback progress write failed");

    expect(await readFile(target, "utf8")).toBe("new state\n");
    await expectOp(workspaceRoot, transactionId, { target, type: "replace", targetExisted: true, phase: "installed" });
    await expect(access(recoveryRoot(workspaceRoot, transactionId))).resolves.toBeUndefined();
  });

  it("keeps recovery.json when rollback fails", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "rollback-fails";
    const target = join(workspaceRoot, "canvases", "default", "state.json");
    const staged = join(workspaceRoot, "staged-state.json");
    await writeText(target, "old state\n");
    await writeFile(staged, "new state\n", "utf8");
    const transaction = await ImportTransaction.create({ workspaceRoot, transactionId });

    await transaction.replacePath(target, staged);
    await rm(join(workspaceRoot, "canvases", "default"), { recursive: true, force: true });
    await writeFile(join(workspaceRoot, "canvases", "default"), "not a directory\n", "utf8");

    await expect(transaction.rollback()).rejects.toThrow("Import transaction rollback failed");

    const recovery = JSON.parse(await readFile(join(recoveryRoot(workspaceRoot, transactionId), "recovery.json"), "utf8")) as {
      operations: Array<{ target: string; type: string }>;
    };
    expect(recovery.operations).toContainEqual(expect.objectContaining({ target, type: "replace" }));
  });
});
