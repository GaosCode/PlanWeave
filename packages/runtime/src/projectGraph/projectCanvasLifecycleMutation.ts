import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { withProjectMutationLock } from "../fs/withProjectMutationLock.js";
import { withPackageFileConsistency } from "../package/packageFileConsistency.js";
import {
  withCanvasStorageMutation,
  withCanvasStorageReplacement
} from "../package/withCanvasStorageMutation.js";
import { writeNewCanvasStorageIdentity } from "../package/packageStorageIdentity.js";
import { initialManifest } from "../initWorkspace.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { assertCurrentProjectWorkspace, requireInitializedProjectWorkspace } from "../project.js";
import { createEmptyState } from "../state.js";
import type { PackageWorkspaceRef, ProjectWorkspace } from "../types.js";
import {
  normalizeRegistry,
  registryVersion,
  type TaskCanvasRecord,
  type TaskCanvasRegistry
} from "../desktop/canvasRegistry.js";
import { readActiveTaskCanvasSelectionForWorkspace } from "../desktop/canvasSelectionStore.js";
import { optionalStat } from "../fs/optionalFile.js";
import {
  loadProjectGraphForWorkspace,
  projectGraphPath,
  writeProjectGraph
} from "./loadProjectGraph.js";
import { projectCanvasWorkspace } from "./projectGraphWorkspace.js";
import { writeManifestTitle } from "./canvasWorkspaceContent.js";
import {
  quarantineCanvasWorkspace,
  restoreQuarantinedCanvasWorkspace
} from "./canvasWorkspaceRecovery.js";
import type { LoadedProjectGraph, ProjectCanvasNode, ProjectGraphManifest } from "./types.js";

const defaultCanvasId = "default";
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function assertWorkspaceChild(projectWorkspace: ProjectWorkspace, path: string): void {
  const workspaceRoot = resolve(projectWorkspace.workspaceRoot);
  const target = resolve(path);
  const relativeTarget = relative(workspaceRoot, target);
  if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new Error(`Task canvas path '${path}' is outside the PlanWeave workspace.`);
  }
}

function assertProjectCanvasUnreferenced(manifest: ProjectGraphManifest, canvasId: string): void {
  const canvasEdges = manifest.edges.filter(
    (edge) => edge.from === canvasId || edge.to === canvasId
  );
  const crossTaskEdges = manifest.crossTaskEdges.filter(
    (edge) => edge.from.canvasId === canvasId || edge.to.canvasId === canvasId
  );
  if (canvasEdges.length === 0 && crossTaskEdges.length === 0) {
    return;
  }
  const references = [
    ...canvasEdges.map((edge) => `canvas edge ${edge.from}->${edge.to}`),
    ...crossTaskEdges.map(
      (edge) =>
        `cross-task edge ${edge.from.canvasId}:${edge.from.taskId}->${edge.to.canvasId}:${edge.to.taskId}`
    )
  ];
  throw new Error(
    `Cannot remove project canvas '${canvasId}' because it is referenced by project graph dependencies: ${references.join(", ")}. Remove those dependencies first.`
  );
}

async function restoreQuarantineAfterFailedRemoval(
  projectWorkspace: ProjectWorkspace,
  canvasId: string,
  workspace: ProjectWorkspace,
  quarantineRoot: string | null,
  removalError: unknown
): Promise<void> {
  if (!quarantineRoot) {
    return;
  }
  try {
    await restoreQuarantinedCanvasWorkspace(projectWorkspace, { quarantineRoot, workspace });
  } catch (rollbackError) {
    throw new Error(
      `Task canvas '${canvasId}' removal failed, and its quarantined workspace at '${quarantineRoot}' could not be restored: ${errorMessage(removalError)}; rollback failed: ${errorMessage(rollbackError)}`,
      {
        cause: new AggregateError(
          [removalError, rollbackError],
          "Canvas removal and compensation failed"
        )
      }
    );
  }
}

async function resetCanvasWorkspace(workspace: ProjectWorkspace, title: string): Promise<void> {
  await withCanvasStorageReplacement(workspace, () =>
    withCanvasStorageMutation(workspace, async () => {
      await writeNewCanvasStorageIdentity(workspace);
      await rm(workspace.packageDir, { recursive: true, force: true });
      await writeJsonFile(workspace.manifestFile, initialManifest(title));
      await writeJsonFile(workspace.stateFile, createEmptyState());
      await rm(workspace.resultsDir, { recursive: true, force: true });
      await mkdir(workspace.resultsDir, { recursive: true });
    })
  );
}

