import { dirname } from "node:path";
import { parseBlockRef } from "../../graph/compileTaskGraph.js";
import { compileTaskGraph } from "../../graph/compileTaskGraph.js";
import { loadPackage } from "../../package/loadPackage.js";
import { resolvePackagePath } from "../../package/resolvePackagePath.js";
import { renderPromptSurfaceFromContext as renderPromptSurfaceWithContext } from "../../taskManager/promptRenderer.js";
import { buildExecutionStatus, type ExecutionStatus } from "../../taskManager/executionStatus.js";
import { buildClaimReadiness, type ClaimReadiness } from "../../taskManager/claimReadiness.js";
import {
  createProjectGraphClaimGuard,
  type ProjectGraphClaimGuard
} from "../../taskManager/projectGraphClaimGuard.js";
import { loadRuntimeReadonly, type RuntimeContext } from "../../taskManager/runtimeContext.js";
import { listExecutorProfilesForManifest } from "../../autoRun/executors.js";
import { resolveAgentDefinition } from "../../autoRun/agentRegistry.js";
import { selectedDesktopAgentTransport } from "../../autoRun/desktopAgentSettings.js";
import { buildPlanGraphViewProjection, loadPlanGraphPackage } from "../../plangraph/index.js";
import type { ClaimResult, PackageWorkspaceRef } from "../../types.js";
import type {
  DesktopBlockDetail,
  DesktopGraphViewModel,
  DesktopTaskDetail,
  DesktopTaskExecutionOrder
} from "../types.js";
import { getDirtyPromptRefs } from "../fileSyncApi.js";
import {
  createTaskWorkspaceReadContext,
  type TaskWorkspaceReadContext
} from "../taskWorkspaceReadContext.js";
import { getBlock, getTask, sortBlockRefsForTask } from "./graphHelpers.js";
import { enrichGraphViewModelSharedResources } from "./sharedResourceViewModel.js";

export type DesktopGraphViewModelContext = RuntimeContext & {
  status: ExecutionStatus;
  executorOptions: string[];
  packageExecutorNames: string[];
  agentTransport: "cli" | "acp";
  claimReadiness: ClaimReadiness;
};

export async function loadDesktopGraphViewModelContext(
  projectRoot: PackageWorkspaceRef
): Promise<DesktopGraphViewModelContext> {
  const runtime = await loadRuntimeReadonly({ projectRoot });
  const claimGuard = await createProjectGraphClaimGuard(runtime);
  return buildDesktopGraphViewModelContext(
    runtime,
    await buildExecutionStatus(runtime, { claimGuard }),
    { claimGuard }
  );
}

export function buildDesktopGraphViewModelContext(
  runtime: RuntimeContext,
  status: ExecutionStatus,
  options: { claimGuard?: ProjectGraphClaimGuard } = {}
): DesktopGraphViewModelContext {
  const executorProfiles = listExecutorProfilesForManifest(runtime.manifest);
  return {
    ...runtime,
    status,
    executorOptions: executorProfiles
      .filter(
        (profile) =>
          profile.source === "package" ||
          profile.profileAdapter !== "agent" ||
          profile.name === profile.agentId ||
          (profile.runnerKind === "acp" &&
            profile.agentId != null &&
            resolveAgentDefinition(profile.agentId).cli === null)
      )
      .map((profile) => profile.name),
    packageExecutorNames: executorProfiles
      .filter((profile) => profile.source === "package")
      .map((profile) => profile.name),
    agentTransport: selectedDesktopAgentTransport(),
    claimReadiness: buildClaimReadiness({
      graph: runtime.graph,
      manifest: runtime.manifest,
      state: runtime.state,
      projectGuard: options.claimGuard
    })
  };
}

function resolveAutoRunExecutorForBlock(
  context: DesktopGraphViewModelContext,
  ref: string
): string {
  const { taskId } = parseBlockRef(ref);
  const task = getTask(context.graph, taskId);
  const block = getBlock(context.graph, ref);
  return block.executor ?? task.executor ?? context.manifest.execution.defaultExecutor ?? "default";
}

function resolveAutoRunExecutorsForRefs(
  context: DesktopGraphViewModelContext,
  refs: string[]
): Record<string, string> {
  return Object.fromEntries(refs.map((ref) => [ref, resolveAutoRunExecutorForBlock(context, ref)]));
}

