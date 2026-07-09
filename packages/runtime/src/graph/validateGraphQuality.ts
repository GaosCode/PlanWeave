import { compilePackageGraph } from "./compileTaskGraph.js";
import { readFile } from "node:fs/promises";
import { loadPackage } from "../package/loadPackage.js";
import { resolvePackagePath } from "../package/resolvePackagePath.js";
import type {
  CompiledExecutionGraph,
  GraphQualityDiagnostic,
  GraphQualityDiagnosticSeverity,
  GraphQualityGatePolicy,
  GraphQualityReport,
  GraphQualityReviewPolicy,
  ManifestTaskNode,
  ValidateGraphQualityInput,
  ValidationIssue
} from "../types.js";

const DEFAULT_SPARSE_TASK_THRESHOLD = 4;

function examples(ids: string[]): string[] {
  return ids.slice(0, 5);
}

function diagnostic(input: {
  code: string;
  severity: GraphQualityDiagnosticSeverity;
  message: string;
  affectedIds: string[];
  suggestion: string;
  suggestedTool?: string;
  fixId?: string;
  ruleType: GraphQualityDiagnostic["ruleType"];
}): GraphQualityDiagnostic {
  return {
    code: input.code,
    severity: input.severity,
    message: input.message,
    count: input.affectedIds.length,
    examples: examples(input.affectedIds),
    suggestion: input.suggestion,
    suggestedTool: input.suggestedTool,
    fixId: input.fixId,
    ruleType: input.ruleType,
    affectedIds: input.affectedIds
  };
}

function compileGraphDiagnostic(
  issue: ValidationIssue,
  severity: GraphQualityDiagnosticSeverity
): GraphQualityDiagnostic {
  return diagnostic({
    code: issue.code,
    severity,
    message: issue.message,
    affectedIds: [issue.path ?? issue.code],
    suggestion:
      severity === "error"
        ? "Fix the underlying Plan Package graph error before running graph quality checks."
        : "Review the underlying Plan Package graph warning before running execution.",
    suggestedTool: "validate_project",
    ruleType: "structural"
  });
}

function compileGraphDiagnostics(graph: CompiledExecutionGraph): GraphQualityDiagnostic[] {
  return [
    ...graph.diagnostics.errors.map((issue) => compileGraphDiagnostic(issue, "error")),
    ...graph.diagnostics.warnings.map((issue) => compileGraphDiagnostic(issue, "warning"))
  ];
}

function implementationBlocks(task: ManifestTaskNode) {
  return task.blocks.filter((block) => block.type === "implementation");
}

function reviewBlocks(task: ManifestTaskNode) {
  return task.blocks.filter((block) => block.type === "review");
}

function isConservativeGateTask(task: ManifestTaskNode): boolean {
  return task.id === "GATE" || /[-_]GATE$/.test(task.id) || /\bgate\b/i.test(task.title);
}

function taskDependencyCount(graph: CompiledExecutionGraph): number {
  return [...graph.taskDependenciesByTask.values()].reduce(
    (count, dependencies) => count + dependencies.length,
    0
  );
}

function missingImplementationTasks(graph: CompiledExecutionGraph): GraphQualityDiagnostic | null {
  const affectedIds = graph.taskNodesInManifestOrder.filter((taskId) => {
    const task = graph.tasksById.get(taskId);
    return task ? implementationBlocks(task).length === 0 : false;
  });
  if (affectedIds.length === 0) {
    return null;
  }
  return diagnostic({
    code: "task_missing_implementation_block",
    severity: "error",
    message: "Tasks must include at least one implementation block.",
    affectedIds,
    suggestion: "Add an implementation block to each affected task.",
    suggestedTool: "create_block",
    fixId: "add_implementation_blocks",
    ruleType: "structural"
  });
}

function reviewsMissingImplementationDependencies(
  graph: CompiledExecutionGraph,
  strict: boolean
): GraphQualityDiagnostic | null {
  const affectedIds: string[] = [];
  for (const taskId of graph.taskNodesInManifestOrder) {
    const task = graph.tasksById.get(taskId);
    if (!task) {
      continue;
    }
    const implementationRefs = implementationBlocks(task).map((block) => `${taskId}#${block.id}`);
    if (implementationRefs.length === 0) {
      continue;
    }
    for (const block of reviewBlocks(task)) {
      const reviewRef = `${taskId}#${block.id}`;
      const missing = implementationRefs.filter(
        (implementationRef) => !graph.blockReachable(reviewRef, implementationRef)
      );
      if (missing.length > 0) {
        affectedIds.push(reviewRef);
      }
    }
  }
  if (affectedIds.length === 0) {
    return null;
  }
  return diagnostic({
    code: "review_missing_implementation_dependency",
    severity: strict ? "error" : "warning",
    message: "Review blocks should depend on the implementation blocks they review.",
    affectedIds,
    suggestion: "Add missing implementation block dependencies to each affected review block.",
    suggestedTool: "set_block_dependencies",
    fixId: "connect_review_blocks_to_implementation",
    ruleType: "structural"
  });
}

