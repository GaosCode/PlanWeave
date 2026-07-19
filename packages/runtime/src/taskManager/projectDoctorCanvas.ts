import { isAbsolute, join, relative } from "node:path";
import { ZodError } from "zod";
import { optionalStat } from "../fs/optionalFile.js";
import { compilePackageGraph } from "../graph/compileTaskGraph.js";
import { readJsonFile } from "../json.js";
import { findOrphanStateFromGraph } from "../package/orphans.js";
import { manifestSchema } from "../schema/manifest.js";
import { readState } from "../state.js";
import type {
  DoctorIssue,
  PlanPackageManifest,
  ProjectDoctorIssue,
  ProjectWorkspace,
  ValidationIssue
} from "../types.js";
import { validateDesktopLayout } from "../validation/desktopLayoutValidation.js";

export type ProjectDoctorCanvasDiagnostics = {
  errors: ProjectDoctorIssue[];
  warnings: ProjectDoctorIssue[];
  manifest: PlanPackageManifest | null;
};

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

function workspaceRelative(workspace: ProjectWorkspace, path: string): string {
  return toPosixPath(relative(workspace.workspaceRoot, path)) || ".";
}

function canvasIssuePath(
  workspace: ProjectWorkspace,
  manifest: PlanPackageManifest | null,
  path?: string
): string | undefined {
  if (!path) {
    return undefined;
  }
  if (isAbsolute(path)) {
    return workspaceRelative(workspace, path);
  }
  const [filePath, suffix] = path.split(":");
  if (filePath.startsWith("nodes/")) {
    return workspaceRelative(workspace, join(workspace.packageDir, filePath));
  }
  if (filePath.startsWith("desktop/")) {
    return suffix ? `${filePath}:${suffix}` : filePath;
  }
  const manifestNodeIds = new Set(manifest?.nodes.map((node) => node.id) ?? []);
  if (path === "nodes" || path === "edges" || manifestNodeIds.has(path) || path.includes(".")) {
    return `package/manifest.json:${path}`;
  }
  return path;
}

function canvasValidationDoctorIssue(
  canvasId: string,
  workspace: ProjectWorkspace,
  manifest: PlanPackageManifest | null,
  issue: ValidationIssue
): ProjectDoctorIssue {
  return {
    code: issue.code,
    message: issue.message,
    canvasId,
    path: canvasIssuePath(workspace, manifest, issue.path),
    source: "canvas_package"
  };
}

function canvasDoctorIssuePath(
  workspace: ProjectWorkspace,
  manifest: PlanPackageManifest | null,
  issue: DoctorIssue
): string | undefined {
  if (issue.path) {
    return canvasIssuePath(workspace, manifest, issue.path);
  }
  if (issue.code === "stale_current_ref") {
    return "state.json:currentRefs";
  }
  return undefined;
}

function orphanStateIssuePath(orphan: { taskId?: string; ref?: string }): string {
  if (orphan.taskId) {
    return `state.json:tasks.${orphan.taskId}`;
  }
  if (orphan.ref) {
    return `state.json:blocks.${orphan.ref}`;
  }
  return "state.json";
}

export function canvasDoctorIssue(
  canvasId: string,
  workspace: ProjectWorkspace,
  manifest: PlanPackageManifest | null,
  issue: DoctorIssue
): ProjectDoctorIssue {
  return {
    code: issue.code,
    message: issue.message,
    canvasId,
    path: canvasDoctorIssuePath(workspace, manifest, issue),
    ...(issue.transitionId ? { transitionId: issue.transitionId } : {}),
    repaired: issue.repaired,
    ref: issue.ref,
    taskId: issue.taskId,
    stateRunId: issue.stateRunId,
    indexRunId: issue.indexRunId,
    source: "canvas_doctor"
  };
}

export function canvasWorkspaceIssue(
  canvasId: string,
  path: string,
  error: unknown
): ProjectDoctorIssue {
  return {
    code: "canvas_workspace_invalid",
    message: error instanceof Error ? error.message : String(error),
    canvasId,
    path,
    source: "project_graph"
  };
}

