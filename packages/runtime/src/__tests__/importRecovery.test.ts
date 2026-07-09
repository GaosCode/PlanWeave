import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeJsonFile } from "../json.js";
import {
  listPendingImportTransactions,
  rollbackPendingImportTransaction
} from "../package/importRecovery.js";
import { ImportTransaction } from "../package/importTransaction.js";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "planweave-import-recovery-"));
}

function recoveryRoot(workspaceRoot: string, transactionId: string): string {
  return join(workspaceRoot, "desktop", "recovery", "package-import", transactionId);
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function writeRecovery(options: {
  workspaceRoot: string;
  transactionId: string;
  createdAt: string;
  operations?: unknown[];
  recoveryWorkspaceRoot?: string;
}): Promise<void> {
  const root = recoveryRoot(options.workspaceRoot, options.transactionId);
  await mkdir(root, { recursive: true });
  await writeJsonFile(join(root, "recovery.json"), {
    version: 1,
    transactionId: options.transactionId,
    workspaceRoot: options.recoveryWorkspaceRoot ?? options.workspaceRoot,
    createdAt: options.createdAt,
    operations: options.operations ?? []
  });
}

describe("import recovery", () => {
  it("returns an empty list when the recovery directory is missing", async () => {
    const workspaceRoot = await tempWorkspace();

    await expect(listPendingImportTransactions(workspaceRoot)).resolves.toEqual([]);
  });

  it("returns an empty list when the recovery directory has no transactions", async () => {
    const workspaceRoot = await tempWorkspace();
    await mkdir(join(workspaceRoot, "desktop", "recovery", "package-import"), { recursive: true });

    await expect(listPendingImportTransactions(workspaceRoot)).resolves.toEqual([]);
  });

  it("lists pending transactions sorted by createdAt and transactionId", async () => {
    const workspaceRoot = await tempWorkspace();
    await writeRecovery({
      workspaceRoot,
      transactionId: "tx-b",
      createdAt: "2026-01-02T00:00:00.000Z"
    });
    await writeRecovery({
      workspaceRoot,
      transactionId: "tx-c",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    await writeRecovery({
      workspaceRoot,
      transactionId: "tx-a",
      createdAt: "2026-01-01T00:00:00.000Z"
    });

    await expect(listPendingImportTransactions(workspaceRoot)).resolves.toMatchObject([
      {
        transactionId: "tx-a",
        createdAt: "2026-01-01T00:00:00.000Z",
        operationCount: 0,
        phases: []
      },
      {
        transactionId: "tx-c",
        createdAt: "2026-01-01T00:00:00.000Z",
        operationCount: 0,
        phases: []
      },
      {
        transactionId: "tx-b",
        createdAt: "2026-01-02T00:00:00.000Z",
        operationCount: 0,
        phases: []
      }
    ]);
  });

  it("fails fast when a recovery file is invalid", async () => {
    const workspaceRoot = await tempWorkspace();
    const root = recoveryRoot(workspaceRoot, "invalid");
    await mkdir(root, { recursive: true });
    await writeJsonFile(join(root, "recovery.json"), {
      version: 2,
      transactionId: "invalid",
      workspaceRoot,
      createdAt: "2026-01-01T00:00:00.000Z",
      operations: []
    });

    await expect(listPendingImportTransactions(workspaceRoot)).rejects.toThrow(
      "Unsupported import transaction recovery file version"
    );
  });

  it("fails fast when a recovery transaction directory name is not a single path segment", async () => {
    const workspaceRoot = await tempWorkspace();
    const root = recoveryRoot(workspaceRoot, "invalid id");
    await mkdir(root, { recursive: true });

    await expect(listPendingImportTransactions(workspaceRoot)).rejects.toThrow(
      "Invalid import transaction id"
    );
  });

  it("rejects invalid transaction ids before creating recovery state", async () => {
    const workspaceRoot = await tempWorkspace();
    const invalidIds = ["", ".", "..", "tx/id", "tx\\id", "tx id"];

    for (const transactionId of invalidIds) {
      await expect(ImportTransaction.create({ workspaceRoot, transactionId })).rejects.toThrow(
        "Invalid import transaction id"
      );
    }
  });

  it("rejects rollback transaction id path traversal", async () => {
    const workspaceRoot = await tempWorkspace();

    await expect(
      rollbackPendingImportTransaction({
        workspaceRoot,
        transactionId: "../../../../tmp/pw"
      })
    ).rejects.toThrow("Invalid import transaction id");
  });

  it("rejects recovery files whose transaction id is not a single path segment", async () => {
    const workspaceRoot = await tempWorkspace();
    await writeRecovery({
      workspaceRoot,
      transactionId: "valid-id",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    await writeJsonFile(join(recoveryRoot(workspaceRoot, "valid-id"), "recovery.json"), {
      version: 1,
      transactionId: "tx/id",
      workspaceRoot,
      createdAt: "2026-01-01T00:00:00.000Z",
      operations: []
    });

    await expect(listPendingImportTransactions(workspaceRoot)).rejects.toThrow(
      "Invalid import transaction id"
    );
  });

  it("fails when a recovery belongs to another workspace", async () => {
    const workspaceRoot = await tempWorkspace();
    const otherWorkspaceRoot = await tempWorkspace();
    await writeRecovery({
      workspaceRoot,
      transactionId: "workspace-mismatch",
      createdAt: "2026-01-01T00:00:00.000Z",
      recoveryWorkspaceRoot: otherWorkspaceRoot
    });

    await expect(listPendingImportTransactions(workspaceRoot)).rejects.toThrow(
      "Import transaction recovery workspace mismatch"
    );
  });

  it("rolls back a pending transaction and cleans its recovery directory", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "rollback-success";
    const target = join(workspaceRoot, "canvases", "default", "state.json");
    const staged = join(workspaceRoot, "staged-state.json");
    await writeText(target, "old state\n");
    await writeFile(staged, "new state\n", "utf8");
    const transaction = await ImportTransaction.create({ workspaceRoot, transactionId });
    await transaction.replacePath(target, staged);

    await expect(listPendingImportTransactions(workspaceRoot)).resolves.toMatchObject([
      {
        transactionId,
        recoveryRoot: recoveryRoot(workspaceRoot, transactionId),
        operationCount: 1,
        phases: ["installed"]
      }
    ]);

    await rollbackPendingImportTransaction({ workspaceRoot, transactionId });

    expect(await readFile(target, "utf8")).toBe("old state\n");
    await expect(access(recoveryRoot(workspaceRoot, transactionId))).rejects.toThrow();
  });

  it("keeps recovery when rollback fails and propagates the error", async () => {
    const workspaceRoot = await tempWorkspace();
    const transactionId = "rollback-failure";
    const target = join(workspaceRoot, "canvases", "default", "state.json");
    const staged = join(workspaceRoot, "staged-state.json");
    await writeText(target, "old state\n");
    await writeFile(staged, "new state\n", "utf8");
    const transaction = await ImportTransaction.create({ workspaceRoot, transactionId });
    await transaction.replacePath(target, staged);
    await rm(join(recoveryRoot(workspaceRoot, transactionId), "backups", "000001"), {
      recursive: true,
      force: true
    });

    await expect(
      rollbackPendingImportTransaction({ workspaceRoot, transactionId })
    ).rejects.toThrow("backup missing");

    await expect(
      access(join(recoveryRoot(workspaceRoot, transactionId), "recovery.json"))
    ).resolves.toBeUndefined();
  });
});