function orphanedTasks(graph: CompiledExecutionGraph): GraphQualityDiagnostic | null {
  if (graph.taskNodesInManifestOrder.length <= 1) {
    return null;
  }
  const affectedIds = graph.taskNodesInManifestOrder.filter(
    (taskId) =>
      (graph.taskDependenciesByTask.get(taskId) ?? []).length === 0 &&
      (graph.taskDependentsByTask.get(taskId) ?? []).length === 0
  );
  if (affectedIds.length === 0) {
    return null;
  }
  return diagnostic({
    code: "task_orphaned",
    severity: "warning",
    message: "Some tasks are not connected to the task dependency graph.",
    affectedIds,
    suggestion:
      "Connect independent tasks with depends_on edges when execution order matters, or split unrelated work into separate plans.",
    suggestedTool: "add_task_dependency",
    ruleType: "structural"
  });
}

function missingReviewBlocks(
  graph: CompiledExecutionGraph,
  reviewPolicy: GraphQualityReviewPolicy,
  strict: boolean
): GraphQualityDiagnostic | null {
  if (reviewPolicy === "none") {
    return null;
  }
  const affectedIds = graph.taskNodesInManifestOrder.filter((taskId) => {
    const task = graph.tasksById.get(taskId);
    return task ? reviewBlocks(task).length === 0 : false;
  });
  if (affectedIds.length === 0) {
    return null;
  }
  return diagnostic({
    code: "task_missing_review_block",
    severity: reviewPolicy === "required" ? (strict ? "error" : "warning") : "info",
    message: "Some tasks do not include a review block.",
    affectedIds,
    suggestion:
      "Add review blocks for tasks where implementation quality should be independently checked.",
    suggestedTool: "create_block",
    fixId: "add_review_blocks",
    ruleType: "policy"
  });
}

function missingCanvasGate(
  graph: CompiledExecutionGraph,
  gatePolicy: GraphQualityGatePolicy,
  strict: boolean
): GraphQualityDiagnostic | null {
  if (gatePolicy === "none") {
    return null;
  }
  const hasGate = graph.taskNodesInManifestOrder.some((taskId) => {
    const task = graph.tasksById.get(taskId);
    return task ? isConservativeGateTask(task) : false;
  });
  if (hasGate) {
    return null;
  }
  return diagnostic({
    code: "canvas_gate_missing",
    severity: strict ? "error" : "warning",
    message: "The canvas is missing a gate task required by the configured gate policy.",
    affectedIds: ["canvas"],
    suggestion:
      "Add a clearly named gate task, for example id GATE, an id ending in -GATE or _GATE, or a title containing Gate.",
    suggestedTool: "create_task",
    fixId: "add_canvas_gate_task",
    ruleType: "policy"
  });
}

function gateIncompleteDependencies(
  graph: CompiledExecutionGraph,
  strict: boolean
): GraphQualityDiagnostic | null {
  const gateTaskIds: string[] = [];
  const requiredTaskIds: string[] = [];
  for (const taskId of graph.taskNodesInManifestOrder) {
    const task = graph.tasksById.get(taskId);
    if (!task) {
      continue;
    }
    if (isConservativeGateTask(task)) {
      gateTaskIds.push(taskId);
    } else {
      requiredTaskIds.push(taskId);
    }
  }
  if (gateTaskIds.length === 0 || requiredTaskIds.length === 0) {
    return null;
  }

  const affectedIds: string[] = [];
  for (const gateTaskId of gateTaskIds) {
    const dependencies = new Set(graph.taskDependenciesByTask.get(gateTaskId) ?? []);
    for (const requiredTaskId of requiredTaskIds) {
      if (!dependencies.has(requiredTaskId)) {
        affectedIds.push(`${gateTaskId}->${requiredTaskId}`);
      }
    }
  }
  if (affectedIds.length === 0) {
    return null;
  }
  return diagnostic({
    code: "canvas_gate_incomplete_dependencies",
    severity: strict ? "error" : "warning",
    message: "Gate tasks should depend on every non-gate task in the same canvas.",
    affectedIds,
    suggestion: "Add depends_on task edges from each gate task to every required non-gate task.",
    suggestedTool: "bulk_add_task_dependencies",
    fixId: "connect_canvas_gate_dependencies",
    ruleType: "structural"
  });
}

