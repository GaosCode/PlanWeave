import { ZodError } from "zod";
import { relative } from "node:path";
import {
  compileProjectGraph,
  loadProjectGraph,
  projectCanvasWorkspace
} from "../projectGraph/index.js";
import type { ProjectGraphSource } from "../projectGraph/index.js";
import {
  canvasRecoveryPathExists,
  listCanvasWorkspaceAnomalies,
  quarantineCanvasWorkspace,
  removeCanvasStagingWorkspace,
  type CanvasWorkspaceDirectory
} from "../projectGraph/canvasWorkspaceRecovery.js";
import type {
  ProjectDoctorCanvasReport,
  ProjectDoctorIssue,
  ProjectDoctorReport,
  ProjectWorkspace,
  ValidationIssue
} from "../types.js";
import { runDoctor } from "./doctor.js";
import {
  canvasDoctorIssue,
  canvasWorkspaceIssue,
  uniqueProjectDoctorIssues,
  validateCanvasPackageForDoctor
} from "./projectDoctorCanvas.js";

function projectGraphIssuePath(path?: string): string {
  if (!path || path === "project-graph.json") {
    return "project-graph.json";
  }
  return `project-graph.json:${path}`;
}

function projectGraphDoctorIssue(issue: ValidationIssue): ProjectDoctorIssue {
  return {
    code: issue.code,
    message: issue.message,
    path: projectGraphIssuePath(issue.path),
    source: "project_graph"
  };
}

function projectGraphReadErrors(error: unknown): ProjectDoctorIssue[] {
  if (error instanceof ZodError) {
    return error.issues.map((zodIssue) => ({
      code: "project_graph_schema",
      message: zodIssue.message,
      path: projectGraphIssuePath(zodIssue.path.join(".")),
      source: "project_graph"
    }));
  }
  return [
    {
      code: "project_graph_read_failed",
      message: error instanceof Error ? error.message : String(error),
      path: "project-graph.json",
      source: "project_graph"
    }
  ];
}

function reportOk(errors: ProjectDoctorIssue[]): boolean {
  return errors.length === 0 || errors.every((item) => item.repaired === true);
}

function canvasIndexPath(canvasIndex: number): string {
  return projectGraphIssuePath(canvasIndex >= 0 ? `canvases.${canvasIndex}` : "canvases");
}

function projectWorkspaceRelative(workspace: ProjectWorkspace, path: string): string {
  return relative(workspace.workspaceRoot, path).split("\\").join("/") || ".";
}

function canvasEntryPath(source: ProjectGraphSource, canvasIndex: number): string {
  if (source === "legacy_registry") {
    return canvasIndex >= 0
      ? `desktop/canvases.json:canvases.${canvasIndex}`
      : "desktop/canvases.json:canvases";
  }
  return canvasIndexPath(canvasIndex);
}

function canvasEntryMissingWorkspaceIssue(
  source: ProjectGraphSource,
  canvasId: string,
  canvasIndex: number,
  projectWorkspace: ProjectWorkspace,
  canvasWorkspace: ProjectWorkspace
): ProjectDoctorIssue {
  return {
    code:
      source === "legacy_registry"
        ? "canvas_registry_entry_missing_workspace"
        : "canvas_graph_entry_missing_workspace",
    message: `Canvas '${canvasId}' is registered, but its workspace directory '${projectWorkspaceRelative(projectWorkspace, canvasWorkspace.workspaceRoot)}' does not exist.`,
    canvasId,
    path: canvasEntryPath(source, canvasIndex),
    source: "project_graph"
  };
}

function canvasWorkspaceAnomalyIssue(
  code: string,
  message: string,
  projectWorkspace: ProjectWorkspace,
  directory: CanvasWorkspaceDirectory,
  repaired?: boolean
): ProjectDoctorIssue {
  return {
    code,
    message,
    canvasId: directory.name,
    path: projectWorkspaceRelative(projectWorkspace, directory.path),
    repaired,
    source: "project_graph"
  };
}