/** Legacy persistence remains a migration source; every lifecycle write uses the same project lane. */
async function lifecycleSnapshot(workspace: ProjectWorkspace): Promise<{
  loaded: LoadedProjectGraph;
  registry: TaskCanvasRegistry | null;
}> {
  const loaded = await loadProjectGraphForWorkspace(workspace);
  if (loaded.source === "project_graph") return { loaded, registry: null };
  const path = join(workspace.workspaceRoot, "desktop", "canvases.json");
  if (await optionalStat(path)) {
    return { loaded, registry: normalizeRegistry(await readJsonFile<unknown>(path)) };
  }
  const now = new Date().toISOString();
  const registry: TaskCanvasRegistry = {
    version: registryVersion,
    canvases: loaded.manifest.canvases.map((canvas) => ({
      canvasId: canvas.id,
      name: canvas.title,
      packageDir: relative(workspace.workspaceRoot, workspace.packageDir).split("\\").join("/"),
      stateFile: relative(workspace.workspaceRoot, workspace.stateFile).split("\\").join("/"),
      resultsDir: relative(workspace.workspaceRoot, workspace.resultsDir).split("\\").join("/"),
      createdAt: now,
      updatedAt: now
    }))
  };
  return { loaded, registry };
}

type LifecycleSnapshot = Awaited<ReturnType<typeof lifecycleSnapshot>>;

async function commitLifecycleGraph(
  snapshot: LifecycleSnapshot,
  manifest: ProjectGraphManifest
): Promise<TaskCanvasRegistry | null> {
  if (!snapshot.registry) {
    await writeProjectGraph(snapshot.loaded.workspace, manifest);
    return null;
  }
  const nextById = new Map(manifest.canvases.map((canvas) => [canvas.id, canvas]));
  const nextRegistry: TaskCanvasRegistry = {
    ...snapshot.registry,
    canvases: snapshot.registry.canvases.flatMap((record) => {
      const canvas = nextById.get(record.canvasId);
      if (!canvas) return [];
      return [
        {
          ...record,
          name: canvas.title,
          updatedAt: canvas.title === record.name ? record.updatedAt : new Date().toISOString()
        }
      ];
    })
  };
  await writeJsonFile(
    join(snapshot.loaded.workspace.workspaceRoot, "desktop", "canvases.json"),
    nextRegistry
  );
  return nextRegistry;
}

function requireLifecycleCanvas(snapshot: LifecycleSnapshot, canvasId: string): ProjectCanvasNode {
  const canvas = snapshot.loaded.manifest.canvases.find((candidate) => candidate.id === canvasId);
  if (!canvas) throw new Error(`Project canvas '${canvasId}' does not exist.`);
  return canvas;
}

export async function renameProjectCanvas(input: {
  projectRoot: PackageWorkspaceRef;
  canvasId: string;
  name: string;
}): Promise<{
  projectWorkspace: ProjectWorkspace;
  canvas: ProjectCanvasNode;
  registryRecord: TaskCanvasRecord | null;
}> {
  const name = input.name.trim();
  if (!name) throw new Error("Task canvas name is required.");
  const project = await requireInitializedProjectWorkspace(input.projectRoot);
  return withProjectMutationLock(
    project.workspaceRoot,
    async () => {
      await assertCurrentProjectWorkspace(project);
      const snapshot = await lifecycleSnapshot(project);
      const canvas = requireLifecycleCanvas(snapshot, input.canvasId);
      const workspace = projectCanvasWorkspace(snapshot.loaded.workspace, canvas);
      const graphTarget = snapshot.registry
        ? join(project.workspaceRoot, "desktop", "canvases.json")
        : projectGraphPath(project);
      // The full target set is acquired together; nested title/graph writes reenter these keys.
      return withPackageFileConsistency([workspace.packageDir, graphTarget], async () => {
        const previousTitle = await writeManifestTitle(workspace, name);
        const nextCanvas = { ...canvas, title: name };
        let registryRecord: TaskCanvasRecord | null = null;
        try {
          const registry = await commitLifecycleGraph(snapshot, {
            ...snapshot.loaded.manifest,
            canvases: snapshot.loaded.manifest.canvases.map((candidate) =>
              candidate.id === canvas.id ? nextCanvas : candidate
            )
          });
          registryRecord =
            registry?.canvases.find((record) => record.canvasId === canvas.id) ?? null;
        } catch (primary) {
          try {
            await writeManifestTitle(workspace, previousTitle);
          } catch (rollback) {
            throw new Error(
              `Task canvas '${canvas.id}' rename failed: ${errorMessage(primary)}; rollback failed: ${errorMessage(rollback)}`,
              {
                cause: new AggregateError(
                  [primary, rollback],
                  "Canvas rename and compensation failed"
                )
              }
            );
          }
          throw primary;
        }
        return { projectWorkspace: snapshot.loaded.workspace, canvas: nextCanvas, registryRecord };
      });
    },
    { operation: `rename-canvas:${input.canvasId}` }
  );
}

export type ArchiveProjectCanvasOptions = { force?: boolean; reason?: string };

