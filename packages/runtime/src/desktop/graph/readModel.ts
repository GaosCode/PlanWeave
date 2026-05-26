import { parseBlockRef } from "../../graph/compileTaskGraph.js";
import { compilePackageGraph, compileTaskGraph } from "../../graph/compileTaskGraph.js";
import { loadPackage } from "../../package/loadPackage.js";
import { resolvePackagePath } from "../../package/resolvePackagePath.js";
import { readState } from "../../state.js";
import { getExecutionStatus } from "../../taskManager/index.js";
import { listExecutorProfiles } from "../../autoRun/executors.js";
import type { PackageWorkspaceRef, ValidationIssue } from "../../types.js";
import type { DesktopBlockDetail, DesktopBlockPreview, DesktopGraphViewModel, DesktopTaskDetail, DesktopTaskException, DesktopTaskExecutionOrder } from "../types.js";
import { exceptionForBlock, executorLabel, getBlock, getTask, promptPreview, readOptionalFile, sortBlockRefsForTask } from "./graphHelpers.js";

function appendDiagnostic(diagnostics: ValidationIssue[], diagnostic: ValidationIssue | null): void {
  if (!diagnostic) {
    return;
  }
  if (diagnostics.some((item) => item.code === diagnostic.code && item.path === diagnostic.path && item.message === diagnostic.message)) {
    return;
  }
  diagnostics.push(diagnostic);
}

export async function getGraphViewModel(projectRoot: PackageWorkspaceRef): Promise<DesktopGraphViewModel> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const graph = await compilePackageGraph(manifest, workspace.packageDir);
  const state = await readState(workspace.stateFile);
  const status = await getExecutionStatus({ projectRoot });
  const statusByBlock = new Map(status.blocks.map((block) => [block.ref, block]));
  const dirtyPromptRefs = new Set<string>();
  const executorOptions = (await listExecutorProfiles({ projectRoot })).map((profile) => profile.name);
  const diagnostics = [...graph.diagnostics.errors];

  const tasks = await Promise.all(
    graph.taskNodesInManifestOrder.map(async (taskId) => {
      const task = getTask(graph, taskId);
      const taskStatus = status.tasks.find((item) => item.taskId === taskId)?.status ?? "planned";
      const taskPrompt = await readOptionalFile(await resolvePackagePath(workspace.packageDir, task.prompt), task.prompt);
      appendDiagnostic(diagnostics, taskPrompt.diagnostic);
      const orderedRefs = sortBlockRefsForTask(graph, taskId);
      const blocks: DesktopBlockPreview[] = await Promise.all(orderedRefs.map(async (ref) => {
        const block = getBlock(graph, ref);
        const blockStatus = statusByBlock.get(ref);
        const blockPrompt = await readOptionalFile(await resolvePackagePath(workspace.packageDir, block.prompt), block.prompt);
        appendDiagnostic(diagnostics, blockPrompt.diagnostic);
        return {
          ref,
          blockId: parseBlockRef(ref).blockId,
          type: block.type,
          title: block.title,
          status: blockStatus?.status ?? "planned",
          executor: block.executor ?? task.executor ?? manifest.execution.defaultExecutor ?? null,
          promptMissing: blockPrompt.missing,
          exceptionReason: blockStatus?.reason ?? null
        };
      }));
      const blockPreview = blocks.slice(0, 4);
      const exceptions = orderedRefs
        .map((ref) => {
          const blockStatus = statusByBlock.get(ref);
          if (!blockStatus) {
            return null;
          }
          return exceptionForBlock(ref, blockStatus.status, blockStatus.reason);
        })
        .filter((item): item is DesktopTaskException => item !== null);
      if ((state.tasks[taskId]?.openFeedbackCount ?? 0) > 0) {
        exceptions.push({
          ref: taskId,
          source: "feedback",
          reason: `${state.tasks[taskId].openFeedbackCount} unresolved feedback item(s).`
        });
      }
      return {
        taskId,
        title: task.title,
        status: taskStatus,
        executor: task.executor ?? null,
        executorLabel: executorLabel(task),
        promptMarkdown: taskPrompt.markdown,
        promptMissing: taskPrompt.missing,
        promptPreview: promptPreview(taskPrompt.markdown),
        blocks,
        blockPreview,
        hiddenBlockRefs: orderedRefs.slice(blockPreview.length),
        overflowBlockCount: Math.max(0, orderedRefs.length - blockPreview.length),
        exceptions
      };
    })
  );

  return {
    projectId: workspace.id,
    projectTitle: manifest.project.title,
    executorOptions,
    tasks,
    edges: manifest.edges.map((edge) => ({ from: edge.from, to: edge.to, type: edge.type })),
    diagnostics,
    dirtyPromptRefs: [...dirtyPromptRefs]
  };
}

export async function getTaskDetail(projectRoot: PackageWorkspaceRef, taskId: string): Promise<DesktopTaskDetail> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  const task = getTask(graph, taskId);
  const status = await getExecutionStatus({ projectRoot });
  const prompt = await readOptionalFile(await resolvePackagePath(workspace.packageDir, task.prompt), task.prompt);
  return {
    taskId,
    title: task.title,
    status: status.tasks.find((item) => item.taskId === taskId)?.status ?? "planned",
    executor: task.executor ?? null,
    promptMarkdown: prompt.markdown,
    promptMissing: prompt.missing,
    acceptance: task.acceptance,
    blockOrder: sortBlockRefsForTask(graph, taskId)
  };
}

export async function getTaskExecutionOrder(projectRoot: PackageWorkspaceRef, taskId: string): Promise<DesktopTaskExecutionOrder> {
  const { manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  getTask(graph, taskId);
  return {
    taskId,
    blockRefs: sortBlockRefsForTask(graph, taskId)
  };
}

export async function getBlockDetail(projectRoot: PackageWorkspaceRef, ref: string): Promise<DesktopBlockDetail> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  const { taskId, blockId } = parseBlockRef(ref);
  const task = getTask(graph, taskId);
  const block = getBlock(graph, ref);
  const status = await getExecutionStatus({ projectRoot });
  const blockStatus = status.blocks.find((item) => item.ref === ref);
  const claimHint = status.claimHints.find((item) => item.ref === ref);
  const prompt = await readOptionalFile(await resolvePackagePath(workspace.packageDir, block.prompt), block.prompt);
  return {
    ref,
    taskId,
    blockId,
    type: block.type,
    title: block.title,
    status: blockStatus?.status ?? "planned",
    executor: block.executor ?? null,
    effectiveExecutor: block.executor ?? task.executor ?? manifest.execution.defaultExecutor ?? null,
    promptMarkdown: prompt.markdown,
    promptMissing: prompt.missing,
    dependencies: graph.blockDependenciesByRef.get(ref) ?? [],
    latestRunId: blockStatus?.lastRunId ?? null,
    latestReviewAttemptId: blockStatus?.latestReviewAttemptId ?? null,
    activeFeedbackId: blockStatus?.activeFeedbackId ?? null,
    exceptionReason: blockStatus?.reason ?? null,
    reviewGate: claimHint?.reviewGate ?? null
  };
}
