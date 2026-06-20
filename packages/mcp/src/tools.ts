import {
  getBlockDetail,
  getGraphViewModel,
  getReviewPipeline,
  getTaskDetail,
  listProjects,
  openProject,
  resolveTaskCanvasWorkspace,
  runtimeSchemaDocuments,
  validatePackage,
  type DesktopBlockDetail,
  type DesktopGraphViewModel,
  type DesktopProjectSummary,
  type DesktopReviewPipeline,
  type DesktopTaskDetail,
  type RuntimeSchemaTopicName,
  type SchemaDocument,
  type ValidationReport
} from "@planweave-ai/runtime";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const planweaveToolNames = [
  "get_schema",
  "list_projects",
  "open_project",
  "validate_project",
  "get_project_overview",
  "get_project_graph",
  "get_task_detail",
  "get_block_detail",
  "get_review_pipeline"
] as const;

export type PlanweaveToolName = (typeof planweaveToolNames)[number];

export type RuntimeGateway = {
  getSchemaDocuments(): Record<RuntimeSchemaTopicName, SchemaDocument>;
  listProjects(): Promise<DesktopProjectSummary[]>;
  openProject(projectId: string): Promise<DesktopProjectSummary>;
  validateProject(projectId: string): Promise<ValidationReport>;
  getProjectOverview(projectId: string): Promise<DesktopProjectSummary>;
  getProjectGraph(projectId: string, canvasId?: string): Promise<DesktopGraphViewModel>;
  getTaskDetail(projectId: string, taskId: string, canvasId?: string): Promise<DesktopTaskDetail>;
  getBlockDetail(projectId: string, blockRef: string, canvasId?: string): Promise<DesktopBlockDetail>;
  getReviewPipeline(projectId: string, taskId: string, canvasId?: string): Promise<DesktopReviewPipeline>;
};

type OpenProjectArgs = {
  projectId: string;
};

type ProjectCanvasArgs = OpenProjectArgs & {
  canvasId?: string;
};

type TaskDetailArgs = ProjectCanvasArgs & {
  taskId: string;
};

type BlockDetailArgs = ProjectCanvasArgs & {
  blockRef: string;
};

type GetSchemaArgs = {
  topic?: RuntimeSchemaTopicName;
};

const runtimeGateway: RuntimeGateway = {
  getSchemaDocuments() {
    return runtimeSchemaDocuments;
  },
  async listProjects() {
    return listProjects();
  },
  async openProject(projectId) {
    await resolveProjectRoot(projectId);
    return openProject({ projectId });
  },
  async validateProject(projectId) {
    const projectRoot = await resolveProjectRoot(projectId);
    return validatePackage({ projectRoot });
  },
  async getProjectOverview(projectId) {
    return openProject({ projectId });
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
  }
};

async function resolveProjectRoot(projectId: string): Promise<string> {
  const project = (await listProjects()).find((item) => item.projectId === projectId);
  if (!project) {
    throw new Error(`Project '${projectId}' is not registered in PlanWeave.`);
  }
  return project.rootPath;
}

async function resolveCanvasWorkspace(projectId: string, canvasId?: string) {
  const project = await openProject({ projectId });
  return resolveTaskCanvasWorkspace(project.rootPath, canvasId);
}

function sanitizeProject(project: DesktopProjectSummary) {
  return {
    projectId: project.projectId,
    name: project.name,
    activeCanvasId: project.activeCanvasId,
    taskCanvases: project.taskCanvases
  };
}

function jsonToolResult(value: Record<string, unknown>): CallToolResult {
  return {
    structuredContent: value,
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function readObjectArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Tool arguments must be an object with a projectId string.");
  }
  return args as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return nonEmptyString(value, field);
}

function parseProjectIdArgs(args: unknown): OpenProjectArgs {
  const record = readObjectArgs(args);
  const projectId = record.projectId;
  if (typeof projectId !== "string" || projectId.trim() === "") {
    throw new Error("projectId is required.");
  }
  return { projectId: projectId.trim() };
}

