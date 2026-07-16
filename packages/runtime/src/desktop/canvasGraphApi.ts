import { readProject, resolveProjectWorkspace } from "../project.js";
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

async function projectTitle(projectRoot: string, fallback: string): Promise<string> {
  return (await readProject(projectRoot))?.name ?? fallback;
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
  projectRoot: string
): Promise<{ workspace: ProjectWorkspace; projectId: string; canvasIds: string[] }> {
  const { todoContext } = await readDesktopProjectProjection(projectRoot);
  const { loaded, graph } = todoContext.aggregation;
  return {
    workspace: loaded.workspace,
    projectId: loaded.workspace.id,
    canvasIds: graph.canvasIdsInOrder
  };
}

/**
 * Enter the project-key FIFO before any await, resolve workspace inside the queue,
 * then take the cross-process disk lock for the layout file critical section.
 */
async function withProjectCanvasMapLayoutMutation<T>(
  projectRoot: string,
  operation: string,
  fn: (workspace: ProjectWorkspace) => Promise<T>
): Promise<T> {
  return withCanvasMapLayoutMutation(() => resolveProjectWorkspace(projectRoot), async (workspace) => {
    return withCanvasMapLayoutDiskLock(workspace, operation, () => fn(workspace));
  });
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
    projectTitle: await projectTitle(projectRoot, titleFallback)
  }).viewModel;
}

export async function getCanvasMapLayout(projectRoot: string): Promise<DesktopCanvasMapLayout> {
  return withProjectCanvasMapLayoutMutation(projectRoot, "get-canvas-map-layout", async (workspace) => {
    const { projectId, canvasIds } = await canvasIdsForProject(projectRoot);
    return readCanvasMapLayoutFromDisk(workspace, projectId, canvasIds);
  });
}

export async function saveCanvasMapLayout(
  projectRoot: string,
  layout: unknown
): Promise<DesktopCanvasMapLayout> {
  return withProjectCanvasMapLayoutMutation(
    projectRoot,
    "save-canvas-map-layout",
    async (workspace) => {
      const { projectId, canvasIds } = await canvasIdsForProject(projectRoot);
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
      const { projectId, canvasIds } = await canvasIdsForProject(projectRoot);
      await deleteCanvasMapLayoutFile(workspace);
      return defaultCanvasMapLayout(projectId, canvasIds);
    }
  );
}
