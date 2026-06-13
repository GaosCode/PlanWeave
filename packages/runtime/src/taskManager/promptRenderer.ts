import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { resolvePackagePath } from "../package/resolvePackagePath.js";
import { resolvePlanweaveHome } from "../paths.js";
import { readProjectPromptPolicy } from "../projectPromptPolicy.js";
import type { ExecutionGraphSession, PackageWorkspaceRef } from "../types.js";
import { renderProjectCanvasContext } from "./projectCanvasContext.js";
import { loadRuntime, type RuntimeContext } from "./runtimeContext.js";
import { getBlock, getTask, requiredImplementationRefs } from "./selectors.js";

export type PromptSourceKind = "global" | "projectCanvas" | "projectGraph" | "taskNode" | "block";

export type PromptSourceSummary = {
  kind: PromptSourceKind;
  label: string;
  included: boolean;
  empty: boolean;
  missing: boolean;
  disabledReason: string | null;
  preview: string;
};

export type PromptSurface = {
  markdown: string;
  sources: PromptSourceSummary[];
};

function renderNodeList(title: string, lines: string[]): string {
  return [`## ${title}`, "", lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : "- None."].join("\n");
}

function fileErrorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null;
}

async function readPromptFile(path: string, options: { allowMissing: boolean }): Promise<{ markdown: string; missing: boolean }> {
  try {
    return {
      markdown: await readFile(path, "utf8"),
      missing: false
    };
  } catch (error) {
    if (options.allowMissing && fileErrorCode(error) === "ENOENT") {
      return {
        markdown: "",
        missing: true
      };
    }
    throw error;
  }
}

function promptSourcePreview(markdown: string): string {
  return markdown.replace(/\s+/g, " ").trim().slice(0, 220);
}

function promptSourceSummary(input: {
  kind: PromptSourceKind;
  label: string;
  markdown: string;
  included: boolean;
  missing: boolean;
  disabledReason?: string | null;
}): PromptSourceSummary {
  return {
    kind: input.kind,
    label: input.label,
    included: input.included,
    empty: input.markdown.trim().length === 0,
    missing: input.missing,
    disabledReason: input.disabledReason ?? null,
    preview: promptSourcePreview(input.markdown)
  };
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

export async function renderPrompt(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  session?: ExecutionGraphSession;
  includeSubmissionInstructions?: boolean;
}): Promise<string> {
  return (await renderPromptSurface(options)).markdown;
}

export async function renderPromptSurface(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  session?: ExecutionGraphSession;
  includeSubmissionInstructions?: boolean;
  allowMissingPromptSources?: boolean;
}): Promise<PromptSurface> {
  const context = await loadRuntime(options);
  const { workspace, graph, manifest, state } = context;
  const { taskId } = parseBlockRef(options.ref);
  const task = getTask(graph, taskId);
  const block = getBlock(graph, options.ref);
  const promptPolicy = await readProjectPromptPolicy(workspace);
  const allowMissingPromptSources = options.allowMissingPromptSources ?? false;
  const globalPrompt = promptPolicy.includeGlobalPrompt
    ? await readPromptFile(join(resolvePlanweaveHome(), "config", "global-prompt.md"), { allowMissing: true })
    : { markdown: "", missing: false };
  const projectPrompt = await readPromptFile(workspace.projectPromptFile, { allowMissing: true });
  const taskPrompt = await readPromptFile(await resolvePackagePath(workspace.packageDir, task.prompt, { requireExisting: !allowMissingPromptSources }), {
    allowMissing: allowMissingPromptSources
  });
  const blockPrompt = await readPromptFile(await resolvePackagePath(workspace.packageDir, block.prompt, { requireExisting: !allowMissingPromptSources }), {
    allowMissing: allowMissingPromptSources
  });
  const projectCanvasContext = await renderProjectCanvasContext(context, taskId);
  const promptSources = [
    promptSourceSummary({
      kind: "global",
      label: "PlanWeave Global Prompt",
      markdown: globalPrompt.markdown,
      included: promptPolicy.includeGlobalPrompt,
      missing: globalPrompt.missing,
      disabledReason: promptPolicy.includeGlobalPrompt ? null : "Disabled for this project."
    }),
    promptSourceSummary({
      kind: "projectCanvas",
      label: "Project/Canvas Prompt",
      markdown: projectPrompt.markdown,
      included: true,
      missing: projectPrompt.missing
    }),
    promptSourceSummary({
      kind: "projectGraph",
      label: "Project Canvas Context",
      markdown: projectCanvasContext.markdown,
      included: true,
      missing: projectCanvasContext.missing,
      disabledReason: projectCanvasContext.disabledReason
    }),
    promptSourceSummary({
      kind: "taskNode",
      label: "Task Node Prompt",
      markdown: taskPrompt.markdown,
      included: true,
      missing: taskPrompt.missing
    }),
    promptSourceSummary({
      kind: "block",
      label: "Block Prompt",
      markdown: blockPrompt.markdown,
      included: true,
      missing: blockPrompt.missing
    })
  ];
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
  const includeSubmissionInstructions = options.includeSubmissionInstructions ?? true;
  const submitInstruction =
    block.type === "review"
      ? `Submit review with \`planweave submit-review ${options.ref} --result review-result.json\`.`
      : `Submit result with \`planweave submit-result ${options.ref} --report implementation.md\`.`;
  const sections = [
    `# ${task.id}#${block.id}: ${block.title}`,
    promptPolicy.includeGlobalPrompt ? "## PlanWeave Global Prompt" : "",
    promptPolicy.includeGlobalPrompt ? globalPrompt.markdown.trim() || "- No global prompt." : "",
    "## Project/Canvas Prompt",
    projectPrompt.markdown.trim() || "- No project/canvas prompt.",
    "## Project Canvas Context",
    projectCanvasContext.markdown.trim(),
    "## Task Node Prompt",
    taskPrompt.markdown.trim(),
    "## Block Prompt",
    blockPrompt.markdown.trim(),
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
    renderNodeList("Latest Implementation / Feedback Summary", latestImplementationReports),
    focusedReviewLines.length > 0 ? renderNodeList("Focused Re-review Context", focusedReviewLines) : "",
    reviewSchema,
    includeSubmissionInstructions ? "## Submission Instructions" : "",
    includeSubmissionInstructions ? submitInstruction : ""
  ];
  return {
    markdown: sections
      .filter((section) => section.trim().length > 0)
      .join("\n\n")
      .concat("\n"),
    sources: promptSources
  };
}
