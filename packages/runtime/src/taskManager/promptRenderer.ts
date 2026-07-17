import { join } from "node:path";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import {
  loadPlanGraphPackage,
  type LoadedPlanGraphPackage
} from "../plangraph/packageRepository.js";
import { buildAgentClaimMarkdown } from "../plangraph/projections/agentContextProjection.js";
import type { ExecutionGraphSession, PackageWorkspaceRef } from "../types.js";
import { canvasCommandFlagForWorkspace } from "./canvasCommandScope.js";
import { buildExecutionStatus, type ExecutionStatus } from "./executionStatus.js";
import { renderProjectCanvasContext, type ProjectCanvasContext } from "./projectCanvasContext.js";
import { createPromptSourceReader, type PromptSourceReader } from "./promptSourceReader.js";
import { loadRuntimeReadonly, type RuntimeContext } from "./runtimeContext.js";
import { getBlock, getTask, requiredImplementationRefs } from "./selectors.js";
import { REVIEW_RESULT_CONTENT_GUIDANCE } from "./reviewResultContract.js";
import {
  type PromptSourceKind,
  type PromptSourceSummary,
  type PromptSurface
} from "./promptContracts.js";

export {
  promptSourceKinds,
  promptSourceSummarySchema
} from "./promptContracts.js";
export type { PromptSourceKind, PromptSourceSummary, PromptSurface } from "./promptContracts.js";

interface PromptRenderContext {
  runtime: RuntimeContext;
  status: ExecutionStatus;
  planGraphPackage: LoadedPlanGraphPackage;
  promptSourceReader: PromptSourceReader;
  projectCanvasContextReader: (taskId: string) => Promise<ProjectCanvasContext>;
  canvasCommandFlagReader: () => Promise<string>;
}

function createProjectCanvasContextReader(runtime: RuntimeContext) {
  const contexts = new Map<string, Promise<ProjectCanvasContext>>();
  return (taskId: string) => {
    const existing = contexts.get(taskId);
    if (existing) {
      return existing;
    }
    const pending = renderProjectCanvasContext(runtime, taskId);
    contexts.set(taskId, pending);
    return pending;
  };
}

function createCanvasCommandFlagReader(workspace: RuntimeContext["workspace"]) {
  let commandFlag: Promise<string> | undefined;
  return () => {
    commandFlag ??= canvasCommandFlagForWorkspace(workspace);
    return commandFlag;
  };
}

