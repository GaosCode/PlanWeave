import { parseBlockRef } from "../../graph/compileTaskGraph.js";
import { commitPlanPackageGraphMutation } from "../../graph/editGraph.js";
import {
  buildPlanPackageGraphMutation,
  buildPlanPackageManifestChangeMutation,
  type PlanPackageGraphMutationSideEffect
} from "../../graph/mutation.js";
import { loadPackage } from "../../package/loadPackage.js";
import type {
  GraphEditResult,
  ManifestEdge,
  PackageWorkspaceRef,
  PlanPackageManifest,
  ValidationIssue
} from "../../types.js";
import type { DesktopGraphEditValidationInput, DesktopLayout } from "../types.js";
import { getDesktopLayout } from "../layoutApi.js";
import { executeDesktopPlanGraphCommand } from "./editModelCommand.js";
import type { DesktopBulkRemoveGraphItemsInput } from "./editModelTypes.js";
import {
  crossTaskEdgeDeleteDiagnostic,
  graphEditDiagnostics,
  graphEditResult
} from "./editModelValidation.js";
import { invalidateDesktopProjectProjection } from "./projectProjectionModel.js";

export async function removeTaskNode(
  projectRoot: PackageWorkspaceRef,
  taskId: string
): Promise<GraphEditResult> {
  const blocked = await crossTaskEdgeDeleteDiagnostic(projectRoot, taskId);
  if (blocked) {
    return blocked;
  }
  const layout = await getDesktopLayout(projectRoot);
  return executeDesktopPlanGraphCommand(projectRoot, {
    type: "removeTask",
    taskId,
    layoutNode: layout.nodes.find((node) => node.nodeId === taskId) ?? null
  });
}

export async function removeBlock(
  projectRoot: PackageWorkspaceRef,
  ref: string
): Promise<GraphEditResult> {
  return executeDesktopPlanGraphCommand(projectRoot, { type: "removeBlock", blockRef: ref });
}

export async function validateGraphEdit(
  projectRoot: PackageWorkspaceRef,
  input: DesktopGraphEditValidationInput
): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  if (input.kind === "addDependencyEdge") {
    const mutation = buildPlanPackageGraphMutation(manifest, {
      kind: "addEdge",
      edge: { from: input.fromTaskId, to: input.toTaskId, type: "depends_on" }
    });
    return graphEditResult(mutation.nextManifest, mutation.affectedTasks);
  }
  if (input.kind === "removeDependencyEdge") {
    const mutation = buildPlanPackageGraphMutation(manifest, {
      kind: "removeEdge",
      edge: { from: input.fromTaskId, to: input.toTaskId, type: "depends_on" }
    });
    return graphEditResult(mutation.nextManifest, mutation.affectedTasks);
  }
  if (input.kind === "removeTaskNode") {
    const mutation = buildPlanPackageGraphMutation(manifest, {
      kind: "removeNode",
      nodeId: input.taskId
    });
    return graphEditResult(mutation.nextManifest, mutation.affectedTasks);
  }
  const mutation = buildPlanPackageGraphMutation(manifest, {
    kind: "removeBlock",
    blockRef: input.blockRef
  });
  return graphEditResult(mutation.nextManifest, mutation.affectedTasks);
}

function taskDependencyEdge(input: {
  dependentTaskId: string;
  dependsOnTaskId: string;
}): ManifestEdge {
  return { from: input.dependentTaskId, to: input.dependsOnTaskId, type: "depends_on" };
}

function removeBlockDependency(
  manifest: PlanPackageManifest,
  input: { blockRef: string; dependsOnBlockId: string }
): PlanPackageManifest {
  const { taskId, blockId } = parseBlockRef(input.blockRef);
  const task = manifest.nodes.find((node) => node.type === "task" && node.id === taskId);
  if (!task || task.type !== "task") {
    throw new Error(`Task '${taskId}' does not exist.`);
  }
  const block = task.blocks.find((candidate) => candidate.id === blockId);
  if (!block) {
    throw new Error(`Block '${input.blockRef}' does not exist.`);
  }
  return {
    ...manifest,
    nodes: manifest.nodes.map((node) =>
      node.type === "task" && node.id === taskId
        ? {
            ...task,
            blocks: task.blocks.map((candidate) =>
              candidate.id === blockId
                ? {
                    ...candidate,
                    depends_on: candidate.depends_on.filter(
                      (dependency) => dependency !== input.dependsOnBlockId
                    )
                  }
                : candidate
            )
          }
        : node
    )
  };
}

