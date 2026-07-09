import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listPendingImportRecoveries,
  rollbackPendingImportRecovery
} from "../desktop/importRecoveryApi.js";
import { initWorkspace } from "../initWorkspace.js";
import { ImportTransaction } from "../package/importTransaction.js";

const previousPlanweaveHome = process.env.PLANWEAVE_HOME;

afterEach(() => {
  if (previousPlanweaveHome === undefined) {
    delete process.env.PLANWEAVE_HOME;
  } else {
    process.env.PLANWEAVE_HOME = previousPlanweaveHome;
  }
});

function recoveryRoot(workspaceRoot: string, transactionId: string): string {
  return join(workspaceRoot, "desktop", "recovery", "package-import", transactionId);
}

async function createExternalProject(): Promise<{ sourceRoot: string; workspaceRoot: string }> {
  process.env.PLANWEAVE_HOME = await mkdtemp(join(tmpdir(), "planweave-home-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "planweave-source-"));
  const init = await initWorkspace({ projectRoot: sourceRoot });
  expect(init.workspace.workspaceRoot).not.toBe(init.workspace.rootPath);
  return { sourceRoot, workspaceRoot: init.workspace.workspaceRoot };
}

async function createPendingReplaceTransaction(options: {
  workspaceRoot: string;
  transactionId: string;
}): Promise<{ target: string }> {
  const target = join(options.workspaceRoot, "canvases", "default", "state.json");
  const staged = join(options.workspaceRoot, "staged-state.json");
  await mkdir(join(options.workspaceRoot, "canvases", "default"), { recursive: true });
  await writeFile(target, "old state\n", "utf8");
  await writeFile(staged, "new state\n", "utf8");
  const transaction = await ImportTransaction.create({
    workspaceRoot: options.workspaceRoot,
    transactionId: options.transactionId
  });
  await transaction.replacePath(target, staged);
  return { target };
}

describe("desktop import recovery API", () => {
  it("lists and rolls back external project recoveries through the source root", async () => {
    const { sourceRoot, workspaceRoot } = await createExternalProject();
    const transactionId = "external-desktop-rollback";
    const { target } = await createPendingReplaceTransaction({ workspaceRoot, transactionId });

    await expect(listPendingImportRecoveries(sourceRoot)).resolves.toMatchObject([
      {
        transactionId,
        recoveryRoot: recoveryRoot(workspaceRoot, transactionId),
        operationCount: 1,
        phases: ["installed"]
      }
    ]);

    await rollbackPendingImportRecovery(sourceRoot, transactionId);

    await expect(readFile(target, "utf8")).resolves.toBe("old state\n");
    await expect(access(recoveryRoot(workspaceRoot, transactionId))).rejects.toThrow();
  });
});
