import { resolvePlanweaveHome } from "../paths.js";
import {
  assertCurrentProjectWorkspace,
  readProject,
  resolveProjectWorkspaceInHome
} from "../project.js";
import { withProjectMutationLock } from "../fs/withProjectMutationLock.js";
import { compileProjectGraph, loadProjectGraphForWorkspace } from "../projectGraph/index.js";
import type { ProjectWorkspace } from "../types.js";
import { readDesktopProjectProjection } from "./graph/projectProjectionModel.js";
import { buildCanvasMapProjection } from "../plangraph/projections/index.js";
import { sha256Hex, stableJson } from "../plangraph/hash.js";
import {
  canvasMapLayoutPath,
  canonicalizeCanvasMapLayoutForSave,
  defaultCanvasMapLayout,
  deleteCanvasMapLayoutFile,
  readCanvasMapLayoutFromDisk,
  withCanvasMapLayoutDiskLock,
  withCanvasMapLayoutMutation,
  writeCanvasMapLayoutToDisk
} from "./canvasMapLayout.js";
import type { DesktopCanvasGraphViewModel, DesktopCanvasMapLayout } from "./types.js";

async function projectTitle(workspace: ProjectWorkspace, fallback: string): Promise<string> {
  return (await readProject(workspace))?.name ?? fallback;
}

function projectTodoGraphVersion(
  todoContext: Awaited<ReturnType<typeof readDesktopProjectProjection>>["todoContext"]
): string {
  return sha256Hex(
    stableJson({
      projectGraph: todoContext.aggregation.graph.manifest,
      orderedCanvasIds: todoContext.aggregation.orderedCanvasIds,
      canvases: todoContext.aggregation.orderedCanvasIds.map((canvasId) => {
        const snapshot = todoContext.snapshotsByCanvas.get(canvasId);
        return {
          canvasId,
          graphVersion: snapshot?.graphVersion ?? null,
          failed: Boolean(snapshot?.error)
        };
      })
    })
  );
}

async function canvasIdsForProject(
  workspace: ProjectWorkspace
): Promise<{ projectId: string; canvasIds: string[] }> {
  const loaded = await loadProjectGraphForWorkspace(workspace);
  const graph = await compileProjectGraph(loaded);
  return {
    projectId: loaded.workspace.id,
    canvasIds: graph.canvasIdsInOrder
  };
}

/**
 * Enter the project-key FIFO before any await, resolve workspace inside the queue,
 * then hold the project relocation lock before the layout disk lock.
 */
async function withProjectCanvasMapLayoutMutation<T>(
  projectRoot: string,
  operation: string,
  fn: (workspace: ProjectWorkspace) => Promise<T>
): Promise<T> {
  const planweaveHome = resolvePlanweaveHome();
  return withCanvasMapLayoutMutation(
    () => resolveProjectWorkspaceInHome(projectRoot, planweaveHome),
    async (workspace) => {
      return withProjectMutationLock(
        workspace.workspaceRoot,
        () =>
          withCanvasMapLayoutDiskLock(workspace, operation, async () => {
            await assertCurrentProjectWorkspace(workspace);
            return fn(workspace);
          }),
        { operation }
      );
    }
  );
}

export async function getCanvasGraphViewModel(
  projectRoot: string
): Promise<DesktopCanvasGraphViewModel> {
  const { todoContext } = await readDesktopProjectProjection(projectRoot);
  const { loaded } = todoContext.aggregation;
  const firstCanvasId = todoContext.aggregation.graph.canvasIdsInOrder[0];
  const titleFallback = firstCanvasId
    ? (todoContext.aggregation.canvasesById.get(firstCanvasId)?.canvasName ?? loaded.workspace.id)
    : loaded.workspace.id;
  return buildCanvasMapProjection({
    graphVersion: projectTodoGraphVersion(todoContext),
    context: todoContext,
    projectId: loaded.workspace.id,
    projectTitle: await projectTitle(loaded.workspace, titleFallback)
  }).viewModel;
}

export async function getCanvasMapLayout(projectRoot: string): Promise<DesktopCanvasMapLayout> {
  return withProjectCanvasMapLayoutMutation(
    projectRoot,
    "get-canvas-map-layout",
    async (workspace) => {
      const { projectId, canvasIds } = await canvasIdsForProject(workspace);
      return readCanvasMapLayoutFromDisk(workspace, projectId, canvasIds);
    }
  );
}

export async function saveCanvasMapLayout(
  projectRoot: string,
  layout: unknown
): Promise<DesktopCanvasMapLayout> {
  return withProjectCanvasMapLayoutMutation(
    projectRoot,
    "save-canvas-map-layout",
    async (workspace) => {
      const { projectId, canvasIds } = await canvasIdsForProject(workspace);
      const path = canvasMapLayoutPath(workspace);
      const next = canonicalizeCanvasMapLayoutForSave(layout, projectId, canvasIds, path);
      await writeCanvasMapLayoutToDisk(workspace, next);
      return next;
    }
  );
}

export async function resetCanvasMapLayout(projectRoot: string): Promise<DesktopCanvasMapLayout> {
  return withProjectCanvasMapLayoutMutation(
    projectRoot,
    "reset-canvas-map-layout",
    async (workspace) => {
      // Resolve live canvas set before any destructive disk change so failures
      // leave the previous last-known-good layout file intact.
      const { projectId, canvasIds } = await canvasIdsForProject(workspace);
      await deleteCanvasMapLayoutFile(workspace);
      return defaultCanvasMapLayout(projectId, canvasIds);
    }
  );
}