function sparseDependencies(
  graph: CompiledExecutionGraph,
  heuristics: "on" | "off",
  minTaskCountForSparseCheck: number
): GraphQualityDiagnostic | null {
  const taskCount = graph.taskNodesInManifestOrder.length;
  if (
    heuristics === "off" ||
    taskCount < minTaskCountForSparseCheck ||
    taskDependencyCount(graph) > 0
  ) {
    return null;
  }
  return diagnostic({
    code: "graph_sparse_dependencies",
    severity: "warning",
    message: "The task graph has several tasks but no task dependencies.",
    affectedIds: graph.taskNodesInManifestOrder,
    suggestion:
      "Add depends_on edges for real execution ordering constraints, or keep heuristics off for intentionally independent plans.",
    suggestedTool: "bulk_add_task_dependencies",
    ruleType: "heuristic"
  });
}

function reviewLoopCyclesMissing(
  graph: CompiledExecutionGraph,
  reviewPolicy: GraphQualityReviewPolicy,
  strict: boolean
): GraphQualityDiagnostic | null {
  if (reviewPolicy === "none") {
    return null;
  }
  const reviewRefs = graph.blockRefsInManifestOrder.filter(
    (ref) => graph.blocksByRef.get(ref)?.type === "review"
  );
  if (reviewRefs.length === 0) {
    return null;
  }
  const affectedIds = reviewRefs.filter((ref) => {
    const block = graph.blocksByRef.get(ref);
    return (
      block?.type === "review" && block.review.required && block.review.maxFeedbackCycles === 0
    );
  });
  if (affectedIds.length === 0) {
    return null;
  }
  return diagnostic({
    code: "review_loop_cycles_missing",
    severity: reviewPolicy === "required" && strict ? "error" : "warning",
    message: "Required review blocks should allow at least one feedback cycle.",
    affectedIds,
    suggestion:
      "Set review.maxFeedbackCycles to at least 1 for review gates that are expected to drive a feedback loop.",
    suggestedTool: "set_review_pipeline",
    fixId: "enable_review_feedback_cycles",
    ruleType: "policy"
  });
}

function layoutSingleColumnRisk(
  graph: CompiledExecutionGraph,
  heuristics: "on" | "off"
): GraphQualityDiagnostic | null {
  const taskCount = graph.taskNodesInManifestOrder.length;
  if (heuristics === "off" || taskCount < 10) {
    return null;
  }
  const edgeCount = taskDependencyCount(graph);
  if (edgeCount > Math.floor(taskCount / 2)) {
    return null;
  }
  return diagnostic({
    code: "layout_single_column_risk",
    severity: "info",
    message:
      "Large canvases with very few task dependencies are likely to render as a hard-to-scan flat layout.",
    affectedIds: graph.taskNodesInManifestOrder,
    suggestion: "Add dependency lanes or apply a canvas lane layout after import.",
    suggestedTool: "bulk_add_task_dependencies",
    fixId: "apply_canvas_lane_layout",
    ruleType: "heuristic"
  });
}

function acceptanceTooWeak(
  graph: CompiledExecutionGraph,
  heuristics: "on" | "off"
): GraphQualityDiagnostic | null {
  if (heuristics === "off") {
    return null;
  }
  const weakPhrases = new Set(["works", "done", "implemented", "complete", "n/a", "todo"]);
  const affectedIds = graph.taskNodesInManifestOrder.filter((taskId) => {
    const task = graph.tasksById.get(taskId);
    if (!task) {
      return false;
    }
    return task.acceptance.some((item) => {
      const normalized = item.trim().toLowerCase();
      return normalized.length < 8 || weakPhrases.has(normalized);
    });
  });
  if (affectedIds.length === 0) {
    return null;
  }
  return diagnostic({
    code: "acceptance_too_weak",
    severity: "info",
    message: "Some tasks have acceptance criteria that are too short or generic to guide review.",
    affectedIds,
    suggestion: "Replace generic acceptance criteria with observable, testable outcomes.",
    suggestedTool: "update_task_acceptance",
    fixId: "strengthen_acceptance_criteria",
    ruleType: "heuristic"
  });
}

