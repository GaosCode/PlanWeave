import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { optionalStat } from "../../fs/optionalFile.js";
import { readJsonFile, writeJsonFile } from "../../json.js";
import { ImportTransaction } from "../../package/importTransaction.js";

export { writeJsonFile };

export async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "planweave-import-transaction-"));
}

export async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

export function recoveryRoot(workspaceRoot: string, transactionId: string): string {
  return join(workspaceRoot, "desktop", "recovery", "package-import", transactionId);
}

export const realFs = {
  mkdir,
  rename,
  rm,
  optionalStat,
  readJsonFile,
  writeJsonFile
};

export type RecoveryJson = {
  operations: Array<{
    target: string;
    backupPath: string;
    type: string;
    targetExisted: boolean;
    phase: string;
  }>;
};

export function fsFailWrite(writeNumber: number, message: string): typeof realFs {
  let recoveryWrites = 0;
  return {
    ...realFs,
    writeJsonFile: async (path, value) => {
      recoveryWrites += 1;
      if (recoveryWrites === writeNumber) {
        throw new Error(message);
      }
      return writeJsonFile(path, value);
    }
  };
}

export function fsWithCleanupFailure(recovery: string): typeof realFs {
  return {
    ...realFs,
    rm: async (path, options) => {
      if (path === recovery) {
        throw new Error("recovery cleanup interrupted");
      }
      return rm(path, options);
    }
  };
}

export function fsInstallFail(staged: string, target: string): typeof realFs {
  return {
    ...realFs,
    rename: async (source, destination) => {
      if (source === staged && destination === target) {
        throw new Error("staged install interrupted");
      }
      return rename(source, destination);
    }
  };
}

export async function readRecovery(workspaceRoot: string, transactionId: string): Promise<RecoveryJson> {
  return JSON.parse(await readFile(join(recoveryRoot(workspaceRoot, transactionId), "recovery.json"), "utf8")) as RecoveryJson;
}

export async function recoverClean(workspaceRoot: string, transactionId: string): Promise<void> {
  const recovered = await ImportTransaction.recover({ workspaceRoot, transactionId });
  await recovered.rollback();
  await expect(access(recoveryRoot(workspaceRoot, transactionId))).rejects.toThrow();
}

export async function expectOp(
  workspaceRoot: string,
  transactionId: string,
  operation: Partial<RecoveryJson["operations"][number]>
): Promise<void> {
  await expect(readRecovery(workspaceRoot, transactionId)).resolves.toMatchObject({ operations: [operation] });
}