export async function bulkRemoveGraphItems(
  projectRoot: PackageWorkspaceRef,
  input: DesktopBulkRemoveGraphItemsInput
): Promise<GraphEditResult> {
  const taskIds = input.taskIds ?? [];
  const blockRefs = input.blockRefs ?? [];
  const taskDependencyEdges = input.taskDependencyEdges ?? [];
  const blockDependencyEdges = input.blockDependencyEdges ?? [];
  if (
    taskIds.length === 0 &&
    blockRefs.length === 0 &&
    taskDependencyEdges.length === 0 &&
    blockDependencyEdges.length === 0
  ) {
    throw new Error("bulk_remove_graph_items requires at least one item to remove.");
  }
  const { manifest } = await loadPackage(projectRoot);
  const blockedDiagnostics: ValidationIssue[] = [];
  for (const taskId of taskIds) {
    const blocked = await crossTaskEdgeDeleteDiagnostic(projectRoot, taskId);
    if (blocked) {
      blockedDiagnostics.push(...blocked.diagnostics);
    }
  }
  if (blockedDiagnostics.length > 0) {
    return graphEditDiagnostics(manifest, blockedDiagnostics);
  }

  let nextManifest = manifest;
  const affectedTasks: string[] = [];
  const sideEffects: PlanPackageGraphMutationSideEffect[] = [];
  for (const edge of taskDependencyEdges) {
    const mutation = buildPlanPackageGraphMutation(nextManifest, {
      kind: "removeEdge",
      edge: taskDependencyEdge(edge)
    });
    nextManifest = mutation.nextManifest;
    affectedTasks.push(...mutation.affectedTasks, edge.dependentTaskId, edge.dependsOnTaskId);
  }
  for (const edge of blockDependencyEdges) {
    const next = removeBlockDependency(nextManifest, edge);
    nextManifest = next;
    affectedTasks.push(parseBlockRef(edge.blockRef).taskId);
  }
  for (const blockRef of blockRefs) {
    const mutation = buildPlanPackageGraphMutation(nextManifest, { kind: "removeBlock", blockRef });
    nextManifest = mutation.nextManifest;
    affectedTasks.push(...mutation.affectedTasks, parseBlockRef(blockRef).taskId);
    sideEffects.push(...mutation.sideEffects);
  }
  for (const taskId of taskIds) {
    const mutation = buildPlanPackageGraphMutation(nextManifest, {
      kind: "removeNode",
      nodeId: taskId,
      removeTaskDirectory: true
    });
    nextManifest = mutation.nextManifest;
    affectedTasks.push(...mutation.affectedTasks, taskId);
    sideEffects.push(...mutation.sideEffects);
  }
  const result = await commitPlanPackageGraphMutation({
    projectRoot,
    mutation: buildPlanPackageManifestChangeMutation(manifest, nextManifest, {
      affectedTasks,
      sideEffects
    })
  });
  invalidateDesktopProjectProjection(projectRoot);
  return result;
}

export async function addDependencyEdge(
  projectRoot: PackageWorkspaceRef,
  fromTaskId: string,
  toTaskId: string,
  baseGraphVersion?: string,
  layoutSnapshot?: DesktopLayout
): Promise<GraphEditResult> {
  return executeDesktopPlanGraphCommand(
    projectRoot,
    { type: "addTaskDependency", fromTaskId, toTaskId, baseGraphVersion },
    { layoutSnapshot }
  );
}

export async function removeDependencyEdge(
  projectRoot: PackageWorkspaceRef,
  fromTaskId: string,
  toTaskId: string,
  baseGraphVersion?: string,
  layoutSnapshot?: DesktopLayout
): Promise<GraphEditResult> {
  return executeDesktopPlanGraphCommand(
    projectRoot,
    { type: "removeTaskDependency", fromTaskId, toTaskId, baseGraphVersion },
    { layoutSnapshot }
  );
}

export async function reconnectDependencyEdge(
  projectRoot: PackageWorkspaceRef,
  fromTaskId: string,
  oldToTaskId: string,
  newFromTaskId: string,
  newToTaskId: string,
  baseGraphVersion?: string,
  layoutSnapshot?: DesktopLayout
): Promise<GraphEditResult> {
  return executeDesktopPlanGraphCommand(
    projectRoot,
    {
      type: "reconnectTaskDependency",
      fromTaskId,
      oldToTaskId,
      newFromTaskId,
      newToTaskId,
      baseGraphVersion
    },
    { layoutSnapshot }
  );
}
