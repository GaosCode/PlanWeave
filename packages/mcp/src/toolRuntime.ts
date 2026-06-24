import {
  addCanvasDependency,
  addBlock,
  addCrossTaskDependency,
  addDependencyEdge,
  addTaskNode,
  createTaskCanvas,
  getBlockDetail,
  getExecutionStatus,
  getGraphViewModel,
  getProjectExecutionPlan,
  getReviewPipeline,
  getTaskDetail,
  initManagedProject,
  renderPrompt,
  listProjects,
  listTaskCanvases,
  openProject,
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
  updateBlockDependencies,
  updateBlockExecutor,
  updateBlockPlanning,
  updateBlockPrompt,
  updateBlockTitle,
  updateCanvasExecutionPolicy,
  updateProjectPrompt,
  updateReviewPipeline,
  updateTaskAcceptance,
  updateTaskExecutor,
  updateTaskPrompt,
  updateTaskTitle,
  validatePackage
} from "@planweave-ai/runtime";
import type { DesktopSearchResult, DesktopTodoItem, GraphEditResult } from "@planweave-ai/runtime";
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
  async createTask(projectId, canvasId, input) {
    return addTaskNode(await resolveCanvasWorkspace(projectId, canvasId), input);
  },
  async updateTask(projectId, canvasId, taskId, input) {
    let result: GraphEditResult | null = null;
    const workspace = await resolveCanvasWorkspace(projectId, canvasId);
    if (input.title !== undefined) {
      result = await updateTaskTitle(workspace, taskId, input.title);
    }
    if (input.promptMarkdown !== undefined) {
      result = await updateTaskPrompt(workspace, taskId, input.promptMarkdown);
    }
    if (Object.prototype.hasOwnProperty.call(input, "executor")) {
      result = await updateTaskExecutor(workspace, taskId, input.executor ?? null);
    }
    if (!result) {
      throw new Error("At least one of title, promptMarkdown, or executor must be provided.");
    }
    return result;
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
  async updateBlock(projectId, canvasId, blockRef, input) {
    let result: GraphEditResult | null = null;
    const workspace = await resolveCanvasWorkspace(projectId, canvasId);
    if (input.title !== undefined) {
      result = await updateBlockTitle(workspace, blockRef, input.title);
    }
    if (input.promptMarkdown !== undefined) {
      result = await updateBlockPrompt(workspace, blockRef, input.promptMarkdown);
    }
    if (Object.prototype.hasOwnProperty.call(input, "executor")) {
      result = await updateBlockExecutor(workspace, blockRef, input.executor ?? null);
    }
    if (!result) {
      throw new Error("At least one of title, promptMarkdown, or executor must be provided.");
    }
    return result;
  },
  async updateCanvasExecutionPolicy(projectId, canvasId, input) {
    return updateCanvasExecutionPolicy(await resolveCanvasWorkspace(projectId, canvasId), input);
  },
  async updateBlockPlanning(projectId, canvasId, blockRef, input) {
    return updateBlockPlanning(await resolveCanvasWorkspace(projectId, canvasId), blockRef, input);
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
  }
};

async function resolveProjectRoot(projectId: string): Promise<string> {
  const project = (await listProjects()).find((item) => item.projectId === projectId);
  if (!project) {
    throw new Error(`Project '${projectId}' is not registered in PlanWeave.`);
  }
  return project.rootPath;
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