function resolveAutoRunPreflightExecutorHint(context: DesktopGraphViewModelContext): string | null {
  const claim = resolveAutoRunPreflightClaim(context);
  if (!claim) {
    return null;
  }
  if (claim.kind === "feedback") {
    return context.manifest.execution.defaultExecutor ?? "default";
  }
  const refs = claim.kind === "batch" ? claim.refs : [claim.ref];
  const executorNames = new Set(refs.map((ref) => resolveAutoRunExecutorForBlock(context, ref)));
  if (executorNames.size !== 1) {
    return null;
  }
  return [...executorNames][0] ?? null;
}

function resolveAutoRunPreflightClaim(
  context: DesktopGraphViewModelContext
): Extract<ClaimResult, { kind: "batch" | "block" | "feedback" }> | null {
  const { claimReadiness, manifest } = context;
  if (
    claimReadiness.claimOrder.kind === "feedback" ||
    claimReadiness.claimOrder.kind === "currentBlock" ||
    claimReadiness.claimOrder.kind === "currentReview"
  ) {
    return claimReadiness.claimOrder.result;
  }
  if (claimReadiness.claimOrder.kind === "blocked") {
    return null;
  }
  if (manifest.execution.parallel.enabled) {
    if (claimReadiness.parallelBatchRefs.length > 0) {
      return {
        kind: "batch",
        refs: claimReadiness.parallelBatchRefs,
        effectiveExecutors: resolveAutoRunExecutorsForRefs(
          context,
          claimReadiness.parallelBatchRefs
        )
      };
    }
    if (claimReadiness.sequentialReviewCandidates[0]) {
      return claimReadiness.sequentialReviewCandidates[0].result;
    }
    if (claimReadiness.firstProjectBlockedResult) {
      return null;
    }
    return claimReadiness.sequentialImplementationCandidates[0]?.result ?? null;
  }
  return (
    claimReadiness.sequentialImplementationCandidates[0]?.result ??
    claimReadiness.sequentialReviewCandidates[0]?.result ??
    null
  );
}

export async function buildGraphViewModel(
  context: DesktopGraphViewModelContext
): Promise<DesktopGraphViewModel> {
  const { workspace, status, executorOptions, packageExecutorNames, agentTransport } = context;
  // Prompt bodies and missing/read diagnostics already come from the PlanGraph
  // index built by loadPlanGraphPackage (promptMarkdownByPath + graph.diagnostics).
  // Do not re-read every task/block prompt file on each view-model build.
  const planGraphPackage = await loadPlanGraphPackage(workspace);
  const dirtyPromptRefs = await getDirtyPromptRefs(workspace);
  const taskPromptMarkdownById = new Map<string, string>();
  for (const task of planGraphPackage.graph.tasks.values()) {
    taskPromptMarkdownById.set(
      task.taskId,
      planGraphPackage.promptMarkdownByPath.get(task.promptRef.path) ?? ""
    );
  }
  const projection = buildPlanGraphViewProjection({
    graph: planGraphPackage.graph,
    runtime: context,
    status,
    taskPromptMarkdownById
  });

  return enrichGraphViewModelSharedResources(
    {
      projectId: workspace.id,
      projectTitle: planGraphPackage.graph.project.title,
      graphVersion: planGraphPackage.graph.graphVersion,
      packageFingerprint: planGraphPackage.graph.packageFingerprint,
      executorOptions,
      packageExecutorNames,
      agentTransport,
      autoRunPreflightExecutorHint: resolveAutoRunPreflightExecutorHint(context),
      tasks: projection.tasks,
      edges: projection.edges,
      diagnostics: [...planGraphPackage.graph.diagnostics],
      dirtyPromptRefs
    },
    {
      graph: context.graph,
      state: context.state,
      claimHints: context.claimReadiness.claimHints
    }
  );
}

export async function getGraphViewModel(
  projectRoot: PackageWorkspaceRef
): Promise<DesktopGraphViewModel> {
  return buildGraphViewModel(await loadDesktopGraphViewModelContext(projectRoot));
}

async function promptBodyFromContext(context: TaskWorkspaceReadContext, packagePath: string) {
  const markdown = context.planGraphPackage.promptMarkdownByPath.get(packagePath);
  if (markdown !== undefined) {
    return { markdown, missing: false };
  }
  return context.promptSourceReader.readPackagePrompt(packagePath, { allowMissing: true });
}

function planGraphTaskForContext(context: TaskWorkspaceReadContext, taskId: string) {
  const task = context.planGraphPackage.graph.tasks.get(taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' is missing from the request PlanGraph.`);
  }
  return task;
}

function planGraphBlockForContext(context: TaskWorkspaceReadContext, ref: string) {
  const block = context.planGraphPackage.graph.blocks.get(ref);
  if (!block) {
    throw new Error(`Block '${ref}' is missing from the request PlanGraph.`);
  }
  return block;
}

