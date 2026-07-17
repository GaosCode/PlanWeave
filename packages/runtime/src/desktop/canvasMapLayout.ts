import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withAdvisoryDirectoryLock } from "../fs/advisoryDirectoryLock.js";
import { optionalStat } from "../fs/optionalFile.js";
import { writeJsonFile } from "../json.js";
import type { ProjectWorkspace } from "../types.js";
import {
  CANVAS_MAP_LAYOUT_VERSION,
  CanvasMapLayoutError,
  parseCanvasMapLayoutFile,
  type DesktopCanvasMapLayout,
  type DesktopCanvasMapLayoutNode
} from "./types/canvasMapLayoutSchema.js";

const LAYOUT_DISK_LOCKS_DIR = "canvas-map-layout";

export function canvasMapLayoutPath(workspace: ProjectWorkspace): string {
  return join(workspace.workspaceRoot, "desktop", "canvas-map-layout.json");
}

export function canvasMapLayoutDiskLockPath(workspace: ProjectWorkspace): string {
  const workspaceIdentity = createHash("sha256").update(workspace.id).digest("hex");
  return join(workspace.planweaveHome, "locks", LAYOUT_DISK_LOCKS_DIR, `${workspaceIdentity}.lock`);
}

export function defaultCanvasMapLayoutNodes(canvasIds: string[]): DesktopCanvasMapLayoutNode[] {
  return canvasIds.map((canvasId, index) => ({
    canvasId,
    x: 80 + (index % 3) * 380,
    y: 80 + Math.floor(index / 3) * 220
  }));
}

export function defaultCanvasMapLayout(
  projectId: string,
  canvasIds: string[]
): DesktopCanvasMapLayout {
  return {
    version: CANVAS_MAP_LAYOUT_VERSION,
    projectId,
    nodes: defaultCanvasMapLayoutNodes(canvasIds),
    updatedAt: new Date(0).toISOString()
  };
}

/**
 * Align a structurally valid layout with the current project canvas set.
 * Keeps entries that still exist, drops deleted/unknown canvas IDs, and fills
 * missing canvases with the same default positions as an empty layout.
 */
export function reconcileCanvasMapLayoutWithProject(
  layout: DesktopCanvasMapLayout,
  projectId: string,
  canvasIds: string[]
): DesktopCanvasMapLayout {
  const canvasIdSet = new Set(canvasIds);
  const kept = layout.nodes.filter((node) => canvasIdSet.has(node.canvasId));
  const existingCanvasIds = new Set(kept.map((node) => node.canvasId));
  const missing = defaultCanvasMapLayoutNodes(canvasIds).filter(
    (node) => !existingCanvasIds.has(node.canvasId)
  );
  return {
    version: CANVAS_MAP_LAYOUT_VERSION,
    projectId,
    nodes: [...kept, ...missing],
    updatedAt: layout.updatedAt
  };
}

async function readCanvasMapLayoutJson(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw CanvasMapLayoutError.fromJson(path, error);
  }
}

export async function readCanvasMapLayoutFromDisk(
  workspace: ProjectWorkspace,
  projectId: string,
  canvasIds: string[]
): Promise<DesktopCanvasMapLayout> {
  const path = canvasMapLayoutPath(workspace);
  if (!(await optionalStat(path))) {
    return defaultCanvasMapLayout(projectId, canvasIds);
  }
  const raw = await readCanvasMapLayoutJson(path);
  const parsed = parseCanvasMapLayoutFile(raw, path);
  if (parsed.projectId !== projectId) {
    throw CanvasMapLayoutError.projectMismatch(path, parsed.projectId, projectId);
  }
  return reconcileCanvasMapLayoutWithProject(parsed, projectId, canvasIds);
}

/**
 * Validate bridge/disk-shaped input as-is, enforce project ownership, reconcile
 * to the live canvas set, then stamp `updatedAt` for the writer only.
 */
export function canonicalizeCanvasMapLayoutForSave(
  input: unknown,
  projectId: string,
  canvasIds: string[],
  filePath: string
): DesktopCanvasMapLayout {
  const parsed = parseCanvasMapLayoutFile(input, filePath);
  if (parsed.projectId !== projectId) {
    throw CanvasMapLayoutError.projectMismatch(filePath, parsed.projectId, projectId);
  }
  const reconciled = reconcileCanvasMapLayoutWithProject(parsed, projectId, canvasIds);
  return {
    ...reconciled,
    updatedAt: new Date().toISOString()
  };
}

/** Admission preserves API invocation order while canonical workspace identity is resolved. */
let layoutMutationAdmissionTail: Promise<void> = Promise.resolve();

/** Same-process FIFO queue keyed by the canonical project identity from ProjectWorkspace. */
const layoutMutationTails = new Map<string, Promise<void>>();

/**
 * Serialize canvas-map layout load/save/reset/rename for one canonical project key.
 */