export async function validateCanvasPackageForDoctor(options: {
  canvasId: string;
  workspace: ProjectWorkspace;
}): Promise<ProjectDoctorCanvasDiagnostics> {
  const errors: ProjectDoctorIssue[] = [];
  const warnings: ProjectDoctorIssue[] = [];
  const { canvasId, workspace } = options;

  try {
    if (!(await optionalStat(workspace.workspaceRoot))) {
      errors.push({
        code: "workspace_missing",
        message: "PlanWeave workspace does not exist.",
        canvasId,
        path: ".",
        source: "canvas_package"
      });
      return { errors, warnings, manifest: null };
    }
  } catch (error) {
    errors.push({
      code: "workspace_read_failed",
      message: error instanceof Error ? error.message : String(error),
      canvasId,
      path: ".",
      source: "canvas_package"
    });
    return { errors, warnings, manifest: null };
  }
  try {
    if (!(await optionalStat(workspace.manifestFile))) {
      errors.push({
        code: "manifest_missing",
        message: "package/manifest.json does not exist.",
        canvasId,
        path: "package/manifest.json",
        source: "canvas_package"
      });
      return { errors, warnings, manifest: null };
    }
  } catch (error) {
    errors.push({
      code: "manifest_read_failed",
      message: error instanceof Error ? error.message : String(error),
      canvasId,
      path: "package/manifest.json",
      source: "canvas_package"
    });
    return { errors, warnings, manifest: null };
  }

  let manifest: PlanPackageManifest;
  try {
    manifest = manifestSchema.parse(await readJsonFile<unknown>(workspace.manifestFile));
  } catch (error) {
    if (error instanceof ZodError) {
      for (const zodIssue of error.issues) {
        errors.push({
          code: "manifest_schema",
          message: zodIssue.message,
          canvasId,
          path:
            zodIssue.path.length > 0
              ? `package/manifest.json:${zodIssue.path.join(".")}`
              : "package/manifest.json",
          source: "canvas_package"
        });
      }
    } else {
      errors.push({
        code: "manifest_read_failed",
        message: error instanceof Error ? error.message : String(error),
        canvasId,
        path: "package/manifest.json",
        source: "canvas_package"
      });
    }
    return { errors, warnings, manifest: null };
  }

  const graph = await compilePackageGraph(manifest, workspace.packageDir);
  errors.push(
    ...graph.diagnostics.errors.map((item) =>
      canvasValidationDoctorIssue(canvasId, workspace, manifest, item)
    )
  );
  warnings.push(
    ...graph.diagnostics.warnings.map((item) =>
      canvasValidationDoctorIssue(canvasId, workspace, manifest, item)
    )
  );
  const layoutReport = await validateDesktopLayout(workspace, manifest);
  errors.push(
    ...layoutReport.errors.map((item) =>
      canvasValidationDoctorIssue(canvasId, workspace, manifest, item)
    )
  );
  warnings.push(
    ...layoutReport.warnings.map((item) =>
      canvasValidationDoctorIssue(canvasId, workspace, manifest, item)
    )
  );

  try {
    const rawState = await readState(workspace.stateFile);
    for (const orphan of findOrphanStateFromGraph(graph, rawState)) {
      warnings.push({
        code: "orphan_state",
        message: "Runtime state exists outside the current manifest.",
        canvasId,
        path: orphanStateIssuePath(orphan),
        ref: orphan.ref,
        taskId: orphan.taskId,
        source: "canvas_package"
      });
    }
  } catch (error) {
    errors.push({
      code: "state_read_failed",
      message: error instanceof Error ? error.message : String(error),
      canvasId,
      path: workspaceRelative(workspace, workspace.stateFile),
      source: "canvas_package"
    });
  }

  return { errors, warnings, manifest };
}

export function uniqueProjectDoctorIssues(issues: ProjectDoctorIssue[]): ProjectDoctorIssue[] {
  const seen = new Set<string>();
  const unique: ProjectDoctorIssue[] = [];
  for (const issue of issues) {
    const key = [
      issue.source,
      issue.canvasId ?? "",
      issue.code,
      issue.path ?? "",
      issue.ref ?? "",
      issue.taskId ?? "",
      issue.transitionId ?? "",
      issue.stateRunId ?? "",
      issue.indexRunId ?? ""
    ].join("\u0000");
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(issue);
    }
  }
  return unique;
}
