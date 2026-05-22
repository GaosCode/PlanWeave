import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { resolvePackagePath } from "../package/resolvePackagePath.js";
import { resolvePlanweaveHome } from "../paths.js";
import type { ExecutionGraphSession, PackageWorkspaceRef } from "../types.js";
import { loadRuntime, readOptionalFile, type RuntimeContext } from "./runtimeContext.js";
import { getBlock, getTask, requiredImplementationRefs } from "./selectors.js";

function renderNodeList(title: string, lines: string[]): string {
  return [`## ${title}`, "", lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : "- None."].join("\n");
}

async function latestReportSnippet(path: string): Promise<string> {
  try {
    const content = await readFile(path, "utf8");
    return content.trim().slice(0, 400) || "(empty)";
  } catch {
    return "(unavailable)";
  }
}

async function renderLatestImplementationReports(context: RuntimeContext, taskId: string): Promise<string[]> {
  const lines: string[] = [];
  for (const ref of requiredImplementationRefs(context.graph, taskId)) {
    const lastRunId = context.state.blocks[ref]?.lastRunId;
    if (!lastRunId) {
      continue;
    }
    const { blockId } = parseBlockRef(ref);
    const reportPath = join(context.workspace.resultsDir, taskId, "blocks", blockId, "runs", lastRunId, "report.md");
    lines.push(`${ref} ${lastRunId}: ${await latestReportSnippet(reportPath)}`);
  }
  return lines;
}

async function renderFocusedReviewLines(context: RuntimeContext, reviewBlockRef: string): Promise<string[]> {
  const feedbackEntry = Object.entries(context.state.feedback)
    .filter(([, feedback]) => feedback.sourceReviewBlockRef === reviewBlockRef && feedback.status === "resolved")
    .at(-1);
  if (!feedbackEntry) {
    return [];
  }
  const [feedbackId, feedback] = feedbackEntry;
  const taskId = context.graph.blockTaskByRef.get(reviewBlockRef);
  if (!taskId || !feedback.latestSubmissionId) {
    return [];
  }
  const submissionPath = join(
    context.workspace.resultsDir,
    taskId,
    "feedback",
    feedbackId,
    "submissions",
    feedback.latestSubmissionId,
    "report.md"
  );
  return [
    `Previous review feedback: ${feedback.content}`,
    `Feedback handling report (${feedback.latestSubmissionId}): ${await latestReportSnippet(submissionPath)}`,
    "Focus: verify that the previous feedback items were resolved without regressing accepted work."
  ];
}

export async function renderPrompt(options: { projectRoot: PackageWorkspaceRef; ref: string; session?: ExecutionGraphSession }): Promise<string> {
  const context = await loadRuntime(options);
  const { workspace, graph, manifest, state } = context;
  const { taskId } = parseBlockRef(options.ref);
  const task = getTask(graph, taskId);
  const block = getBlock(graph, options.ref);
  const globalPrompt = await readOptionalFile(join(resolvePlanweaveHome(), "config", "global-prompt.md"));
  const projectPrompt = await readOptionalFile(workspace.projectPromptFile);
  const taskPrompt = await readFile(await resolvePackagePath(workspace.packageDir, task.prompt, { requireExisting: true }), "utf8");
  const blockPrompt = await readFile(await resolvePackagePath(workspace.packageDir, block.prompt, { requireExisting: true }), "utf8");
  const dependencyLines = (graph.blockDependenciesByRef.get(options.ref) ?? []).map((dependency) => `${dependency}: ${state.blocks[dependency]?.status ?? "planned"}`);
  const latestImplementationReports = await renderLatestImplementationReports(context, taskId);
  const focusedReviewLines = block.type === "review" ? await renderFocusedReviewLines(context, options.ref) : [];
  const reviewSchema =
    block.type === "review"
      ? [
          "## Required Review Result JSON",
          "",
          "```json",
          JSON.stringify(
            {
              reviewBlockRef: options.ref,
              taskId,
              verdict: "passed | needs_changes",
              content: "review summary and requested changes"
            },
            null,
            2
          ),
          "```"
        ].join("\n")
      : "";
  const submitInstruction =
    block.type === "review"
      ? `Submit review with \`planweave submit-review ${options.ref} --result review-result.json\`.`
      : `Submit result with \`planweave submit-result ${options.ref} --report implementation.md\`.`;
  const related = graph.relatedContext(taskId);
  return [
    `# ${task.id}#${block.id}: ${block.title}`,
    "## PlanWeave Global Prompt",
    globalPrompt.trim() || "- No global prompt.",
    "## Project Prompt",
    projectPrompt.trim() || "- No project prompt.",
    "## Task Node Prompt",
    taskPrompt.trim(),
    "## Block Prompt",
    blockPrompt.trim(),
    renderNodeList("Task Acceptance", task.acceptance),
    renderNodeList(
      "Execution Context",
      [
        `Task status: ${state.tasks[taskId]?.status ?? "planned"}`,
        `Block status: ${state.blocks[options.ref]?.status ?? "planned"}`,
        `Completion policy: ${manifest.review.completionPolicy}`
      ]
    ),
    renderNodeList("Dependency / Block Status", dependencyLines),
    renderNodeList(
      "Graph Context",
      [
        ...related.goals.map((node) => `${node.id} goal: ${node.title}`),
        ...related.requirements.map((node) => `${node.id} requirement: ${node.title}`),
        ...related.constraints.map((node) => `${node.id} constraint: ${node.title}`),
        ...related.components.map((node) => `${node.id} component: ${node.title}`)
      ]
    ),
    renderNodeList("Latest Implementation / Feedback Summary", latestImplementationReports),
    focusedReviewLines.length > 0 ? renderNodeList("Focused Re-review Context", focusedReviewLines) : "",
    reviewSchema,
    "## Submission Instructions",
    submitInstruction
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n")
    .concat("\n");
}