export async function buildTaskDetail(
  context: TaskWorkspaceReadContext,
  taskId: string
): Promise<DesktopTaskDetail> {
  const { graph } = context.runtime;
  const task = getTask(graph, taskId);
  const planGraphTask = planGraphTaskForContext(context, taskId);
  const prompt = await promptBodyFromContext(context, task.prompt);
  return {
    taskId,
    graphVersion: context.planGraphPackage.graph.graphVersion,
    title: task.title,
    status: context.status.tasks.find((item) => item.taskId === taskId)?.status ?? "planned",
    executor: task.executor ?? null,
    promptMarkdown: prompt.markdown,
    promptHash: planGraphTask.promptRef.contentHash,
    promptMissing: prompt.missing,
    acceptance: task.acceptance,
    blockOrder: sortBlockRefsForTask(graph, taskId)
  };
}

export async function getTaskDetail(
  projectRoot: PackageWorkspaceRef,
  taskId: string
): Promise<DesktopTaskDetail> {
  return buildTaskDetail(await createTaskWorkspaceReadContext({ projectRoot }), taskId);
}

export async function getTaskFileManagerPath(
  projectRoot: PackageWorkspaceRef,
  taskId: string
): Promise<string> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const task = getTask(compileTaskGraph(manifest), taskId);
  const promptPath = await resolvePackagePath(workspace.packageDir, task.prompt);
  const canonicalTaskPrompt = `nodes/${taskId}/prompt.md`;
  return task.prompt.replaceAll("\\", "/") === canonicalTaskPrompt
    ? dirname(promptPath)
    : promptPath;
}

export async function getTaskExecutionOrder(
  projectRoot: PackageWorkspaceRef,
  taskId: string
): Promise<DesktopTaskExecutionOrder> {
  const { manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  getTask(graph, taskId);
  return {
    taskId,
    blockRefs: sortBlockRefsForTask(graph, taskId)
  };
}

export function renderPromptSurfaceFromContext(context: TaskWorkspaceReadContext, ref: string) {
  return renderPromptSurfaceWithContext(context, ref, { allowMissingPromptSources: true });
}

export async function buildBlockDetail(
  context: TaskWorkspaceReadContext,
  ref: string
): Promise<DesktopBlockDetail> {
  const { graph, manifest } = context.runtime;
  const { taskId, blockId } = parseBlockRef(ref);
  const task = getTask(graph, taskId);
  const block = getBlock(graph, ref);
  const planGraphBlock = planGraphBlockForContext(context, ref);
  const blockStatus = context.status.blocks.find((item) => item.ref === ref);
  const claimHint = context.status.claimHints.find((item) => item.ref === ref);
  const prompt = await promptBodyFromContext(context, block.prompt);
  const promptSurface = await renderPromptSurfaceFromContext(context, ref);
  return {
    ref,
    graphVersion: context.planGraphPackage.graph.graphVersion,
    taskId,
    blockId,
    type: block.type,
    title: block.title,
    status: blockStatus?.status ?? "planned",
    executor: block.executor ?? null,
    effectiveExecutor:
      block.executor ?? task.executor ?? manifest.execution.defaultExecutor ?? null,
    promptMarkdown: prompt.markdown,
    promptHash: planGraphBlock.promptRef.contentHash,
    promptMissing: prompt.missing,
    promptSurfaceMarkdown: promptSurface.markdown,
    promptSources: promptSurface.sources,
    dependencies: graph.blockDependenciesByRef.get(ref) ?? [],
    latestRunId: blockStatus?.lastRunId ?? null,
    latestReviewAttemptId: blockStatus?.latestReviewAttemptId ?? null,
    activeFeedbackId: blockStatus?.activeFeedbackId ?? null,
    exceptionReason: blockStatus?.reason ?? null,
    reviewGate: claimHint?.reviewGate ?? null
  };
}

export async function buildBlockDetailsForTask(
  context: TaskWorkspaceReadContext,
  taskId: string
): Promise<DesktopBlockDetail[]> {
  getTask(context.runtime.graph, taskId);
  return Promise.all(
    sortBlockRefsForTask(context.runtime.graph, taskId).map((ref) => buildBlockDetail(context, ref))
  );
}

export async function getBlockDetail(
  projectRoot: PackageWorkspaceRef,
  ref: string
): Promise<DesktopBlockDetail> {
  return buildBlockDetail(await createTaskWorkspaceReadContext({ projectRoot }), ref);
}
