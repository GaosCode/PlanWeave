import {
  addCanvasDependency,
  addBlock,
  addCrossTaskDependency,
  addDependencyEdge,
  addTaskNode,
  applyCanvasLaneLayout as runtimeApplyCanvasLaneLayout,
  bulkApplyReviewPipeline as runtimeBulkApplyReviewPipeline,
  applyPackageDraftImport as runtimeApplyPackageDraftImport,
  bulkAddTaskDependencies as runtimeBulkAddTaskDependencies,
  bulkCreateBlocks as runtimeBulkCreateBlocks,
  bulkCreateTasks as runtimeBulkCreateTasks,
  bulkRemoveGraphItems as runtimeBulkRemoveGraphItems,
  bulkSetBlockDependencies as runtimeBulkSetBlockDependencies,
  bulkSetTaskDependencies as runtimeBulkSetTaskDependencies,
  bulkUpdateBlocks as runtimeBulkUpdateBlocks,
  bulkUpdateParallelPolicy as runtimeBulkUpdateParallelPolicy,
  bulkUpdateTasks as runtimeBulkUpdateTasks,
  createTaskCanvas,
  getPromptSources as runtimeGetPromptSources,
  getBlockDetail,
  getExecutionStatus,
  getGraphViewModel,
  getProjectExecutionPlan,
  getReviewPipeline,
  getTaskDetail,
  initManagedProject,
  inspectGraph as runtimeInspectGraph,
  listPackageFiles as runtimeListPackageFiles,
  renderPrompt,
  listProjects,
  listTaskCanvases,
  openProject,
  previewPackageDraftImport as runtimePreviewPackageDraftImport,
  readPackageFile as runtimeReadPackageFile,
  readPromptSource as runtimeReadPromptSource,
  readRenderedPrompt as runtimeReadRenderedPrompt,
  readProjectPrompt,
  refreshPrompts,
  removeBlock,
  removeCanvasDependency,
  removeCrossTaskDependency,
  removeDependencyEdge,
  removeTaskNode,
  resolveTaskCanvasWorkspace,
  runtimeSchemaDocuments,
  searchProjectWithDiagnostics,
  setTaskDependencies as runtimeSetTaskDependencies,
  updateBlockDependencies,
  updateBlockFields,
  updateBlockPlanning,
  updateCanvasExecutionPolicy,
  updateProjectPrompt,
  updateReviewPipeline,
  updateTaskAcceptance,
  updateTaskFields,
  validateExecutionReadiness as runtimeValidateExecutionReadiness,
  validateGraphQuality as runtimeValidateGraphQuality,
  validatePackageDraft as runtimeValidatePackageDraft,
  validatePackage
} from "@planweave-ai/runtime";
import type { DesktopSearchResult, DesktopTodoItem } from "@planweave-ai/runtime";
import {
  getStatus,
  getDiff,
  getLog,
  stageAll,
  commit,
  getRepoInfo
} from "@planweave-ai/runtime";
import { createPR, listPRs, getPR, mergePR } from "./github/index.js";
import { sanitizeLocalPaths, sanitizeValidationIssues } from "./toolHelpers.js";
import { exportCanvasPackage, importPackageFiles } from "./toolPackageFiles.js";
import type { ReadyBlock, RuntimeGateway, SanitizedExecutionStatus } from "./toolTypes.js";

