import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { isNodeFileNotFoundError, optionalReadFile } from "../fs/optionalFile.js";
import { writeJsonFile } from "../json.js";
import type { ProjectWorkspace } from "../types.js";

const canvasInstanceSchema = z
  .object({ version: z.literal(1), id: z.string().uuid(), createdAt: z.string().datetime() })
  .strict();
export const packageStorageIdentitySchema = z.union([
  z.string().regex(/^directory:\d+:\d+:\d+$/),
  z.string().regex(/^instance:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/)
]);

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
  await writeJsonFile(canvasStorageIdentityFile(workspace), newCanvasStorageIdentity());
}

async function currentCanvasIdentity(workspace: ProjectWorkspace): Promise<string | null> {
  const raw = await optionalReadFile(canvasStorageIdentityFile(workspace), "utf8");
  if (raw !== null) {
    const instance = canvasInstanceSchema.parse(JSON.parse(raw));
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

/** Capture only while resolving a fresh workspace, never when admitting a saved request. */
export async function capturePackageStorageIdentity(
  workspace: ProjectWorkspace
): Promise<ProjectWorkspace> {
  return { ...workspace, packageStorageIdentity: await currentCanvasIdentity(workspace) };
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
