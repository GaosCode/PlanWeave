import { compileTaskGraph, parseBlockRef } from "./compileTaskGraph.js";
import { buildPlanPackageManifestChangeMutation } from "./mutation.js";
import { commitPlanPackageGraphMutation } from "./editGraph.js";
import { loadPackage } from "../package/loadPackage.js";
import type {
  GraphEditResult,
  ManifestEdge,
  ManifestTaskNode,
  PackageWorkspaceRef,
  PlanPackageManifest,
  ValidationIssue
} from "../types.js";

export type TaskDependencyInput = {
  dependentTaskId: string;
  dependsOnTaskId: string;
};

export type BlockDependencyUpdate = {
  blockRef: string;
  dependsOn: string[];
};

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, path };
}

function edgeKey(edge: ManifestEdge): string {
  return `${edge.from}\u0000${edge.type}\u0000${edge.to}`;
}

function result(manifest: PlanPackageManifest, diagnostics: ValidationIssue[]): GraphEditResult {
  return {
    ok: diagnostics.length === 0,
    affectedTasks: [],
    diagnostics,
    graph: compileTaskGraph(manifest)
  };
}

function ensureTaskExists(
  manifest: PlanPackageManifest,
  taskId: string,
  field: string
): ValidationIssue | null {
  return manifest.nodes.some((node) => node.id === taskId)
    ? null
    : issue("task_missing", `Task '${taskId}' does not exist.`, field);
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates];
}

function getTask(manifest: PlanPackageManifest, taskId: string): ManifestTaskNode | null {
  const node = manifest.nodes.find(
    (candidate) => candidate.type === "task" && candidate.id === taskId
  );
  return node?.type === "task" ? node : null;
}

function ensureBlockUpdate(
  manifest: PlanPackageManifest,
  update: BlockDependencyUpdate
): ValidationIssue[] {
  const { taskId, blockId } = parseBlockRef(update.blockRef);
  const task = getTask(manifest, taskId);
  if (!task) {
    return [issue("task_missing", `Task '${taskId}' does not exist.`, "blockRef")];
  }
  const blockIds = new Set(task.blocks.map((block) => block.id));
  const diagnostics: ValidationIssue[] = [];
  if (!blockIds.has(blockId)) {
    diagnostics.push(
      issue("block_missing", `Block '${update.blockRef}' does not exist.`, "blockRef")
    );
  }
  for (const dependencyId of update.dependsOn) {
    if (!blockIds.has(dependencyId)) {
      diagnostics.push(
        issue(
          "block_dependency_missing",
          `Block '${update.blockRef}' depends on missing block '${dependencyId}'.`,
          "dependsOn"
        )
      );
    }
  }
  return diagnostics;
}

function uniqueEdges(edges: ManifestEdge[]): ManifestEdge[] {
  const seen = new Set<string>();
  const unique: ManifestEdge[] = [];
  for (const edge of edges) {
    const key = edgeKey(edge);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(edge);
  }
  return unique;
}

export async function setTaskDependencies(options: {
  projectRoot: PackageWorkspaceRef;
  taskId: string;
  dependsOn: string[];
}): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(options.projectRoot);
  const diagnostics = [
    ensureTaskExists(manifest, options.taskId, "taskId"),
    ...options.dependsOn.map((taskId) => ensureTaskExists(manifest, taskId, "dependsOn"))
  ].filter((item) => item !== null);
  if (diagnostics.length > 0) {
    return result(manifest, diagnostics);
  }
  const nextManifest: PlanPackageManifest = {
    ...manifest,
    edges: uniqueEdges([
      ...manifest.edges.filter(
        (edge) => !(edge.type === "depends_on" && edge.from === options.taskId)
      ),
      ...options.dependsOn.map((taskId) => ({
        from: options.taskId,
        to: taskId,
        type: "depends_on" as const
      }))
    ])
  };
  return commitPlanPackageGraphMutation({
    projectRoot: options.projectRoot,
    mutation: buildPlanPackageManifestChangeMutation(manifest, nextManifest, {
      affectedTasks: [options.taskId, ...options.dependsOn]
    })
  });
}