export const runtimeGateway: RuntimeGateway = {
  getSchemaDocuments() {
    return runtimeSchemaDocuments;
  },
  async initProject(name) {
    return initManagedProject(name);
  },
  async createCanvas(projectId, name) {
    return createTaskCanvas(await resolveProjectRoot(projectId), { name });
  },
  async listProjects() {
    return listProjects();
  },
  async openProject(projectId) {
    await resolveProjectRoot(projectId);
    return openProject({ projectId });
  },
  async validateProject(projectId) {
    return validatePackage({ projectRoot: await resolveProjectRoot(projectId) });
  },
  async getStatus(projectId, canvasId) {
    const selectedCanvasId = await resolveSelectedCanvasId(projectId, canvasId);
    return sanitizeExecutionStatus(await getExecutionStatus({ projectRoot: await resolveCanvasWorkspace(projectId, canvasId) }), selectedCanvasId);
  },
  async getPrompt(projectId, canvasId, ref) {
    const selectedCanvasId = await resolveSelectedCanvasId(projectId, canvasId);
    return {
      canvasId: selectedCanvasId,
      markdown: await renderPrompt({ projectRoot: await resolveCanvasWorkspace(projectId, selectedCanvasId), ref })
    };
  },
  async searchProject(projectId, args) {
    const projection = await searchProjectWithDiagnostics(await resolveProjectRoot(projectId), args.query, {
      canvasId: args.canvasId,
      kinds: args.kinds,
      limit: args.limit
    });
    return {
      results: projection.results.map(sanitizeSearchResult),
      diagnostics: sanitizeValidationIssues(projection.diagnostics)
    };
  },
  async listReadyBlocks(projectId, canvasId) {
    const plan = await getProjectExecutionPlan(await resolveProjectRoot(projectId));
    if (canvasId) {
      const phase = plan.phases.find((candidate) => candidate.canvasId === canvasId);
      if (!phase) {
        throw new Error(`Task canvas '${canvasId}' does not exist.`);
      }
      return { readyBlocks: phase.readyQueue.map(sanitizeReadyBlock) };
    }
    return { readyBlocks: plan.readyQueue.map(sanitizeReadyBlock) };
  },
  async getProjectGraph(projectId, canvasId) {
    return getGraphViewModel(await resolveCanvasWorkspace(projectId, canvasId));
  },
  async inspectGraph(projectId, canvasId, input) {
    return runtimeInspectGraph({
      projectRoot: await resolveCanvasWorkspace(projectId, canvasId),
      ...input
    });
  },
  async validateGraphQuality(projectId, canvasId, input) {
    return runtimeValidateGraphQuality({
      projectRoot: await resolveCanvasWorkspace(projectId, canvasId),
      ...input
    });
  },
  async validateExecutionReadiness(projectId, canvasId) {
    return runtimeValidateExecutionReadiness({ projectRoot: await resolveCanvasWorkspace(projectId, canvasId) });
  },
  async getTaskDetail(projectId, taskId, canvasId) {
    return getTaskDetail(await resolveCanvasWorkspace(projectId, canvasId), taskId);
  },
  async getBlockDetail(projectId, blockRef, canvasId) {
    return getBlockDetail(await resolveCanvasWorkspace(projectId, canvasId), blockRef);
  },
  async getReviewPipeline(projectId, taskId, canvasId) {
    return getReviewPipeline(await resolveCanvasWorkspace(projectId, canvasId), taskId);
  },
  async updateReviewPipeline(projectId, canvasId, taskId, input) {
    return updateReviewPipeline(await resolveCanvasWorkspace(projectId, canvasId), taskId, input);
  },
  async bulkApplyReviewPipeline(projectId, canvasId, updates) {
    return runtimeBulkApplyReviewPipeline(await resolveCanvasWorkspace(projectId, canvasId), updates);
  },
  async createTask(projectId, canvasId, input) {
    return addTaskNode(await resolveCanvasWorkspace(projectId, canvasId), input);
  },
  async bulkCreateTasks(projectId, canvasId, tasks) {
    return runtimeBulkCreateTasks(await resolveCanvasWorkspace(projectId, canvasId), tasks);
  },
  async updateTask(projectId, canvasId, taskId, input) {
    const workspace = await resolveCanvasWorkspace(projectId, canvasId);
    return updateTaskFields(workspace, taskId, input);
  },
  async updateTaskAcceptance(projectId, canvasId, taskId, acceptance) {
    return updateTaskAcceptance(await resolveCanvasWorkspace(projectId, canvasId), taskId, acceptance);
  },
  async removeTask(projectId, canvasId, taskId) {
    return removeTaskNode(await resolveCanvasWorkspace(projectId, canvasId), taskId);
  },
  async createBlock(projectId, canvasId, input) {
    return addBlock(await resolveCanvasWorkspace(projectId, canvasId), input);
  },
  async bulkCreateBlocks(projectId, canvasId, blocks) {
    return runtimeBulkCreateBlocks(await resolveCanvasWorkspace(projectId, canvasId), blocks);
  },
  async updateBlock(projectId, canvasId, blockRef, input) {
    const workspace = await resolveCanvasWorkspace(projectId, canvasId);
    return updateBlockFields(workspace, blockRef, input);
  },
  async bulkUpdateTasks(projectId, canvasId, updates) {
    return runtimeBulkUpdateTasks(await resolveCanvasWorkspace(projectId, canvasId), updates.map((update) => ({
      taskId: update.taskId,
      fields: update.input
    })));
  },
  async bulkUpdateBlocks(projectId, canvasId, updates) {
    return runtimeBulkUpdateBlocks(await resolveCanvasWorkspace(projectId, canvasId), updates.map((update) => ({
      blockRef: update.blockRef,
      fields: update.input
    })));
  },
  async bulkRemoveGraphItems(projectId, canvasId, input) {
    return runtimeBulkRemoveGraphItems(await resolveCanvasWorkspace(projectId, canvasId), {
      taskIds: input.tasks,
      blockRefs: input.blocks,
      taskDependencyEdges: input.taskDependencyEdges,
      blockDependencyEdges: input.blockDependencyRefs
    });
  },
  async updateCanvasExecutionPolicy(projectId, canvasId, input) {
    return updateCanvasExecutionPolicy(await resolveCanvasWorkspace(projectId, canvasId), input);
  },
  async updateBlockPlanning(projectId, canvasId, blockRef, input) {
    return updateBlockPlanning(await resolveCanvasWorkspace(projectId, canvasId), blockRef, input);
  },
  async bulkUpdateParallelPolicy(projectId, canvasId, input) {
    return runtimeBulkUpdateParallelPolicy(await resolveCanvasWorkspace(projectId, canvasId), input);
  },
  async updateBlockDependencies(projectId, canvasId, blockRef, dependsOn) {
    return updateBlockDependencies(await resolveCanvasWorkspace(projectId, canvasId), blockRef, dependsOn);
  },
  async removeBlock(projectId, canvasId, blockRef) {
    return removeBlock(await resolveCanvasWorkspace(projectId, canvasId), blockRef);
  },
  async addDependency(projectId, canvasId, fromTaskId, toTaskId) {
    return addDependencyEdge(await resolveCanvasWorkspace(projectId, canvasId), fromTaskId, toTaskId);
  },
  async removeDependency(projectId, canvasId, fromTaskId, toTaskId) {
    return removeDependencyEdge(await resolveCanvasWorkspace(projectId, canvasId), fromTaskId, toTaskId);
  },
  async setTaskDependencies(projectId, canvasId, taskId, dependsOn) {
    return runtimeSetTaskDependencies({ projectRoot: await resolveCanvasWorkspace(projectId, canvasId), taskId, dependsOn });
  },
  async bulkAddTaskDependencies(projectId, canvasId, edges) {
    return runtimeBulkAddTaskDependencies({ projectRoot: await resolveCanvasWorkspace(projectId, canvasId), edges });
  },
  async bulkSetTaskDependencies(projectId, canvasId, updates) {
    return runtimeBulkSetTaskDependencies({ projectRoot: await resolveCanvasWorkspace(projectId, canvasId), updates });
  },
  async bulkSetBlockDependencies(projectId, canvasId, updates) {
    return runtimeBulkSetBlockDependencies({ projectRoot: await resolveCanvasWorkspace(projectId, canvasId), updates });
  },
  async applyCanvasLaneLayout(projectId, canvasId, input) {
    return runtimeApplyCanvasLaneLayout(await resolveCanvasWorkspace(projectId, canvasId), input);
  },
  async addCanvasDependency(projectId, fromCanvasId, toCanvasId) {
    return addCanvasDependency(await resolveProjectRoot(projectId), fromCanvasId, toCanvasId);
  },
  async removeCanvasDependency(projectId, fromCanvasId, toCanvasId) {
    return removeCanvasDependency(await resolveProjectRoot(projectId), fromCanvasId, toCanvasId);
  },
  async addCrossTaskDependency(projectId, from, to) {
    return addCrossTaskDependency(await resolveProjectRoot(projectId), from, to);
  },
  async removeCrossTaskDependency(projectId, from, to) {
    return removeCrossTaskDependency(await resolveProjectRoot(projectId), from, to);
  },
  async readProjectPrompt(projectId) {
    return readProjectPrompt(await resolveProjectRoot(projectId));
  },
  async listPackageFiles(projectId, canvasId, limit, cursor) {
    return runtimeListPackageFiles({ projectRoot: await resolveCanvasWorkspace(projectId, canvasId), limit, cursor });
  },
  async readPackageFile(projectId, canvasId, path, maxBytes) {
    return runtimeReadPackageFile({ projectRoot: await resolveCanvasWorkspace(projectId, canvasId), path, maxBytes });
  },
  async readPromptSource(projectId, canvasId, input) {
    return runtimeReadPromptSource({ projectRoot: await resolveCanvasWorkspace(projectId, canvasId), ...input });
  },
  async readRenderedPrompt(projectId, canvasId, ref, maxBytes) {
    return runtimeReadRenderedPrompt({ projectRoot: await resolveCanvasWorkspace(projectId, canvasId), ref, maxBytes });
  },
  async getPromptSources(projectId, canvasId, ref) {
    return runtimeGetPromptSources({ projectRoot: await resolveCanvasWorkspace(projectId, canvasId), ref });
  },
  async updateProjectPrompt(projectId, markdown) {
    return updateProjectPrompt(await resolveProjectRoot(projectId), markdown);
  },
  async refreshPrompts(projectId, canvasId) {
    return refreshPrompts({ projectRoot: await resolveCanvasWorkspace(projectId, canvasId) });
  },
  async exportPlanPackage(projectId, canvasId) {
    return exportCanvasPackage(projectId, canvasId);
  },
  async exportProject(projectId) {
    const project = await openProject({ projectId });
    const canvases = await listTaskCanvases(project.rootPath);
    return {
      project,
      projectPromptMarkdown: await readProjectPrompt(project.rootPath),
      planPackages: await Promise.all(canvases.map((canvas) => exportCanvasPackage(projectId, canvas.canvasId)))
    };
  },
  async importPlanPackage(input) {
    return importPackageFiles(input.name, input.files, input.overwrite ?? false);
  },
  async validatePackageDraft(draftRoot) {
    return runtimeValidatePackageDraft({ draftRoot });
  },
  async previewPackageDraftImport(input) {
    return runtimePreviewPackageDraftImport({
      draftRoot: input.draftRoot,
      projectRoot: await resolveProjectRoot(input.projectId),
      canvasId: input.canvasId
    });
  },
  async importPackageDraft(input) {
    return runtimeApplyPackageDraftImport({
      draftRoot: input.draftRoot,
      projectRoot: await resolveProjectRoot(input.projectId),
      canvasId: input.canvasId
    });
  },

  async gitStatus(projectId) {
    return getStatus(await resolveSourceRoot(projectId));
  },

  async gitDiff(projectId, staged, files) {
    return getDiff(await resolveSourceRoot(projectId), { staged, files });
  },

  async gitLog(projectId, maxCount) {
    return getLog(await resolveSourceRoot(projectId), { maxCount });
  },

  async gitCommit(projectId, message) {
    const cwd = await resolveSourceRoot(projectId);
    await stageAll(cwd);
    return commit(cwd, message);
  },

  async gitRepoInfo(projectId) {
    return getRepoInfo(await resolveSourceRoot(projectId));
  },

  async githubCreatePR(projectId, title, head, base, body) {
    const { owner, repo } = await resolveGitHubRepo(projectId);
    return createPR(owner, repo, { title, head, base, body });
  },

  async githubListPRs(projectId, state) {
    const { owner, repo } = await resolveGitHubRepo(projectId);
    return listPRs(owner, repo, { state: state as "open" | "closed" | "all" | undefined });
  },

  async githubGetPR(projectId, prNumber) {
    const { owner, repo } = await resolveGitHubRepo(projectId);
    return getPR(owner, repo, prNumber);
  },

  async githubMergePR(projectId, prNumber, method) {
    const { owner, repo } = await resolveGitHubRepo(projectId);
    return mergePR(owner, repo, prNumber, { method });
  }
};

