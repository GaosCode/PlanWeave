import {
  packageStorageIdentitySchema,
  resultsStorageIdentitySchema
} from "./packageStorageIdentitySchema.js";
import { withImportTransactionReadAdmission } from "./importTransactionLock.js";
import { assertNoPendingImportTransactionWrite } from "./importTransaction.js";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { isNodeFileNotFoundError, optionalReadFile } from "../fs/optionalFile.js";
import { writeJsonFile } from "../json.js";
import type { ProjectWorkspace, ValidationIssue } from "../types.js";

const canvasInstanceSchema = z
  .object({ version: z.literal(1), id: z.string().uuid(), createdAt: z.string().datetime() })
  .strict();

export function canvasStorageIdentityFile(workspace: ProjectWorkspace): string {
  return join(
    dirname(workspace.packageDir),
    `${basename(workspace.packageDir)}.canvas-instance.json`
  );
}

export function newCanvasStorageIdentity(): z.infer<typeof canvasInstanceSchema> {
  return { version: 1, id: randomUUID(), createdAt: new Date().toISOString() };
}

/** Caller owns the canvas replacement lane; the identity survives ordinary package publication. */
export async function writeNewCanvasStorageIdentity(workspace: ProjectWorkspace): Promise<void> {
  await writeStorageIdentity(
    workspace,
    canvasStorageIdentityFile(workspace),
    newCanvasStorageIdentity()
  );
}

async function currentCanvasIdentity(workspace: ProjectWorkspace): Promise<string | null> {
  const instance = await readCanvasInstance(canvasStorageIdentityFile(workspace));
  if (instance !== null) {
    return `instance:${instance.id}:${Date.parse(instance.createdAt)}`;
  }
  // Pre-instance canvases keep their directory identity until an explicit retirement.
  try {
    const info = await stat(dirname(workspace.packageDir), { bigint: true });
    return info.isDirectory() ? `directory:${info.dev}:${info.ino}:${info.birthtimeNs}` : null;
  } catch (error) {
    if (isNodeFileNotFoundError(error)) return null;
    throw error;
  }
}

async function readCanvasInstance(path: string) {
  const raw = await optionalReadFile(path, "utf8");
  return raw === null ? null : canvasInstanceSchema.parse(JSON.parse(raw));
}

async function readResultsInstance(path: string): Promise<string | null> {
  const raw = await optionalReadFile(path, "utf8");
  return raw === null ? null : resultsStorageIdentitySchema.parse(JSON.parse(raw));
}

export async function validatePackageStorageIdentityFiles(
  workspace: ProjectWorkspace
): Promise<ValidationIssue[]> {
  const errors: ValidationIssue[] = [];
  for (const { path, read, code } of [
    {
      path: canvasStorageIdentityFile(workspace),
      read: readCanvasInstance,
      code: "canvas_storage_identity_read_failed"
    },
    {
      path: resultsStorageIdentityFile(workspace),
      read: readResultsInstance,
      code: "results_storage_identity_read_failed"
    }
  ]) {
    try {
      await read(path);
    } catch (error) {
      errors.push({ code, path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return errors;
}

/** Capture only while resolving a fresh workspace, never when admitting a saved request. */
export async function capturePackageStorageIdentity(
  workspace: ProjectWorkspace
): Promise<ProjectWorkspace> {
  return {
    ...workspace,
    packageStorageIdentity: await currentCanvasIdentity(workspace),
    resultsStorageIdentity: await currentResultsIdentity(workspace)
  };
}

export async function assertPackageStorageIdentity(workspace: ProjectWorkspace): Promise<void> {
  if (
    typeof workspace.packageStorageIdentity !== "string" ||
    workspace.packageStorageIdentity !== (await currentCanvasIdentity(workspace))
  ) {
    throw new Error(`PlanWeave canvas storage identity changed at '${workspace.packageDir}'.`);
  }
}

export function packageStorageCreatedAt(identity: string): number {
  const valid = packageStorageIdentitySchema.parse(identity);
  const timestamp = valid.split(":").at(-1)!;
  return valid.startsWith("instance:") ? Number(timestamp) : Number(BigInt(timestamp) / 1_000_000n);
}

export function resultsStorageIdentityFile(workspace: ProjectWorkspace): string {
  return join(
    dirname(workspace.resultsDir),
    `${basename(workspace.resultsDir)}.results-instance.json`
  );
}

async function currentResultsIdentity(workspace: ProjectWorkspace): Promise<string> {
  // Results predating explicit reset generations retain their original generation.
  return (await readResultsInstance(resultsStorageIdentityFile(workspace))) ?? "initial";
}

/** Caller owns the results replacement lane and the parent project lock. */
export async function writeNewResultsStorageIdentity(workspace: ProjectWorkspace): Promise<void> {
  await writeStorageIdentity(workspace, resultsStorageIdentityFile(workspace), randomUUID());
}

export async function assertResultsStorageIdentity(workspace: ProjectWorkspace): Promise<void> {
  if (
    typeof workspace.resultsStorageIdentity !== "string" ||
    workspace.resultsStorageIdentity !== (await currentResultsIdentity(workspace))
  ) {
    throw new Error(`PlanWeave results storage identity changed at '${workspace.resultsDir}'.`);
  }
}

async function writeStorageIdentity(
  workspace: ProjectWorkspace,
  target: string,
  value: unknown
): Promise<void> {
  const workspaceRoot = dirname(workspace.projectFile);
  await withImportTransactionReadAdmission([workspaceRoot], [target], async () => {
    await assertNoPendingImportTransactionWrite({ workspaceRoot, target });
    await writeJsonFile(target, value);
  });
}