async function repairOrphanCanvasDirectory(
  projectWorkspace: ProjectWorkspace,
  directory: CanvasWorkspaceDirectory
): Promise<ProjectDoctorIssue> {
  try {
    await quarantineCanvasWorkspace(projectWorkspace, {
      canvasId: directory.name,
      workspaceRoot: directory.path
    });
    return canvasWorkspaceAnomalyIssue(
      "orphan_canvas_directory",
      "Unregistered canvas workspace directory was moved to canvas quarantine.",
      projectWorkspace,
      directory,
      true
    );
  } catch (error) {
    return canvasWorkspaceAnomalyIssue(
      "orphan_canvas_directory",
      `Unregistered canvas workspace directory exists, but repair failed: ${error instanceof Error ? error.message : String(error)}`,
      projectWorkspace,
      directory
    );
  }
}

async function repairStaleCanvasStagingDirectory(
  projectWorkspace: ProjectWorkspace,
  directory: CanvasWorkspaceDirectory
): Promise<ProjectDoctorIssue> {
  try {
    await removeCanvasStagingWorkspace(projectWorkspace, directory.path);
    return canvasWorkspaceAnomalyIssue(
      "stale_canvas_staging_directory",
      "Stale canvas staging directory was removed.",
      projectWorkspace,
      directory,
      true
    );
  } catch (error) {
    return canvasWorkspaceAnomalyIssue(
      "stale_canvas_staging_directory",
      `Stale canvas staging directory exists, but repair failed: ${error instanceof Error ? error.message : String(error)}`,
      projectWorkspace,
      directory
    );
  }
}

async function canvasWorkspaceRecoveryIssues(options: {
  projectWorkspace: ProjectWorkspace;
  registeredCanvasWorkspaces: ProjectWorkspace[];
  repair?: boolean;
}): Promise<{ errors: ProjectDoctorIssue[]; warnings: ProjectDoctorIssue[] }> {
  const anomalies = await listCanvasWorkspaceAnomalies(
    options.projectWorkspace,
    options.registeredCanvasWorkspaces
  );
  const errors: ProjectDoctorIssue[] = [];
  const warnings: ProjectDoctorIssue[] = [];

  for (const directory of anomalies.orphanDirectories) {
    errors.push(
      options.repair === true
        ? await repairOrphanCanvasDirectory(options.projectWorkspace, directory)
        : canvasWorkspaceAnomalyIssue(
            "orphan_canvas_directory",
            "Unregistered canvas workspace directory exists.",
            options.projectWorkspace,
            directory
          )
    );
  }
  for (const directory of anomalies.unrecognizedOrphanDirectories) {
    warnings.push(
      canvasWorkspaceAnomalyIssue(
        "unrecognized_orphan_canvas_directory",
        "Unregistered directory under canvases is not a recognizable PlanWeave canvas workspace; repair skipped.",
        options.projectWorkspace,
        directory
      )
    );
  }
  for (const directory of anomalies.stagingDirectories) {
    errors.push(
      options.repair === true
        ? await repairStaleCanvasStagingDirectory(options.projectWorkspace, directory)
        : canvasWorkspaceAnomalyIssue(
            "stale_canvas_staging_directory",
            "Stale canvas staging directory exists.",
            options.projectWorkspace,
            directory
          )
    );
  }
  for (const directory of anomalies.quarantineDirectories) {
    warnings.push(
      canvasWorkspaceAnomalyIssue(
        "stale_canvas_quarantine_directory",
        "Canvas quarantine directory exists and may contain recoverable data.",
        options.projectWorkspace,
        directory
      )
    );
  }

  return { errors, warnings };
}