export async function bulkAddTaskDependencies(options: {
  projectRoot: PackageWorkspaceRef;
  edges: TaskDependencyInput[];
}): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(options.projectRoot);
  const diagnostics = options.edges.flatMap((edge) =>
    [
      ensureTaskExists(manifest, edge.dependentTaskId, "dependentTaskId"),
      ensureTaskExists(manifest, edge.dependsOnTaskId, "dependsOnTaskId")
    ].filter((item) => item !== null)
  );
  if (diagnostics.length > 0) {
    return result(manifest, diagnostics);
  }
  const nextManifest: PlanPackageManifest = {
    ...manifest,
    edges: uniqueEdges([
      ...manifest.edges,
      ...options.edges.map((edge) => ({
        from: edge.dependentTaskId,
        to: edge.dependsOnTaskId,
        type: "depends_on" as const
      }))
    ])
  };
  return commitPlanPackageGraphMutation({
    projectRoot: options.projectRoot,
    mutation: buildPlanPackageManifestChangeMutation(manifest, nextManifest, {
      affectedTasks: options.edges.flatMap((edge) => [edge.dependentTaskId, edge.dependsOnTaskId])
    })
  });
}

export async function bulkSetTaskDependencies(options: {
  projectRoot: PackageWorkspaceRef;
  updates: Array<{ taskId: string; dependsOn: string[] }>;
}): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(options.projectRoot);
  const diagnostics = [
    ...duplicateValues(options.updates.map((update) => update.taskId)).map((taskId) =>
      issue(
        "duplicate_dependency_update",
        `Task '${taskId}' has more than one dependency update.`,
        "updates"
      )
    ),
    ...options.updates.flatMap((update) =>
      [
        ensureTaskExists(manifest, update.taskId, "taskId"),
        ...update.dependsOn.map((taskId) => ensureTaskExists(manifest, taskId, "dependsOn"))
      ].filter((item) => item !== null)
    )
  ];
  if (diagnostics.length > 0) {
    return result(manifest, diagnostics);
  }
  const replacedTaskIds = new Set(options.updates.map((update) => update.taskId));
  const nextManifest: PlanPackageManifest = {
    ...manifest,
    edges: uniqueEdges([
      ...manifest.edges.filter(
        (edge) => !(edge.type === "depends_on" && replacedTaskIds.has(edge.from))
      ),
      ...options.updates.flatMap((update) =>
        update.dependsOn.map((taskId) => ({
          from: update.taskId,
          to: taskId,
          type: "depends_on" as const
        }))
      )
    ])
  };
  return commitPlanPackageGraphMutation({
    projectRoot: options.projectRoot,
    mutation: buildPlanPackageManifestChangeMutation(manifest, nextManifest, {
      affectedTasks: options.updates.flatMap((update) => [update.taskId, ...update.dependsOn])
    })
  });
}

export async function bulkSetBlockDependencies(options: {
  projectRoot: PackageWorkspaceRef;
  updates: BlockDependencyUpdate[];
}): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(options.projectRoot);
  const diagnostics = [
    ...duplicateValues(options.updates.map((update) => update.blockRef)).map((blockRef) =>
      issue(
        "duplicate_dependency_update",
        `Block '${blockRef}' has more than one dependency update.`,
        "updates"
      )
    ),
    ...options.updates.flatMap((update) => ensureBlockUpdate(manifest, update))
  ];
  if (diagnostics.length > 0) {
    return result(manifest, diagnostics);
  }

  const updatesByTask = new Map<string, Map<string, string[]>>();
  for (const update of options.updates) {
    const { taskId, blockId } = parseBlockRef(update.blockRef);
    const taskUpdates = updatesByTask.get(taskId) ?? new Map<string, string[]>();
    taskUpdates.set(blockId, update.dependsOn);
    updatesByTask.set(taskId, taskUpdates);
  }

  const nextManifest: PlanPackageManifest = {
    ...manifest,
    nodes: manifest.nodes.map((node) => {
      if (node.type !== "task") {
        return node;
      }
      const taskUpdates = updatesByTask.get(node.id);
      if (!taskUpdates) {
        return node;
      }
      return {
        ...node,
        blocks: node.blocks.map((block) =>
          taskUpdates.has(block.id)
            ? {
                ...block,
                depends_on: taskUpdates.get(block.id) ?? []
              }
            : block
        )
      };
    })
  };

  return commitPlanPackageGraphMutation({
    projectRoot: options.projectRoot,
    mutation: buildPlanPackageManifestChangeMutation(manifest, nextManifest, {
      affectedTasks: [...updatesByTask.keys()]
    })
  });
}
