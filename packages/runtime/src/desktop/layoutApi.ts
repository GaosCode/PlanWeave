import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { loadPackage, resolvePackageWorkspace } from "../package/loadPackage.js";
import type { PackageWorkspaceRef } from "../types.js";
import { executePlanGraphCommand } from "../plangraph/index.js";
import { validateDesktopLayout } from "../validation/desktopLayoutValidation.js";
import type { DesktopLayout } from "./types.js";
import {
  defaultDesktopLayout,
  desktopLayoutCommandStore,
  getDesktopLayoutDirect,
  getDesktopLayoutForPackage,
  resetDesktopLayoutDirect,
  saveDesktopLayoutDirect
} from "./layoutStore.js";

export { validateDesktopLayout };
export { getDesktopLayoutForPackage, saveDesktopLayoutDirect };

export async function getDesktopLayout(projectRoot: PackageWorkspaceRef): Promise<DesktopLayout> {
  return getDesktopLayoutDirect(projectRoot);
}

function graphCommandError(result: Awaited<ReturnType<typeof executePlanGraphCommand>>): Error {
  return new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
}

export async function saveDesktopLayout(
  projectRoot: PackageWorkspaceRef,
  layout: DesktopLayout
): Promise<DesktopLayout> {
  const result = await executePlanGraphCommand({
    projectRoot,
    command: { type: "updateLayout", layoutScope: "desktop", layout },
    dependencies: { layoutStore: desktopLayoutCommandStore }
  });
  if (!result.ok) {
    throw graphCommandError(result);
  }
  return getDesktopLayoutDirect(projectRoot);
}

export async function resetDesktopLayout(projectRoot: PackageWorkspaceRef): Promise<DesktopLayout> {
  const workspace = await resolvePackageWorkspace(projectRoot);
  const result = await executePlanGraphCommand({
    projectRoot,
    command: {
      type: "updateLayout",
      layoutScope: "desktop",
      layout: defaultDesktopLayout(workspace.id)
    },
    dependencies: { layoutStore: desktopLayoutCommandStore }
  });
  if (!result.ok) {
    throw graphCommandError(result);
  }
  const layout = await getDesktopLayoutDirect(projectRoot);
  if (layout.nodes.length === 0) {
    return resetDesktopLayoutDirect(projectRoot);
  }
  return layout;
}

export type ApplyCanvasLaneLayoutOptions = {
  columnWidth?: number;
  rowHeight?: number;
  startX?: number;
  startY?: number;
};

function taskDepth(
  taskId: string,
  dependenciesByTask: Map<string, string[]>,
  depths: Map<string, number>,
  visiting: Set<string>
): number {
  const existing = depths.get(taskId);
  if (existing !== undefined) {
    return existing;
  }
  if (visiting.has(taskId)) {
    return 0;
  }
  visiting.add(taskId);
  const dependencies = dependenciesByTask.get(taskId) ?? [];
  const depth =
    dependencies.length === 0
      ? 0
      : Math.max(
          ...dependencies.map((dependencyId) =>
            taskDepth(dependencyId, dependenciesByTask, depths, visiting)
          )
        ) + 1;
  visiting.delete(taskId);
  depths.set(taskId, depth);
  return depth;
}

export async function applyCanvasLaneLayout(
  projectRoot: PackageWorkspaceRef,
  options: ApplyCanvasLaneLayoutOptions = {}
): Promise<DesktopLayout> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  if (graph.diagnostics.errors.length > 0) {
    throw new Error(graph.diagnostics.errors.map((diagnostic) => diagnostic.message).join("\n"));
  }

  const columnWidth = options.columnWidth ?? 320;
  const rowHeight = options.rowHeight ?? 180;
  const startX = options.startX ?? 80;
  const startY = options.startY ?? 80;
  const depths = new Map<string, number>();
  const laneCounts = new Map<number, number>();

  const nodes = graph.taskNodesInManifestOrder.map((taskId) => {
    const depth = taskDepth(taskId, graph.taskDependenciesByTask, depths, new Set<string>());
    const laneIndex = laneCounts.get(depth) ?? 0;
    laneCounts.set(depth, laneIndex + 1);
    return {
      nodeId: taskId,
      x: startX + depth * columnWidth,
      y: startY + laneIndex * rowHeight
    };
  });

  return saveDesktopLayout(projectRoot, {
    version: "desktop-layout/v1",
    projectId: workspace.id,
    nodes,
    updatedAt: new Date().toISOString()
  });
}
