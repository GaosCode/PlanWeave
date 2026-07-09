import type { DesktopProjectSummary } from "@planweave-ai/runtime";
import {
  explainValidationReport,
  jsonToolResult,
  nonEmptyString,
  parseProjectArgs,
  readObjectArgs,
  sanitizeLocalPaths,
  sanitizeProject,
  sanitizeValidationIssues,
  sanitizeValidationReport
} from "../toolHelpers.js";
import type { PlanweavePartialToolHandlerRegistry } from "../toolDispatcher.js";
import type { RuntimeGateway } from "../toolTypes.js";

type ProjectTreeArgs = {
  projectId?: string;
  includeTasks: boolean;
  includeStatus: boolean;
};

export const projectReadToolHandlers = {
  get_project_tree: async (args, gateway) =>
    jsonToolResult(await buildProjectTree(gateway, parseProjectTreeArgs(args))),
  list_projects: async (_args, gateway) => {
    const projects = await gateway.listProjects();
    return jsonToolResult({ projects: projects.map(sanitizeProject) });
  },
  list_projects_summary: async (_args, gateway) => {
    const projects = await gateway.listProjects();
    return jsonToolResult({ projects: projects.map(sanitizeProject) });
  },
  open_project: async (args, gateway) => {
    const { projectId } = parseProjectArgs(args);
    return jsonToolResult({ project: sanitizeProject(await gateway.openProject(projectId)) });
  },
  open_project_summary: async (args, gateway) => {
    const { projectId } = parseProjectArgs(args);
    return jsonToolResult({ project: sanitizeProject(await gateway.openProject(projectId)) });
  },
  list_canvases: async (args, gateway) => {
    const { projectId } = parseProjectArgs(args);
    const project = sanitizeProject(await gateway.openProject(projectId));
    return jsonToolResult({ projectId: project.projectId, canvases: project.taskCanvases });
  },
  get_project_overview: async (args, gateway) => {
    const { projectId } = parseProjectArgs(args);
    return jsonToolResult({ project: sanitizeProject(await gateway.openProject(projectId)) });
  },
  create_project: async (args, gateway) => {
    const record = readObjectArgs(args);
    return jsonToolResult({
      project: sanitizeProject(await gateway.initProject(nonEmptyString(record.name, "name")))
    });
  },
  init_project: async (args, gateway) => {
    const record = readObjectArgs(args);
    return jsonToolResult({
      project: sanitizeProject(await gateway.initProject(nonEmptyString(record.name, "name")))
    });
  },
  create_canvas: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId } = parseProjectArgs(record);
    const name =
      typeof record.name === "string" && record.name.trim() ? record.name.trim() : undefined;
    return jsonToolResult({ canvas: await gateway.createCanvas(projectId, name) });
  },
  validate_project: async (args, gateway) => {
    const { projectId } = parseProjectArgs(args);
    return jsonToolResult(sanitizeValidationReport(await gateway.validateProject(projectId)));
  },
  explain_validation_errors: async (args, gateway) => {
    const { projectId } = parseProjectArgs(args);
    return jsonToolResult(
      explainValidationReport(sanitizeValidationReport(await gateway.validateProject(projectId)))
    );
  }
} satisfies PlanweavePartialToolHandlerRegistry;

function parseProjectTreeArgs(args: unknown): ProjectTreeArgs {
  if (args === undefined || args === null) {
    return { includeTasks: true, includeStatus: true };
  }
  const record = readObjectArgs(args);
  return {
    projectId:
      typeof record.projectId === "string" && record.projectId.trim()
        ? record.projectId.trim()
        : undefined,
    includeTasks: record.includeTasks !== false,
    includeStatus: record.includeStatus !== false
  };
}

async function buildProjectTree(gateway: RuntimeGateway, args: ProjectTreeArgs) {
  const allProjects = await gateway.listProjects();
  const projects = args.projectId
    ? allProjects.filter((project) => project.projectId === args.projectId)
    : allProjects;
  if (args.projectId && projects.length === 0) {
    throw new Error(`Project '${args.projectId}' is not registered in PlanWeave.`);
  }
  return {
    generatedAt: new Date().toISOString(),
    desktopSelection: null,
    guidance: [
      "Use project.projectId and canvasId exactly as returned here for project-scoped write tools.",
      "When the user names an existing PlanWeave project, inspect this tree before deciding whether to open an existing project or initialize a new one.",
      "Use get_project_graph, get_task_detail, get_block_detail, or read_prompt to inspect a selected branch in more detail."
    ],
    projects: await Promise.all(
      projects.map((project) => buildProjectContext(gateway, project, args))
    ),
    errors: [] as Array<{ scope: string; message: string }>
  };
}

async function buildProjectContext(
  gateway: RuntimeGateway,
  project: DesktopProjectSummary,
  args: ProjectTreeArgs
) {
  const errors: Array<{ scope: string; message: string }> = [];
  const validation = await captureContextValue(
    `validate_project:${project.projectId}`,
    errors,
    async () => {
      const report = await gateway.validateProject(project.projectId);
      return sanitizeValidationReport(report);
    }
  );
  const status = args.includeStatus
    ? await captureContextValue(`get_status:${project.projectId}`, errors, async () => {
        const projectStatus = await gateway.getStatus(
          project.projectId,
          project.activeCanvasId ?? undefined
        );
        return { ...projectStatus, warnings: sanitizeValidationIssues(projectStatus.warnings) };
      })
    : null;
  const readyBlocks = args.includeStatus
    ? await captureContextValue(
        `list_ready_blocks:${project.projectId}`,
        errors,
        async () => (await gateway.listReadyBlocks(project.projectId)).readyBlocks
      )
    : [];
  const canvases = args.includeTasks
    ? await Promise.all(
        project.taskCanvases.map((canvas) =>
          buildGraphContext(gateway, project.projectId, canvas.canvasId, canvas.name, errors)
        )
      )
    : [];

  return {
    project: sanitizeProject(project),
    validation,
    status,
    readyBlocks: readyBlocks ?? [],
    canvases: canvases.filter((canvas): canvas is NonNullable<typeof canvas> => canvas !== null),
    errors
  };
}

async function buildGraphContext(
  gateway: RuntimeGateway,
  projectId: string,
  canvasId: string,
  canvasName: string,
  errors: Array<{ scope: string; message: string }>
) {
  return captureContextValue(`get_project_graph:${projectId}:${canvasId}`, errors, async () => {
    const graph = await gateway.getProjectGraph(projectId, canvasId);
    return {
      canvasId,
      name: canvasName,
      taskCount: graph.tasks.length,
      edgeCount: graph.edges.length,
      diagnostics: sanitizeValidationIssues(graph.diagnostics),
      dirtyPromptRefs: graph.dirtyPromptRefs,
      tasks: graph.tasks.map((task) => ({
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        executor: task.executor,
        promptMissing: task.promptMissing,
        blockCount: task.blocks.length,
        blocks: task.blocks
      }))
    };
  });
}

async function captureContextValue<T>(
  scope: string,
  errors: Array<{ scope: string; message: string }>,
  read: () => Promise<T>
): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    errors.push({
      scope,
      message: sanitizeLocalPaths(error instanceof Error ? error.message : String(error))
    });
    return null;
  }
}
