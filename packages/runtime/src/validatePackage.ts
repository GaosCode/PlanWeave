import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { ZodError } from "zod";
import { validateDesktopLayout } from "./desktop/layoutApi.js";
import { compilePackageGraph } from "./graph/compileTaskGraph.js";
import { readJsonFile } from "./json.js";
import { findOrphanResults, findOrphanState } from "./package/orphans.js";
import { resolveProjectWorkspace } from "./project.js";
import { compileProjectGraph, loadProjectGraph, projectCanvasWorkspace } from "./projectGraph/index.js";
import { manifestSchema } from "./schema/manifest.js";
import { readState } from "./state.js";
import type { PlanPackageManifest, ProjectWorkspace, ValidationIssue, ValidationReport } from "./types.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, path };
}

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

function workspaceRelative(projectWorkspace: ProjectWorkspace, path: string): string {
  const absolutePath = isAbsolute(path) ? path : join(projectWorkspace.workspaceRoot, path);
  return toPosixPath(relative(projectWorkspace.workspaceRoot, absolutePath));
}

function prefixIssuePath(projectWorkspace: ProjectWorkspace, workspace: ProjectWorkspace, manifest: PlanPackageManifest, path?: string): string | undefined {
  if (!path) {
    return undefined;
  }
  if (isAbsolute(path)) {
    return workspaceRelative(projectWorkspace, path);
  }
  const manifestNodeIds = new Set(manifest.nodes.map((node) => node.id));
  const [filePath, suffix] = path.split(":");
  if (filePath.startsWith("desktop/")) {
    const prefixed = workspaceRelative(projectWorkspace, join(workspace.workspaceRoot, filePath));
    return suffix ? `${prefixed}:${suffix}` : prefixed;
  }
  if (path.startsWith("nodes/")) {
    return workspaceRelative(projectWorkspace, join(workspace.packageDir, path));
  }
  if (path === "nodes" || path === "edges" || manifestNodeIds.has(path) || path.includes(".")) {
    return `${workspaceRelative(projectWorkspace, workspace.manifestFile)}:${path}`;
  }
  return path;
}

function prefixIssue(projectWorkspace: ProjectWorkspace, workspace: ProjectWorkspace, manifest: PlanPackageManifest, validationIssue: ValidationIssue): ValidationIssue {
  return {
    ...validationIssue,
    path: prefixIssuePath(projectWorkspace, workspace, manifest, validationIssue.path)
  };
}

function projectGraphIssuePath(path?: string): string {
  if (!path || path === "project-graph.json") {
    return "project-graph.json";
  }
  return `project-graph.json:${path}`;
}

function prefixProjectGraphIssue(validationIssue: ValidationIssue): ValidationIssue {
  return {
    ...validationIssue,
    path: projectGraphIssuePath(validationIssue.path)
  };
}

async function validateWorkspacePackage(projectWorkspace: ProjectWorkspace, workspace: ProjectWorkspace): Promise<{
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!(await exists(workspace.workspaceRoot))) {
    errors.push(issue("workspace_missing", "PlanWeave workspace does not exist.", workspaceRelative(projectWorkspace, workspace.workspaceRoot)));
    return { errors, warnings };
  }
  if (!(await exists(workspace.manifestFile))) {
    errors.push(issue("manifest_missing", "package/manifest.json does not exist.", workspaceRelative(projectWorkspace, workspace.manifestFile)));
    return { errors, warnings };
  }

  let manifest: PlanPackageManifest;
  try {
    manifest = manifestSchema.parse(await readJsonFile<unknown>(workspace.manifestFile)) as PlanPackageManifest;
  } catch (error) {
    if (error instanceof ZodError) {
      for (const zodIssue of error.issues) {
        const path = zodIssue.path.length > 0 ? `${workspaceRelative(projectWorkspace, workspace.manifestFile)}:${zodIssue.path.join(".")}` : workspaceRelative(projectWorkspace, workspace.manifestFile);
        errors.push(issue("manifest_schema", zodIssue.message, path));
      }
    } else {
      errors.push(issue("manifest_read_failed", error instanceof Error ? error.message : String(error), workspaceRelative(projectWorkspace, workspace.manifestFile)));
    }
    return { errors, warnings };
  }

  const graph = await compilePackageGraph(manifest, workspace.packageDir);
  errors.push(...graph.diagnostics.errors.map((item) => prefixIssue(projectWorkspace, workspace, manifest, item)));
  warnings.push(...graph.diagnostics.warnings.map((item) => prefixIssue(projectWorkspace, workspace, manifest, item)));
  const layoutReport = await validateDesktopLayout(workspace, manifest);
  errors.push(...layoutReport.errors.map((item) => prefixIssue(projectWorkspace, workspace, manifest, item)));
  warnings.push(...layoutReport.warnings.map((item) => prefixIssue(projectWorkspace, workspace, manifest, item)));

  const rawState = await readState(workspace.stateFile);
  for (const orphan of findOrphanState(manifest, rawState)) {
    warnings.push(issue("orphan_state", `Runtime state exists outside the current manifest.`, orphan.taskId ?? orphan.ref));
  }
  for (const orphan of await findOrphanResults(workspace, manifest)) {
    warnings.push(issue("orphan_result", `Results exist for task '${orphan.taskId}' outside the current manifest.`, orphan.path));
  }

  return { errors, warnings };
}

export async function validatePackage(options: { projectRoot: string }): Promise<ValidationReport> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const workspace = await resolveProjectWorkspace(options.projectRoot);
  const seenPackageDirs = new Set<string>();
  const workspaceReports: Array<{ errors: ValidationIssue[]; warnings: ValidationIssue[] }> = [];

  try {
    const loaded = await loadProjectGraph(options.projectRoot);
    const graph = await compileProjectGraph(loaded);
    errors.push(...graph.diagnostics.errors.map(prefixProjectGraphIssue));
    warnings.push(...graph.diagnostics.warnings.map(prefixProjectGraphIssue));
    for (const canvasId of graph.canvasIdsInOrder) {
      const canvas = graph.canvasesById.get(canvasId);
      if (!canvas) {
        continue;
      }
      const canvasWorkspace = projectCanvasWorkspace(loaded.workspace, canvas);
      if (seenPackageDirs.has(canvasWorkspace.packageDir)) {
        continue;
      }
      seenPackageDirs.add(canvasWorkspace.packageDir);
      workspaceReports.push(await validateWorkspacePackage(workspace, canvasWorkspace));
    }
  } catch (error) {
    if (error instanceof ZodError) {
      for (const zodIssue of error.issues) {
        errors.push(issue("project_graph_schema", zodIssue.message, projectGraphIssuePath(zodIssue.path.join("."))));
      }
    } else {
      errors.push(issue("project_graph_read_failed", error instanceof Error ? error.message : String(error), "project-graph.json"));
    }
  }

  for (const report of workspaceReports) {
    errors.push(...report.errors);
    warnings.push(...report.warnings);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings
  };
}