async function resolveProjectRoot(projectId: string): Promise<string> {
  const project = (await listProjects()).find((item) => item.projectId === projectId);
  if (!project) {
    throw new Error(`Project '${projectId}' is not registered in PlanWeave.`);
  }
  return project.rootPath;
}

async function resolveSourceRoot(projectId: string): Promise<string> {
  const project = (await listProjects()).find((item) => item.projectId === projectId);
  if (!project) {
    throw new Error(`Project '${projectId}' is not registered in PlanWeave.`);
  }
  return project.sourceRoot ?? project.rootPath;
}

async function resolveGitHubRepo(projectId: string): Promise<{ owner: string; repo: string }> {
  const cwd = await resolveSourceRoot(projectId);
  const info = await getRepoInfo(cwd);
  if (!info.owner || !info.repo) {
    throw new Error(
      `Project '${projectId}' is not linked to a GitHub repository. Ensure a git remote named 'origin' points to github.com.`,
    );
  }
  return { owner: info.owner, repo: info.repo };
}

async function resolveSelectedCanvasId(projectId: string, canvasId?: string | null): Promise<string | null> {
  if (canvasId) {
    return canvasId;
  }
  const project = await openProject({ projectId });
  return project.activeCanvasId ?? project.taskCanvases[0]?.canvasId ?? null;
}

