import type { Command } from "commander";
import {
  inspectGraph,
  validateGraphQuality,
  type GraphInspectionResult,
  type GraphInspectionView,
  type GraphQualityDiagnosticSeverity,
  type GraphQualityGatePolicy,
  type GraphQualityHeuristics,
  type GraphQualityReport,
  type GraphQualityReviewPolicy
} from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";

const graphInspectionViews = ["summary", "tasks", "slice"] as const;
const graphQualityReviewPolicies = ["none", "risk-based", "required"] as const;
const graphQualityGatePolicies = ["none", "required"] as const;
const graphQualityHeuristics = ["on", "off"] as const;
const diagnosticSeverities: GraphQualityDiagnosticSeverity[] = ["error", "warning", "info"];

type GraphInspectOptions = {
  view?: string;
  task?: string;
  limit?: string;
  cursor?: string;
  json?: boolean;
} & CanvasCommandOptions;

type GraphQualityOptions = {
  json?: boolean;
  reviewPolicy?: string;
  gatePolicy?: string;
  heuristics?: string;
  strict?: boolean;
  minTaskCountForSparseCheck?: string;
} & CanvasCommandOptions;

function isOneOf<T extends string>(value: string, choices: readonly T[]): value is T {
  return choices.includes(value as T);
}

function parseChoice<T extends string>(
  flag: string,
  value: string | undefined,
  choices: readonly T[],
  defaultValue: T
): T {
  const candidate = value ?? defaultValue;
  if (isOneOf(candidate, choices)) {
    return candidate;
  }
  throw new Error(`Invalid ${flag} '${candidate}'. Expected one of: ${choices.join(", ")}.`);
}

function parsePositiveInteger(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value.trim()) {
    throw new Error(`Invalid ${flag} '${value}'. Expected a positive integer.`);
  }
  return parsed;
}

function formatPage(label: string, page: { total: number; nextCursor: string | null }): string {
  return `${label}: total ${page.total}, next cursor ${page.nextCursor ?? "none"}`;
}

function formatBoundedSection(
  label: string,
  section: { total: number; truncated: boolean }
): string {
  return `${label}: total ${section.total}, truncated ${section.truncated ? "yes" : "no"}`;
}

function formatGraphInspectHuman(result: GraphInspectionResult): string {
  if (result.view === "summary") {
    const lines = [
      "Graph summary",
      `project: ${result.project.title} (${result.project.id})`,
      `canvas: ${result.canvas.id ?? "none"} (${result.canvas.title})`,
      `counts: tasks ${result.counts.taskCount}, blocks ${result.counts.blockCount}, task dependencies ${result.counts.taskDependencyCount}, review blocks ${result.counts.reviewBlockCount}, ready blocks ${result.counts.readyBlockCount}, diagnostics ${result.counts.diagnosticCount}`,
      formatPage("tasks preview", result.page)
    ];
    for (const task of result.tasksPreview) {
      lines.push(
        `- task ${task.taskId}: ${task.title} [${task.status}], blocks ${task.blockCount}, reviews ${task.reviewBlockCount}`
      );
    }
    return lines.join("\n");
  }

  if (result.view === "tasks") {
    const lines = ["Graph tasks", formatPage("tasks", result.page)];
    for (const task of result.tasks) {
      lines.push(
        `- task ${task.taskId}: ${task.title} [${task.status}], blocks ${task.blockCount}, reviews ${task.reviewBlockCount}`
      );
    }
    return lines.join("\n");
  }

  const lines = [
    `Graph slice: ${result.taskId}`,
    `center task: ${result.center.taskId}: ${result.center.title} [${result.center.status}], blocks ${result.center.blockCount}, reviews ${result.center.reviewBlockCount}`,
    formatBoundedSection("dependencies", result.dependencies),
    formatBoundedSection("dependents", result.dependents),
    formatBoundedSection("edges", result.edges),
    formatBoundedSection("blocks", result.blocks)
  ];
  for (const task of result.dependencies.items) {
    lines.push(
      `- dependency task ${task.taskId}: ${task.title} [${task.status}], blocks ${task.blockCount}`
    );
  }
  for (const task of result.dependents.items) {
    lines.push(
      `- dependent task ${task.taskId}: ${task.title} [${task.status}], blocks ${task.blockCount}`
    );
  }
  for (const edge of result.edges.items) {
    lines.push(`- edge ${edge.from} -> ${edge.to}`);
  }
  for (const block of result.blocks.items) {
    lines.push(
      `- block ${block.ref}: ${block.title} [${block.type}, ${block.status}], dependencies ${block.dependsOn.length}`
    );
  }
  return lines.join("\n");
}