function parseProjectCanvasArgs(args: unknown): ProjectCanvasArgs {
  const record = readObjectArgs(args);
  return {
    projectId: nonEmptyString(record.projectId, "projectId"),
    canvasId: optionalNonEmptyString(record.canvasId, "canvasId")
  };
}

function parseTaskDetailArgs(args: unknown): TaskDetailArgs {
  const record = readObjectArgs(args);
  return {
    projectId: nonEmptyString(record.projectId, "projectId"),
    canvasId: optionalNonEmptyString(record.canvasId, "canvasId"),
    taskId: nonEmptyString(record.taskId, "taskId")
  };
}

function parseBlockDetailArgs(args: unknown): BlockDetailArgs {
  const record = readObjectArgs(args);
  const blockRef = optionalNonEmptyString(record.blockRef, "blockRef");
  const taskId = optionalNonEmptyString(record.taskId, "taskId");
  const blockId = optionalNonEmptyString(record.blockId, "blockId");
  if (!blockRef && (!taskId || !blockId)) {
    throw new Error("blockRef is required unless taskId and blockId are provided.");
  }
  return {
    projectId: nonEmptyString(record.projectId, "projectId"),
    canvasId: optionalNonEmptyString(record.canvasId, "canvasId"),
    blockRef: blockRef ?? `${taskId}#${blockId}`
  };
}

function parseGetSchemaArgs(args: unknown): GetSchemaArgs {
  if (args === undefined || args === null) {
    return {};
  }
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Tool arguments must be an object.");
  }
  const topic = (args as { topic?: unknown }).topic;
  if (topic === undefined || topic === null || topic === "") {
    return {};
  }
  if (topic !== "manifest" && topic !== "project") {
    throw new Error("topic must be one of: manifest, project.");
  }
  return { topic };
}

export async function handlePlanweaveTool(name: PlanweaveToolName, args: unknown, gateway: RuntimeGateway = runtimeGateway): Promise<CallToolResult> {
  if (name === "get_schema") {
    const { topic } = parseGetSchemaArgs(args);
    const documents = gateway.getSchemaDocuments();
    return jsonToolResult({ topic: topic ?? null, documents: topic ? { [topic]: documents[topic] } : documents });
  }

  if (name === "list_projects") {
    const projects = await gateway.listProjects();
    return jsonToolResult({ projects: projects.map(sanitizeProject) });
  }

  if (name === "open_project") {
    const { projectId } = parseProjectIdArgs(args);
    const project = await gateway.openProject(projectId);
    return jsonToolResult({ project: sanitizeProject(project) });
  }

  if (name === "validate_project") {
    const { projectId } = parseProjectIdArgs(args);
    const report = await gateway.validateProject(projectId);
    return jsonToolResult(report);
  }

  if (name === "get_project_overview") {
    const { projectId } = parseProjectIdArgs(args);
    const project = await gateway.getProjectOverview(projectId);
    return jsonToolResult({ project: sanitizeProject(project) });
  }

  if (name === "get_project_graph") {
    const { projectId, canvasId } = parseProjectCanvasArgs(args);
    return jsonToolResult({ graph: await gateway.getProjectGraph(projectId, canvasId) });
  }

  if (name === "get_task_detail") {
    const { projectId, taskId, canvasId } = parseTaskDetailArgs(args);
    return jsonToolResult({ task: await gateway.getTaskDetail(projectId, taskId, canvasId) });
  }

  if (name === "get_block_detail") {
    const { projectId, blockRef, canvasId } = parseBlockDetailArgs(args);
    return jsonToolResult({ block: await gateway.getBlockDetail(projectId, blockRef, canvasId) });
  }

  if (name === "get_review_pipeline") {
    const { projectId, taskId, canvasId } = parseTaskDetailArgs(args);
    return jsonToolResult({ reviewPipeline: await gateway.getReviewPipeline(projectId, taskId, canvasId) });
  }

  throw new Error(`Unknown PlanWeave MCP tool '${name}'.`);
}

export function isPlanweaveToolName(value: string): value is PlanweaveToolName {
  return planweaveToolNames.includes(value as PlanweaveToolName);
}