async function resolveCanvasWorkspace(projectId: string, canvasId?: string | null) {
  const project = await openProject({ projectId });
  return resolveTaskCanvasWorkspace(project.rootPath, canvasId);
}

function sanitizeExecutionStatus(
  status: Awaited<ReturnType<typeof getExecutionStatus>>,
  canvasId: string | null
): SanitizedExecutionStatus {
  return {
    projectId: status.projectId,
    canvasId,
    taskTotal: status.taskTotal,
    blockTotal: status.blockTotal,
    tasks: status.tasks,
    blocks: status.blocks,
    currentRefs: status.currentRefs,
    openFeedback: status.openFeedback,
    nextClaimable: status.nextClaimable,
    claimHints: status.claimHints,
    counts: status.counts,
    warnings: sanitizeValidationIssues(status.warnings)
  };
}

function sanitizeSearchResult(result: DesktopSearchResult): Omit<DesktopSearchResult, "path"> {
  return {
    kind: result.kind,
    canvasId: result.canvasId,
    canvasName: result.canvasName,
    ref: result.ref,
    targetRef: result.targetRef,
    title: sanitizeLocalPaths(result.title),
    excerpt: sanitizeLocalPaths(result.excerpt),
    match: result.match
      ? {
          ...result.match,
          excerpt: sanitizeLocalPaths(result.match.excerpt)
        }
      : undefined,
    recordId: result.recordId
  };
}

function sanitizeReadyBlock(item: DesktopTodoItem): ReadyBlock {
  return {
    canvasId: item.canvasId ?? null,
    canvasName: item.canvasName ?? null,
    ref: item.ref,
    taskId: item.taskId,
    blockId: item.blockId,
    title: item.title,
    parallelSafe: item.parallelSafe,
    locks: item.locks,
    reviewGate: item.reviewGate
  };
}