async function removeLifecycleCanvas(
  snapshot: LifecycleSnapshot,
  canvas: ProjectCanvasNode
): Promise<void> {
  const workspace = projectCanvasWorkspace(snapshot.loaded.workspace, canvas);
  assertWorkspaceChild(snapshot.loaded.workspace, workspace.packageDir);
  assertWorkspaceChild(snapshot.loaded.workspace, workspace.stateFile);
  assertWorkspaceChild(snapshot.loaded.workspace, workspace.resultsDir);
  assertProjectCanvasUnreferenced(snapshot.loaded.manifest, canvas.id);
  if (
    canvas.id === defaultCanvasId ||
    workspace.workspaceRoot === snapshot.loaded.workspace.workspaceRoot ||
    workspace.packageDir === snapshot.loaded.workspace.packageDir ||
    snapshot.loaded.manifest.canvases.length === 1
  ) {
    if (snapshot.loaded.source === "legacy_default_canvas") {
      await commitLifecycleGraph(snapshot, snapshot.loaded.manifest);
    }
    await resetCanvasWorkspace(workspace, canvas.title);
    return;
  }
  const quarantineRoot = await quarantineCanvasWorkspace(snapshot.loaded.workspace, {
    canvasId: canvas.id,
    workspace
  });
  try {
    await commitLifecycleGraph(snapshot, {
      ...snapshot.loaded.manifest,
      canvases: snapshot.loaded.manifest.canvases.filter((candidate) => candidate.id !== canvas.id)
    });
  } catch (primary) {
    await restoreQuarantineAfterFailedRemoval(
      snapshot.loaded.workspace,
      canvas.id,
      workspace,
      quarantineRoot,
      primary
    );
    throw primary;
  }
}

export async function removeProjectCanvas(input: {
  projectRoot: PackageWorkspaceRef;
  canvasId: string;
  archive?: ArchiveProjectCanvasOptions & {
    selectCanvas(workspace: ProjectWorkspace, canvasId: string): Promise<string>;
  };
}): Promise<{ activeCanvasId: string | null }> {
  const canvasId = input.canvasId.trim();
  if (!canvasId) throw new Error("Canvas id is required.");
  const force = input.archive?.force === true;
  if (force && !input.archive?.reason?.trim())
    throw new Error("Archiving with --force requires a non-empty --reason.");
  const project = await requireInitializedProjectWorkspace(input.projectRoot);
  return withProjectMutationLock(
    project.workspaceRoot,
    async () => {
      await assertCurrentProjectWorkspace(project);
      const snapshot = await lifecycleSnapshot(project);
      const canvas = requireLifecycleCanvas(snapshot, canvasId);
      let activeCanvasId: string | null = null;
      if (input.archive) {
        const manifest = snapshot.loaded.manifest;
        if (manifest.canvases.length <= 1)
          throw new Error(
            `Cannot archive task canvas '${canvasId}' because it is the only canvas in the project.`
          );
        const workspace = projectCanvasWorkspace(snapshot.loaded.workspace, canvas);
        if (
          canvasId === defaultCanvasId ||
          workspace.workspaceRoot === project.workspaceRoot ||
          workspace.packageDir === project.packageDir
        ) {
          throw new Error(
            `Cannot archive formal default canvas '${canvasId}'. Archive is reversible retirement for non-default canvases only.`
          );
        }
        assertProjectCanvasUnreferenced(manifest, canvasId);
        activeCanvasId = (await readActiveTaskCanvasSelectionForWorkspace(project)).activeCanvasId;
        if (activeCanvasId === canvasId && !force) {
          throw new Error(
            `Cannot archive active task canvas '${canvasId}' without --force and --reason. Switch with 'planweave canvas use <id>' first, or pass --force --reason.`
          );
        }
      }
      const previousActiveCanvasId = activeCanvasId;
      try {
        if (input.archive && activeCanvasId === canvasId) {
          const fallback = snapshot.loaded.manifest.canvases.find(
            (candidate) => candidate.id !== canvasId
          );
          if (!fallback)
            throw new Error(
              `Cannot archive task canvas '${canvasId}' because no fallback canvas remains.`
            );
          activeCanvasId = await input.archive.selectCanvas(project, fallback.id);
          if (snapshot.registry) {
            snapshot.registry = normalizeRegistry(
              await readJsonFile<unknown>(join(project.workspaceRoot, "desktop", "canvases.json"))
            );
          }
        }
        await removeLifecycleCanvas(snapshot, canvas);
      } catch (primary) {
        if (input.archive && previousActiveCanvasId === canvasId) {
          try {
            await input.archive.selectCanvas(project, canvasId);
          } catch (rollback) {
            throw new Error(
              `Task canvas '${canvasId}' archive failed: ${errorMessage(primary)}; selection rollback failed: ${errorMessage(rollback)}`,
              {
                cause: new AggregateError(
                  [primary, rollback],
                  "Canvas archive and selection compensation failed"
                )
              }
            );
          }
        }
        throw primary;
      }
      if (input.archive) return { activeCanvasId };
      return { activeCanvasId: null };
    },
    { operation: `${input.archive ? "archive" : "remove"}-canvas:${canvasId}` }
  );
}