function renderNodeList(title: string, lines: string[]): string {
  return [
    `## ${title}`,
    "",
    lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : "- None."
  ].join("\n");
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

async function renderLatestImplementationReports(
  context: RuntimeContext,
  taskId: string,
  promptSourceReader: PromptSourceReader
): Promise<string[]> {
  const lines: string[] = [];
  for (const ref of requiredImplementationRefs(context.graph, taskId)) {
    const lastRunId = context.state.blocks[ref]?.lastRunId;
    if (!lastRunId) {
      continue;
    }
    const { blockId } = parseBlockRef(ref);
    const reportPath = join(
      context.workspace.resultsDir,
      taskId,
      "blocks",
      blockId,
      "runs",
      lastRunId,
      "report.md"
    );
    lines.push(
      `${ref} ${lastRunId}: ${await promptSourceReader.readLatestReportSnippet(reportPath)}`
    );
  }
  return lines;
}

async function renderFocusedReviewLines(
  context: RuntimeContext,
  reviewBlockRef: string,
  promptSourceReader: PromptSourceReader
): Promise<string[]> {
  const feedbackEntry = Object.entries(context.state.feedback)
    .filter(
      ([, feedback]) =>
        feedback.sourceReviewBlockRef === reviewBlockRef && feedback.status === "resolved"
    )
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
    `Feedback handling report (${feedback.latestSubmissionId}): ${await promptSourceReader.readLatestReportSnippet(submissionPath)}`,
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
  const runtime = await loadRuntimeReadonly(options);
  const context: PromptRenderContext = {
    runtime,
    status: await buildExecutionStatus(runtime),
    planGraphPackage: await loadPlanGraphPackage(runtime.workspace),
    promptSourceReader: createPromptSourceReader(runtime.workspace),
    projectCanvasContextReader: createProjectCanvasContextReader(runtime),
    canvasCommandFlagReader: createCanvasCommandFlagReader(runtime.workspace)
  };
  return renderPromptSurfaceFromContext(context, options.ref, {
    includeSubmissionInstructions: options.includeSubmissionInstructions,
    allowMissingPromptSources: options.allowMissingPromptSources
  });
}

function readPackagePromptFromContext(
  context: PromptRenderContext,
  packagePath: string,
  allowMissing: boolean
) {
  const markdown = context.planGraphPackage.promptMarkdownByPath.get(packagePath);
  if (markdown !== undefined) {
    return { markdown, missing: false };
  }
  return context.promptSourceReader.readPackagePrompt(packagePath, { allowMissing });
}

export async function renderPromptSurfaceFromContext(
  context: PromptRenderContext,
  ref: string,
  options: {
    includeSubmissionInstructions?: boolean;
    allowMissingPromptSources?: boolean;
  } = {}
): Promise<PromptSurface> {
  const {
    runtime,
    status,
    planGraphPackage,
    promptSourceReader,
    projectCanvasContextReader,
    canvasCommandFlagReader
  } = context;
  const { workspace, graph, manifest, state } = runtime;
  const { taskId } = parseBlockRef(ref);
  const task = getTask(graph, taskId);
  const block = getBlock(graph, ref);
  const promptPolicy = await promptSourceReader.readProjectPromptPolicy();
  const allowMissingPromptSources = options.allowMissingPromptSources ?? false;
  const globalPrompt = promptPolicy.includeGlobalPrompt
    ? await promptSourceReader.readGlobalPrompt()
    : { markdown: "", missing: false };
  const projectPrompt = await promptSourceReader.readProjectPrompt();
  const taskPrompt = await readPackagePromptFromContext(
    context,
    task.prompt,
    allowMissingPromptSources
  );
  const blockPrompt = await readPackagePromptFromContext(
    context,
    block.prompt,
    allowMissingPromptSources
  );
  const projectCanvasContext = await projectCanvasContextReader(taskId);
  const planGraphContext = buildAgentClaimMarkdown({
    graph: planGraphPackage.graph,
    ref,
    status
  });
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
  const dependencyLines = (graph.blockDependenciesByRef.get(ref) ?? []).map(
    (dependency) => `${dependency}: ${state.blocks[dependency]?.status ?? "planned"}`
  );
  const sharedResourceLines = (graph.sharedResourcesByBlockRef.get(ref) ?? []).map(
    (resource) =>
      `${resource} (coordination hint only; it does not reserve the resource or block parallel work)`
  );
  const latestImplementationReports = await renderLatestImplementationReports(
    runtime,
    taskId,
    promptSourceReader
  );
  const focusedReviewLines =
    block.type === "review" ? await renderFocusedReviewLines(runtime, ref, promptSourceReader) : [];
  const reviewSchema =
    block.type === "review"
      ? [
          "## Required Review Result JSON",
          "",
          "```json",
          JSON.stringify(
            {
              reviewBlockRef: ref,
              taskId,
              verdict: "passed | needs_changes",
              content: "review summary and requested changes"
            },
            null,
            2
          ),
          "```",
          "",
          REVIEW_RESULT_CONTENT_GUIDANCE
        ].join("\n")
      : "";
  const implementationReportGuidance =
    block.type === "implementation"
      ? [
          "## Suggested Implementation Report Format",
          "",
          "- Summary: what changed and why.",
          "- Changed files: notable files touched and the purpose of each change.",
          "- Verification: commands, checks, or manual validation performed, including the result.",
          "- Notes / risks: unverified items, limitations, or follow-up work."
        ].join("\n")
      : "";
  const includeSubmissionInstructions = options.includeSubmissionInstructions ?? true;
  const canvasFlag = await canvasCommandFlagReader();
  const submitInstruction =
    block.type === "review"
      ? `Submit review with \`planweave submit-review${canvasFlag} ${ref} --result review-result.json\`.`
      : `Submit result with \`planweave submit-result${canvasFlag} ${ref} --report implementation.md\`.`;
  const sections = [
    `# ${task.id}#${block.id}: ${block.title}`,
    promptPolicy.includeGlobalPrompt ? "## PlanWeave Global Prompt" : "",
    promptPolicy.includeGlobalPrompt ? globalPrompt.markdown.trim() || "- No global prompt." : "",
    "## Project/Canvas Prompt",
    projectPrompt.markdown.trim() || "- No project/canvas prompt.",
    "## Project Canvas Context",
    projectCanvasContext.markdown.trim(),
    "## PlanGraph Claim Context",
    planGraphContext.trim(),
    "## Task Node Prompt",
    taskPrompt.markdown.trim(),
    "## Block Prompt",
    blockPrompt.markdown.trim(),
    renderNodeList("Task Acceptance", task.acceptance),
    renderNodeList("Execution Context", [
      `Task status: ${state.tasks[taskId]?.status ?? "planned"}`,
      `Block status: ${state.blocks[ref]?.status ?? "planned"}`,
      `Completion policy: ${manifest.review.completionPolicy}`
    ]),
    renderNodeList("Dependency / Block Status", dependencyLines),
    renderNodeList("Shared Resource Hints", sharedResourceLines),
    renderNodeList("Latest Implementation / Feedback Summary", latestImplementationReports),
    focusedReviewLines.length > 0
      ? renderNodeList("Focused Re-review Context", focusedReviewLines)
      : "",
    reviewSchema,
    implementationReportGuidance,
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

export { createCanvasCommandFlagReader, createProjectCanvasContextReader };
export type { PromptRenderContext };