export async function runProjectDoctor(options: {
  projectRoot: string;
  repair?: boolean;
}): Promise<ProjectDoctorReport> {
  let loaded: Awaited<ReturnType<typeof loadProjectGraph>>;
  try {
    loaded = await loadProjectGraph(options.projectRoot);
  } catch (error) {
    return {
      ok: false,
      repaired: false,
      errors: projectGraphReadErrors(error),
      warnings: [],
      canvasReports: []
    };
  }

  const graph = await compileProjectGraph(loaded);
  let projectErrors = uniqueProjectDoctorIssues(
    graph.diagnostics.errors.map(projectGraphDoctorIssue)
  );
  let projectWarnings = uniqueProjectDoctorIssues(
    graph.diagnostics.warnings.map(projectGraphDoctorIssue)
  );
  const canvasReports: ProjectDoctorCanvasReport[] = [];
  const registeredCanvasWorkspaces: ProjectWorkspace[] = [];

  for (const canvasId of graph.canvasIdsInOrder) {
    const canvas = graph.canvasesById.get(canvasId);
    if (!canvas) {
      continue;
    }
    const canvasIndex = loaded.manifest.canvases.findIndex((item) => item.id === canvasId);
    let workspace: ProjectWorkspace;
    try {
      workspace = projectCanvasWorkspace(loaded.workspace, canvas);
    } catch (error) {
      const issue = canvasWorkspaceIssue(canvasId, canvasIndexPath(canvasIndex), error);
      canvasReports.push({ canvasId, ok: false, repaired: false, errors: [issue], warnings: [] });
      continue;
    }
    registeredCanvasWorkspaces.push(workspace);
    if (!(await canvasRecoveryPathExists(workspace.workspaceRoot))) {
      const issue = canvasEntryMissingWorkspaceIssue(
        graph.source,
        canvasId,
        canvasIndex,
        loaded.workspace,
        workspace
      );
      canvasReports.push({ canvasId, ok: false, repaired: false, errors: [issue], warnings: [] });
      continue;
    }

    const validation = await validateCanvasPackageForDoctor({ canvasId, workspace });
    let doctorErrors: ProjectDoctorIssue[] = [];
    let doctorWarnings: ProjectDoctorIssue[] = [];
    if (validation.manifest) {
      try {
        const report = await runDoctor({ projectRoot: workspace, repair: options.repair });
        const mapped = report.issues.map((item) =>
          canvasDoctorIssue(canvasId, workspace, validation.manifest, item)
        );
        doctorErrors = mapped.filter((item) => item.code !== "retention_threshold_exceeded");
        doctorWarnings = mapped.filter((item) => item.code === "retention_threshold_exceeded");
      } catch (error) {
        doctorErrors = [
          {
            code: "canvas_doctor_failed",
            message: error instanceof Error ? error.message : String(error),
            canvasId,
            source: "canvas_doctor"
          }
        ];
      }
    }
    const errors = uniqueProjectDoctorIssues([...validation.errors, ...doctorErrors]);
    const warnings = uniqueProjectDoctorIssues([...validation.warnings, ...doctorWarnings]);
    canvasReports.push({
      canvasId,
      ok: reportOk(errors),
      repaired: errors.some((item) => item.repaired === true),
      errors,
      warnings
    });
  }

  const workspaceRecoveryIssues = await canvasWorkspaceRecoveryIssues({
    projectWorkspace: loaded.workspace,
    registeredCanvasWorkspaces,
    repair: options.repair
  });
  projectErrors = uniqueProjectDoctorIssues([...projectErrors, ...workspaceRecoveryIssues.errors]);
  projectWarnings = uniqueProjectDoctorIssues([
    ...projectWarnings,
    ...workspaceRecoveryIssues.warnings
  ]);

  const errors = uniqueProjectDoctorIssues([
    ...projectErrors,
    ...canvasReports.flatMap((report) => report.errors)
  ]);
  const warnings = uniqueProjectDoctorIssues([
    ...projectWarnings,
    ...canvasReports.flatMap((report) => report.warnings)
  ]);
  return {
    ok: reportOk(errors),
    repaired:
      errors.some((item) => item.repaired === true) ||
      warnings.some((item) => item.repaired === true) ||
      canvasReports.some((report) => report.repaired),
    errors,
    warnings,
    canvasReports
  };
}
