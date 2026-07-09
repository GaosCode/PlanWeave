import type {
  CompiledExecutionGraph,
  ManifestBlock,
  ManifestTaskNode,
  PlanPackageManifest,
  ValidationIssue
} from "../../types.js";
import type { PlanGraphCommandDiagnostic } from "../commands.js";
import type {
  PlanGraph,
  PlanGraphBlockNode,
  PlanGraphEdge,
  PlanGraphTaskNode,
  PromptIndexEntry,
  PromptRef
} from "./types.js";

export type BuildPlanGraphInput = {
  manifest: PlanPackageManifest;
  compiledGraph: CompiledExecutionGraph;
  graphVersion: string;
  packageFingerprint: string;
  promptIndex: Map<string, PromptIndexEntry>;
  diagnostics?: PlanGraphCommandDiagnostic[];
  canvasId?: string | null;
};

function blockRef(taskId: string, blockId: string): string {
  return `${taskId}#${blockId}`;
}

function diagnosticFromValidation(issue: ValidationIssue): PlanGraphCommandDiagnostic {
  return {
    code: issue.code,
    message: issue.message,
    path: issue.path
  };
}

function missingPromptRef(ownerKind: "task" | "block", ownerRef: string, path: string): PromptRef {
  return {
    ownerKind,
    ownerRef,
    path,
    contentHash: "",
    preview: ""
  };
}

function taskNode(
  task: ManifestTaskNode,
  promptRef: PromptRef,
  canvasId: string | null
): PlanGraphTaskNode {
  return {
    taskId: task.id,
    canvasId,
    title: task.title,
    promptRef,
    acceptance: [...task.acceptance],
    executor: task.executor ?? null,
    blockRefs: task.blocks.map((block) => blockRef(task.id, block.id))
  };
}

function blockNode(taskId: string, block: ManifestBlock, promptRef: PromptRef): PlanGraphBlockNode {
  const ref = blockRef(taskId, block.id);
  return {
    ref,
    taskId,
    blockId: block.id,
    type: block.type,
    title: block.title,
    promptRef,
    executor: block.executor ?? null,
    dependsOn: block.depends_on.map((dependency) => blockRef(taskId, dependency))
  };
}

export function buildPlanGraph(input: BuildPlanGraphInput): PlanGraph {
  const diagnostics: PlanGraphCommandDiagnostic[] = [
    ...input.compiledGraph.diagnostics.errors.map(diagnosticFromValidation),
    ...input.compiledGraph.diagnostics.warnings.map(diagnosticFromValidation),
    ...(input.diagnostics ?? [])
  ];
  const tasks = new Map<string, PlanGraphTaskNode>();
  const blocks = new Map<string, PlanGraphBlockNode>();
  const promptRefs = new Map<string, PromptRef>();
  const canvasId = input.canvasId ?? null;

  for (const taskId of input.compiledGraph.taskNodesInManifestOrder) {
    const task = input.compiledGraph.tasksById.get(taskId);
    if (!task) {
      continue;
    }
    const taskPrompt =
      input.promptIndex.get(task.prompt) ?? missingPromptRef("task", task.id, task.prompt);
    promptRefs.set(taskPrompt.ownerRef, taskPrompt);
    tasks.set(task.id, taskNode(task, taskPrompt, canvasId));

    for (const block of task.blocks) {
      const ref = blockRef(task.id, block.id);
      const prompt =
        input.promptIndex.get(block.prompt) ?? missingPromptRef("block", ref, block.prompt);
      promptRefs.set(prompt.ownerRef, prompt);
      blocks.set(ref, blockNode(task.id, block, prompt));
    }
  }

  const edges: PlanGraphEdge[] = [];
  for (const [fromTaskId, dependencies] of input.compiledGraph.taskDependenciesByTask) {
    for (const toTaskId of dependencies) {
      edges.push({ type: "taskDependsOn", fromTaskId, toTaskId });
    }
  }
  for (const [fromBlockRef, dependencies] of input.compiledGraph.blockDependenciesByRef) {
    for (const toBlockRef of dependencies) {
      edges.push({ type: "blockDependsOn", fromBlockRef, toBlockRef });
    }
  }

  return {
    graphVersion: input.graphVersion,
    packageFingerprint: input.packageFingerprint,
    project: { ...input.manifest.project },
    tasks,
    blocks,
    edges,
    promptRefs,
    diagnostics
  };
}