async function promptDuplicateMany(
  graph: CompiledExecutionGraph,
  packageDir: string,
  heuristics: "on" | "off"
): Promise<GraphQualityDiagnostic[]> {
  if (heuristics === "off") {
    return [];
  }
  const refsByPrompt = new Map<string, string[]>();
  const unreadableRefs: string[] = [];
  for (const ref of graph.blockRefsInManifestOrder) {
    const block = graph.blocksByRef.get(ref);
    if (!block) {
      continue;
    }
    try {
      const content = (
        await readFile(
          await resolvePackagePath(packageDir, block.prompt, { requireExisting: true }),
          "utf8"
        )
      ).trim();
      if (!content) {
        continue;
      }
      const refs = refsByPrompt.get(content) ?? [];
      refs.push(ref);
      refsByPrompt.set(content, refs);
    } catch {
      unreadableRefs.push(ref);
    }
  }
  const diagnostics: GraphQualityDiagnostic[] = [];
  const affectedIds = [...refsByPrompt.values()].filter((refs) => refs.length >= 3).flat();
  if (affectedIds.length > 0) {
    diagnostics.push(
      diagnostic({
        code: "prompt_duplicate_many",
        severity: "info",
        message: "Several blocks share identical prompt text.",
        affectedIds,
        suggestion:
          "Use shared policy prompts for common guidance, but keep block prompts specific to the assigned work.",
        suggestedTool: "write_prompt_source",
        ruleType: "heuristic"
      })
    );
  }
  if (unreadableRefs.length > 0) {
    diagnostics.push(
      diagnostic({
        code: "prompt_heuristic_read_failed",
        severity: "warning",
        message: "Some prompt files could not be read during graph quality heuristics.",
        affectedIds: unreadableRefs,
        suggestion:
          "Run validate_project and fix missing or unreadable prompt files before relying on heuristic quality checks.",
        suggestedTool: "validate_project",
        ruleType: "heuristic"
      })
    );
  }
  return diagnostics;
}

function orphanTaskCount(graph: CompiledExecutionGraph): number {
  if (graph.taskNodesInManifestOrder.length <= 1) {
    return 0;
  }
  return graph.taskNodesInManifestOrder.filter(
    (taskId) =>
      (graph.taskDependenciesByTask.get(taskId) ?? []).length === 0 &&
      (graph.taskDependentsByTask.get(taskId) ?? []).length === 0
  ).length;
}

function qualityScore(errorCount: number, warningCount: number, infoCount: number): number {
  return Math.max(0, Math.min(100, 100 - errorCount * 35 - warningCount * 10 - infoCount * 3));
}

export async function validateGraphQuality(
  input: ValidateGraphQualityInput
): Promise<GraphQualityReport> {
  const reviewPolicy = input.reviewPolicy ?? "risk-based";
  const gatePolicy = input.gatePolicy ?? "none";
  const heuristics = input.heuristics ?? "on";
  const strict = input.strict ?? false;
  const minTaskCountForSparseCheck =
    input.minTaskCountForSparseCheck ?? DEFAULT_SPARSE_TASK_THRESHOLD;
  const { workspace, manifest } = await loadPackage(input.projectRoot);
  const graph = await compilePackageGraph(manifest, workspace.packageDir, {
    validatePromptContents: false
  });
  const promptHeuristicDiagnostics = await promptDuplicateMany(
    graph,
    workspace.packageDir,
    heuristics
  );
  const diagnostics = [
    ...compileGraphDiagnostics(graph),
    missingImplementationTasks(graph),
    reviewsMissingImplementationDependencies(graph, strict),
    orphanedTasks(graph),
    missingReviewBlocks(graph, reviewPolicy, strict),
    missingCanvasGate(graph, gatePolicy, strict),
    gateIncompleteDependencies(graph, strict),
    reviewLoopCyclesMissing(graph, reviewPolicy, strict),
    sparseDependencies(graph, heuristics, minTaskCountForSparseCheck),
    layoutSingleColumnRisk(graph, heuristics),
    acceptanceTooWeak(graph, heuristics),
    ...promptHeuristicDiagnostics
  ].filter((item) => item !== null);
  const errorCount = diagnostics.filter((item) => item.severity === "error").length;
  const warningCount = diagnostics.filter((item) => item.severity === "warning").length;
  const infoCount = diagnostics.filter((item) => item.severity === "info").length;
  const orphanCount = orphanTaskCount(graph);

  return {
    ok: errorCount === 0,
    summary: {
      taskCount: graph.taskNodesInManifestOrder.length,
      blockCount: graph.blockRefsInManifestOrder.length,
      taskDependencyCount: taskDependencyCount(graph),
      reviewBlockCount: [...graph.reviewBlocksByTask.values()].reduce(
        (count, refs) => count + refs.length,
        0
      ),
      orphanTaskCount: orphanCount,
      score: qualityScore(errorCount, warningCount, infoCount),
      errorCount,
      warningCount,
      infoCount
    },
    diagnostics
  };
}
