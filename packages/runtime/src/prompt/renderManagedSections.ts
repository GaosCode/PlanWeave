import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompiledTaskGraph, ManifestNode, ManifestTaskNode, PlanPackageManifest, ProjectWorkspace, RuntimeState } from "../types.js";
import { readResultIndex } from "../results/indexFile.js";

export type ManagedSectionContext = {
  workspace: ProjectWorkspace;
  manifest: PlanPackageManifest;
  graph: CompiledTaskGraph;
  state: RuntimeState;
  task: ManifestTaskNode;
  globalPrompt: string;
};

async function readReviewIfNeeded(context: ManagedSectionContext): Promise<string | null> {
  const index = await readResultIndex(join(context.workspace.resultsDir, context.task.id, "index.json"));
  if (index?.review?.status !== "needs_changes") {
    return null;
  }
  const reviewPath = join(context.workspace.resultsDir, context.task.id, "review.md");
  try {
    return await readFile(reviewPath, "utf8");
  } catch {
    return null;
  }
}

function describeNode(node: ManifestNode): string {
  return node.type === "task" ? node.title : node.summary;
}

function renderNodeGroup(title: string, nodes: ManifestNode[]): string[] {
  if (nodes.length === 0) {
    return [];
  }
  return [`### ${title}`, nodes.map((node) => `- ${node.id} (${node.type}) - ${describeNode(node)}`).join("\n")];
}

function renderGraphContext(context: ManagedSectionContext): string {
  const related = context.graph.relatedContext(context.task.id);
  const sections = [
    ...renderNodeGroup("Related Goals", related.goals),
    ...renderNodeGroup("Related Requirements", related.requirements),
    ...renderNodeGroup("Related Constraints", related.constraints),
    ...renderNodeGroup("Related Decisions", related.decisions),
    ...renderNodeGroup("Touched Components", related.components),
    ...renderNodeGroup("Conflict Warnings", related.conflicts),
    ...renderNodeGroup("Supersedes", related.supersedes),
    ...renderNodeGroup("Superseded By", related.supersededBy)
  ];

  return ["## Graph Context", sections.length > 0 ? sections.join("\n\n") : "- No related context nodes."].join("\n\n");
}

function renderDependencyStatus(context: ManagedSectionContext): string {
  const dependencies = context.graph.dependenciesByTask.get(context.task.id) ?? [];
  if (dependencies.length === 0) {
    return "## Dependency Status\n\n- No dependencies.";
  }
  const lines = dependencies.map((id) => `- ${id}: ${context.state.tasks[id]?.status ?? "unknown"}`);
  return `## Dependency Status\n\n${lines.join("\n")}`;
}

async function renderLatestRun(context: ManagedSectionContext): Promise<string> {
  const index = await readResultIndex(join(context.workspace.resultsDir, context.task.id, "index.json"));
  if (!index?.latestRunId) {
    return "## Latest Run\n\n- No implementation run recorded.";
  }
  return `## Latest Run\n\n- Run: ${index.latestRunId}\n- Status: ${index.status}\n- Run count: ${index.runCount}`;
}

export async function renderManagedSections(context: ManagedSectionContext): Promise<Record<string, string>> {
  const taskState = context.state.tasks[context.task.id];
  const review = await readReviewIfNeeded(context);
  const runtimeFeedback = review
    ? `## Runtime Feedback\n\nCurrent review requires changes:\n\n${review.trim()}`
    : "## Runtime Feedback\n\n- No review feedback.";

  return {
    header: [`> Status: ${taskState?.status ?? "planned"}`, `> Task ID: ${context.task.id}`].join("\n"),
    global: `## Global Prompt\n\n${context.globalPrompt.trim() || "- No global prompt."}`,
    "runtime-feedback": runtimeFeedback,
    acceptance: `## Acceptance\n\n${context.task.acceptance.map((item) => `- ${item}`).join("\n")}`,
    "graph-context": renderGraphContext(context),
    "dependency-status": renderDependencyStatus(context),
    "latest-run": await renderLatestRun(context),
    completion: [
      "## Completion",
      "",
      `- Submit implementation with \`planweave submit-result ${context.task.id} --report <implementation.md>\`.`,
      `- If implementation diverges from the plan, submit with \`planweave submit-result ${context.task.id} --report <implementation.md> --status diverged --reason \"<reason>\"\`.`,
      `- If the task is blocked, use \`planweave mark-blocked ${context.task.id} --reason \"<reason>\"\`.`
    ].join("\n")
  };
}
