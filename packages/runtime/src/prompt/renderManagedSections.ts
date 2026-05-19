import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dependencyIds } from "../state.js";
import type { ManifestTaskNode, PlanPackageManifest, ProjectWorkspace, RuntimeState } from "../types.js";
import { readResultIndex } from "../results/indexFile.js";

export type ManagedSectionContext = {
  workspace: ProjectWorkspace;
  manifest: PlanPackageManifest;
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

function renderGraphContext(context: ManagedSectionContext): string {
  const related = context.manifest.edges
    .filter((edge) => edge.from === context.task.id || edge.to === context.task.id)
    .filter((edge) => edge.type !== "depends_on")
    .map((edge) => {
      const otherId = edge.from === context.task.id ? edge.to : edge.from;
      const other = context.manifest.nodes.find((node) => node.id === otherId);
      if (!other) {
        return null;
      }
      const description = other.type === "task" ? other.title : other.summary;
      return `- ${edge.type}: ${other.id} (${other.type}) - ${description}`;
    })
    .filter((line): line is string => line !== null);

  return ["## Graph Context", related.length > 0 ? related.join("\n") : "- No related context nodes."].join("\n\n");
}

function renderDependencyStatus(context: ManagedSectionContext): string {
  const dependencies = dependencyIds(context.manifest, context.task.id);
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
    completion: "## Completion\n\n- Submit implementation with `planweave submit-result`.\n- Submit review with `planweave submit-review`."
  };
}
