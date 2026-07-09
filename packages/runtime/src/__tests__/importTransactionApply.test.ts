import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ImportTransaction } from "../package/importTransaction.js";
import {
  tempWorkspace,
  writeText,
  recoveryRoot,
  realFs
} from "./support/importTransactionTestHarness.js";

describe("ImportTransaction: apply and commit", () => {
  it("cleans the recovery directory on commit", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "commit-cleans";
    const target = join(workspaceRoot, "project-graph.json");
    const staged = join(workspaceRoot, "staged-project-graph.json");
    await writeText(target, "old graph\n");
    await writeFile(staged, "new graph\n", "utf8");
    const transaction = await ImportTransaction.create({ workspaceRoot, transactionId });

    await transaction.replacePath(target, staged);
    await transaction.commit();

    expect(await readFile(target, "utf8")).toBe("new graph\n");
    await expect(access(recoveryRoot(workspaceRoot, transactionId))).rejects.toThrow();
  });

  it("does not roll back the new target when commit cleanup fails", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "commit-cleanup-fails";
    const target = join(workspaceRoot, "project-graph.json");
    const staged = join(workspaceRoot, "staged-project-graph.json");
    const recovery = recoveryRoot(workspaceRoot, transactionId);
    await writeText(target, "old graph\n");
    await writeFile(staged, "new graph\n", "utf8");
    const transaction = await ImportTransaction.create({
      workspaceRoot,
      transactionId,
      fs: {
        ...realFs,
        rm: async (path, options) => {
          if (path === recovery) {
            throw new Error("recovery cleanup failed");
          }
          return rm(path, options);
        }
      }
    });

    await transaction.replacePath(target, staged);
    await expect(transaction.commit()).rejects.toThrow("recovery cleanup failed");

    expect(await readFile(target, "utf8")).toBe("new graph\n");
    await expect(access(join(recovery, "recovery.json"))).resolves.toBeUndefined();
  });

  it("surfaces backup directory write failure without mutating the target", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "backup-dir-fails";
    const target = join(workspaceRoot, "canvases", "default", "package");
    const staged = join(workspaceRoot, "staged-package");
    const backupDir = join(recoveryRoot(workspaceRoot, transactionId), "backups");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "manifest.json"), "old\n", "utf8");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "manifest.json"), "new\n", "utf8");
    const transaction = await ImportTransaction.create({
      workspaceRoot,
      transactionId,
      fs: {
        ...realFs,
        mkdir: async (path, options) => {
          if (path === backupDir) {
            throw new Error("backup directory write failed");
          }
          return mkdir(path, options);
        }
      }
    });

    await expect(transaction.replacePath(target, staged)).rejects.toThrow(
      "backup directory write failed"
    );

    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe("old\n");
    expect(await readFile(join(staged, "manifest.json"), "utf8")).toBe("new\n");
  });
});