function formatGraphQualityHuman(report: GraphQualityReport): string {
  const lines = [
    `Graph quality: ${report.ok ? "ok" : "failed"}`,
    `summary: tasks ${report.summary.taskCount}, blocks ${report.summary.blockCount}, task dependencies ${report.summary.taskDependencyCount}, review blocks ${report.summary.reviewBlockCount}, errors ${report.summary.errorCount}, warnings ${report.summary.warningCount}, info ${report.summary.infoCount}`
  ];

  if (report.diagnostics.length === 0) {
    lines.push("diagnostics: none");
    return lines.join("\n");
  }

  for (const severity of diagnosticSeverities) {
    const diagnostics = report.diagnostics.filter((diagnostic) => diagnostic.severity === severity);
    if (diagnostics.length === 0) {
      continue;
    }
    lines.push(`${severity}s:`);
    for (const diagnostic of diagnostics) {
      lines.push(
        `- ${diagnostic.code}: ${diagnostic.message} (count ${diagnostic.count}; examples ${diagnostic.examples.join(", ") || "none"})`
      );
      lines.push(`  suggestion: ${diagnostic.suggestion}`);
    }
  }

  return lines.join("\n");
}

export function registerGraphCommand(program: Command): void {
  const graph = program.command("graph").description("Inspect and validate PlanWeave task graphs");

  addCanvasOption(
    graph
      .command("inspect")
      .description("Inspect the selected task graph")
      .option(
        "--view <summary|tasks|slice>",
        "inspection view: summary, tasks, or slice",
        "summary"
      )
      .option("--task <taskId>", "task id for --view slice")
      .option("--limit <n>", "maximum number of items to return")
      .option("--cursor <cursor>", "pagination cursor returned by summary or tasks inspections")
      .option("--json", "print machine-readable output")
  ).action(async (options: GraphInspectOptions) => {
    const view = parseChoice<GraphInspectionView>(
      "--view",
      options.view,
      graphInspectionViews,
      "summary"
    );
    if (view === "slice" && options.cursor) {
      throw new Error("--cursor is not supported for graph inspect --view slice.");
    }
    const limit = parsePositiveInteger("--limit", options.limit);
    const result = await inspectGraph({
      projectRoot: await resolveCliPackageWorkspace(options),
      view,
      taskId: options.task,
      limit,
      cursor: options.cursor
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatGraphInspectHuman(result));
  });

  addCanvasOption(
    graph
      .command("quality")
      .description("Validate graph structure and quality policy")
      .option("--json", "print machine-readable output")
      .option(
        "--review-policy <none|risk-based|required>",
        "review coverage policy: none, risk-based, or required"
      )
      .option("--gate-policy <none|required>", "canvas gate policy: none or required")
      .option("--heuristics <on|off>", "enable or disable heuristic diagnostics")
      .option("--strict", "promote strict policy diagnostics to errors")
      .option(
        "--min-task-count-for-sparse-check <n>",
        "minimum task count before sparse dependency heuristics run"
      )
  ).action(async (options: GraphQualityOptions) => {
    const reviewPolicy = parseChoice<GraphQualityReviewPolicy>(
      "--review-policy",
      options.reviewPolicy,
      graphQualityReviewPolicies,
      "risk-based"
    );
    const gatePolicy = parseChoice<GraphQualityGatePolicy>(
      "--gate-policy",
      options.gatePolicy,
      graphQualityGatePolicies,
      "none"
    );
    const heuristics = parseChoice<GraphQualityHeuristics>(
      "--heuristics",
      options.heuristics,
      graphQualityHeuristics,
      "on"
    );
    const minTaskCountForSparseCheck = parsePositiveInteger(
      "--min-task-count-for-sparse-check",
      options.minTaskCountForSparseCheck
    );
    const report = await validateGraphQuality({
      projectRoot: await resolveCliPackageWorkspace(options),
      reviewPolicy,
      gatePolicy,
      heuristics,
      strict: options.strict,
      minTaskCountForSparseCheck
    });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatGraphQualityHuman(report));
    if (!report.ok) {
      process.exitCode = 1;
    }
  });
}
