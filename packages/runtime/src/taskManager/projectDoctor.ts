import { ZodError } from "zod";
import { compileProjectGraph, loadProjectGraph, projectCanvasWorkspace } from "../projectGraph/index.js";
import type { ProjectDoctorCanvasReport, ProjectDoctorIssue, ProjectDoctorReport, ProjectWorkspace, ValidationIssue } from "../types.js";
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

export async function runProjectDoctor(options: { projectRoot: string; repair?: boolean }): Promise<ProjectDoctorReport> {
  let loaded: Awaited<ReturnType<typeof loadProjectGraph>>;
  try {
    loaded = await loadProjectGraph(options.projectRoot);
  } catch (error) {
    return { ok: false, repaired: false, errors: projectGraphReadErrors(error), warnings: [], canvasReports: [] };
  }

  const graph = await compileProjectGraph(loaded);
  const projectErrors = uniqueProjectDoctorIssues(graph.diagnostics.errors.map(projectGraphDoctorIssue));
  const projectWarnings = uniqueProjectDoctorIssues(graph.diagnostics.warnings.map(projectGraphDoctorIssue));
  const canvasReports: ProjectDoctorCanvasReport[] = [];

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

    const validation = await validateCanvasPackageForDoctor({ canvasId, workspace });
    let doctorErrors: ProjectDoctorIssue[] = [];
    if (validation.manifest) {
      try {
        const report = await runDoctor({ projectRoot: workspace, repair: options.repair });
        doctorErrors = report.issues.map((item) => canvasDoctorIssue(canvasId, workspace, validation.manifest, item));
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
    const warnings = uniqueProjectDoctorIssues(validation.warnings);
    canvasReports.push({
      canvasId,
      ok: reportOk(errors),
      repaired: errors.some((item) => item.repaired === true),
      errors,
      warnings
    });
  }

  const errors = uniqueProjectDoctorIssues([...projectErrors, ...canvasReports.flatMap((report) => report.errors)]);
  const warnings = uniqueProjectDoctorIssues([...projectWarnings, ...canvasReports.flatMap((report) => report.warnings)]);
  return {
    ok: reportOk(errors),
    repaired: canvasReports.some((report) => report.repaired),
    errors,
    warnings,
    canvasReports
  };
}