async function withCanvasMapLayoutMutationLock<T>(
  projectKey: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = layoutMutationTails.get(projectKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const held = previous.then(
    () => gate,
    () => gate
  );
  layoutMutationTails.set(projectKey, held);
  try {
    await previous.catch(() => undefined);
    return await fn();
  } finally {
    release();
    void held.then(() => {
      if (layoutMutationTails.get(projectKey) === held) {
        layoutMutationTails.delete(projectKey);
      }
    });
  }
}

/**
 * Admit mutations before their first await and resolve aliases to the canonical workspace id.
 * Relocations keep admission through completion so they cannot invalidate a later resolver.
 */
async function withCanvasMapLayoutMutationAdmission<ResolvedWorkspace extends ProjectWorkspace, T>(
  resolveWorkspace: () => Promise<ResolvedWorkspace>,
  fn: (workspace: ResolvedWorkspace) => Promise<T>,
  holdAdmissionUntilComplete: boolean
): Promise<T> {
  const previousAdmission = layoutMutationAdmissionTail;
  let releaseAdmission!: () => void;
  const admissionGate = new Promise<void>((resolveGate) => {
    releaseAdmission = resolveGate;
  });
  const heldAdmission = previousAdmission.then(
    () => admissionGate,
    () => admissionGate
  );
  layoutMutationAdmissionTail = heldAdmission;

  await previousAdmission.catch(() => undefined);
  try {
    const workspace = await resolveWorkspace();
    const execution = withCanvasMapLayoutMutationLock(workspace.id, () => fn(workspace));
    return holdAdmissionUntilComplete ? await execution : execution;
  } finally {
    releaseAdmission();
    void heldAdmission.then(() => {
      if (layoutMutationAdmissionTail === heldAdmission) {
        layoutMutationAdmissionTail = Promise.resolve();
      }
    });
  }
}

export function withCanvasMapLayoutMutation<ResolvedWorkspace extends ProjectWorkspace, T>(
  resolveWorkspace: () => Promise<ResolvedWorkspace>,
  fn: (workspace: ResolvedWorkspace) => Promise<T>
): Promise<T> {
  return withCanvasMapLayoutMutationAdmission(resolveWorkspace, fn, false);
}

/** Keep admission held while a workspace relocation can invalidate subsequent path resolution. */
export function withCanvasMapLayoutRelocationMutation<
  ResolvedWorkspace extends ProjectWorkspace,
  T
>(
  resolveWorkspace: () => Promise<ResolvedWorkspace>,
  fn: (workspace: ResolvedWorkspace) => Promise<T>
): Promise<T> {
  return withCanvasMapLayoutMutationAdmission(resolveWorkspace, fn, true);
}

/**
 * Cross-process advisory lock for the workspace layout file.
 * Call only after workspace resolve, inside {@link withCanvasMapLayoutMutation}.
 */
export async function withCanvasMapLayoutDiskLock<T>(
  workspace: ProjectWorkspace,
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  const lockPath = canvasMapLayoutDiskLockPath(workspace);
  await mkdir(dirname(lockPath), { recursive: true });
  return withAdvisoryDirectoryLock(
    {
      lockPath,
      operation
    },
    fn
  );
}

/** Acquire multiple stable layout locks in path order to avoid old/new-root deadlocks. */
export async function withCanvasMapLayoutDiskLocks<T>(
  workspaces: ProjectWorkspace[],
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  const uniqueByPath = new Map<string, ProjectWorkspace>();
  for (const workspace of workspaces) {
    uniqueByPath.set(canvasMapLayoutDiskLockPath(workspace), workspace);
  }
  const ordered = [...uniqueByPath.entries()].sort(([left], [right]) => left.localeCompare(right));

  const acquire = async (index: number): Promise<T> => {
    const entry = ordered[index];
    if (!entry) {
      return fn();
    }
    return withCanvasMapLayoutDiskLock(entry[1], operation, () => acquire(index + 1));
  };
  return acquire(0);
}

export async function writeCanvasMapLayoutToDisk(
  workspace: ProjectWorkspace,
  layout: DesktopCanvasMapLayout
): Promise<void> {
  const path = canvasMapLayoutPath(workspace);
  await mkdir(dirname(path), { recursive: true });
  await writeJsonFile(path, layout);
}

export async function deleteCanvasMapLayoutFile(workspace: ProjectWorkspace): Promise<void> {
  await rm(canvasMapLayoutPath(workspace), { force: true });
}

/**
 * Schema-owned projectId rewrite for rename/rollback.
 * Caller must hold the project layout mutation boundary for this workspace.
 */
export async function reassignCanvasMapLayoutProjectId(
  workspace: ProjectWorkspace,
  nextProjectId: string
): Promise<void> {
  const path = canvasMapLayoutPath(workspace);
  if (!(await optionalStat(path))) {
    return;
  }
  const raw = await readCanvasMapLayoutJson(path);
  const parsed = parseCanvasMapLayoutFile(raw, path);
  if (parsed.projectId === nextProjectId) {
    return;
  }
  await writeCanvasMapLayoutToDisk(workspace, {
    ...parsed,
    projectId: nextProjectId
  });
}
