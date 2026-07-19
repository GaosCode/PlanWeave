import { isAbsolute, join, relative } from "node:path";
import { ZodError } from "zod";
import { optionalStat } from "./fs/optionalFile.js";
import { compilePackageGraph } from "./graph/compileTaskGraph.js";
import { readJsonFile } from "./json.js";
import { findOrphanResultsFromGraph, findOrphanStateFromGraph } from "./package/orphans.js";
import { resolveProjectWorkspace } from "./project.js";
import {
  canonicalDefaultCanvasWorkspacePaths,
  compileProjectGraph,
  detectDefaultCanvasWorkspaceMigration,
  legacyDefaultCanvasWorkspacePaths,
  loadProjectGraph,
  projectCanvasWorkspace
} from "./projectGraph/index.js";
import { manifestSchema } from "./schema/manifest.js";
import { isBuiltinExecutorName } from "./executorNames.js";
import { readState } from "./state.js";
import type {
  PackageWorkspaceRef,
  PlanPackageManifest,
  ProjectWorkspace,
  ValidationIssue,
  ValidationReport
} from "./types.js";
import { validateDesktopLayout } from "./validation/desktopLayoutValidation.js";
import { summarizeValidationReport } from "./validation/validationSummary.js";
import type { LoadedProjectGraph } from "./projectGraph/index.js";

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

function prefixIssuePath(
  projectWorkspace: ProjectWorkspace,
  workspace: ProjectWorkspace,
  manifest: PlanPackageManifest,
  path?: string
): string | undefined {
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

function prefixIssue(
  projectWorkspace: ProjectWorkspace,
  workspace: ProjectWorkspace,
  manifest: PlanPackageManifest,
  validationIssue: ValidationIssue
): ValidationIssue {
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

function isCanonicalDefaultCanvasPath(canvas: {
  packageDir: string;
  stateFile: string;
  resultsDir: string;
}): boolean {
  return (
    canvas.packageDir === "canvases/default/package" &&
    canvas.stateFile === "canvases/default/state.json" &&
    canvas.resultsDir === "canvases/default/results"
  );
}

function legacyRootDefaultGraph() {
  return {
    version: "plan-project/v1" as const,
    canvases: [
      {
        id: "default",
        type: "canvas" as const,
        title: "任务画布",
        packageDir: "package",
        stateFile: "state.json",
        resultsDir: "results"
      }
    ],
    edges: [],
    crossTaskEdges: []
  };
}

function graphWithLegacyRootDefaultCanvas(loaded: LoadedProjectGraph): LoadedProjectGraph {
  const legacyDefault = legacyRootDefaultGraph().canvases[0];
  const hasDefault = loaded.manifest.canvases.some((canvas) => canvas.id === "default");
  return {
    ...loaded,
    manifest: {
      ...loaded.manifest,
      canvases: hasDefault
        ? loaded.manifest.canvases.map((canvas) =>
            canvas.id === "default"
              ? { ...legacyDefault, title: canvas.title, description: canvas.description }
              : canvas
          )
        : [legacyDefault, ...loaded.manifest.canvases]
    }
  };
}

function hasCanonicalDefaultCanvasMissingWithLegacyRoot(
  loaded: LoadedProjectGraph,
  migrationAction: string
): boolean {
  return (
    loaded.source === "project_graph" &&
    migrationAction === "migrate" &&
    loaded.manifest.canvases.some(
      (canvas) => canvas.id === "default" && isCanonicalDefaultCanvasPath(canvas)
    )
  );
}

function graphWithoutCanonicalDefaultCanvas(loaded: LoadedProjectGraph): LoadedProjectGraph {
  const prunedCanvasIds = new Set(
    loaded.manifest.canvases
      .filter((canvas) => canvas.id === "default" && isCanonicalDefaultCanvasPath(canvas))
      .map((canvas) => canvas.id)
  );
  return {
    ...loaded,
    manifest: {
      ...loaded.manifest,
      canvases: loaded.manifest.canvases.filter((canvas) => !prunedCanvasIds.has(canvas.id)),
      edges: loaded.manifest.edges.filter(
        (edge) => !prunedCanvasIds.has(edge.from) && !prunedCanvasIds.has(edge.to)
      ),
      crossTaskEdges: loaded.manifest.crossTaskEdges.filter(
        (edge) => !prunedCanvasIds.has(edge.from.canvasId) && !prunedCanvasIds.has(edge.to.canvasId)
      )
    }
  };
}

async function validateWorkspacePackage(
  projectWorkspace: ProjectWorkspace,
  workspace: ProjectWorkspace
): Promise<{
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  try {
    if (!(await optionalStat(workspace.workspaceRoot))) {
      errors.push(
        issue(
          "workspace_missing",
          "PlanWeave workspace does not exist.",
          workspaceRelative(projectWorkspace, workspace.workspaceRoot)
        )
      );
      return { errors, warnings };
    }
  } catch (error) {
    errors.push(
      issue(
        "workspace_read_failed",
        error instanceof Error ? error.message : String(error),
        workspaceRelative(projectWorkspace, workspace.workspaceRoot)
      )
    );
    return { errors, warnings };
  }
  try {
    if (!(await optionalStat(workspace.manifestFile))) {
      errors.push(
        issue(
          "manifest_missing",
          "package/manifest.json does not exist.",
          workspaceRelative(projectWorkspace, workspace.manifestFile)
        )
      );
      return { errors, warnings };
    }
  } catch (error) {
    errors.push(
      issue(
        "manifest_read_failed",
        error instanceof Error ? error.message : String(error),
        workspaceRelative(projectWorkspace, workspace.manifestFile)
      )
    );
    return { errors, warnings };
  }

  let manifest: PlanPackageManifest;
  try {
    manifest = manifestSchema.parse(
      await readJsonFile<unknown>(workspace.manifestFile)
    ) as PlanPackageManifest;
  } catch (error) {
    if (error instanceof ZodError) {
      for (const zodIssue of error.issues) {
        const path =
          zodIssue.path.length > 0
            ? `${workspaceRelative(projectWorkspace, workspace.manifestFile)}:${zodIssue.path.join(".")}`
            : workspaceRelative(projectWorkspace, workspace.manifestFile);
        errors.push(issue("manifest_schema", zodIssue.message, path));
      }
    } else {
      errors.push(
        issue(
          "manifest_read_failed",
          error instanceof Error ? error.message : String(error),
          workspaceRelative(projectWorkspace, workspace.manifestFile)
        )
      );
    }
    return { errors, warnings };
  }

  const graph = await compilePackageGraph(manifest, workspace.packageDir);
  errors.push(
    ...graph.diagnostics.errors.map((item) =>
      prefixIssue(projectWorkspace, workspace, manifest, item)
    )
  );
  warnings.push(
    ...graph.diagnostics.warnings.map((item) =>
      prefixIssue(projectWorkspace, workspace, manifest, item)
    )
  );
  for (const name of Object.keys(manifest.executors ?? {})) {
    if (isBuiltinExecutorName(name)) {
      warnings.push(
        issue(
          "builtin_executor_override_ignored",
          `Package executor '${name}' cannot override the built-in executor and is ignored.`,
          `${workspaceRelative(projectWorkspace, workspace.manifestFile)}:executors.${name}`
        )
      );
    }
  }
  const layoutReport = await validateDesktopLayout(workspace, manifest);
  errors.push(
    ...layoutReport.errors.map((item) => prefixIssue(projectWorkspace, workspace, manifest, item))
  );
  warnings.push(
    ...layoutReport.warnings.map((item) => prefixIssue(projectWorkspace, workspace, manifest, item))
  );

  try {
    const rawState = await readState(workspace.stateFile);
    for (const orphan of findOrphanStateFromGraph(graph, rawState)) {
      warnings.push(
        issue(
          "orphan_state",
          `Runtime state exists outside the current manifest.`,
          orphan.taskId ?? orphan.ref
        )
      );
    }
  } catch (error) {
    errors.push(
      issue(
        "state_read_failed",
        error instanceof Error ? error.message : String(error),
        workspaceRelative(projectWorkspace, workspace.stateFile)
      )
    );
  }
  try {
    for (const orphan of await findOrphanResultsFromGraph(workspace, graph)) {
      warnings.push(
        issue(
          "orphan_result",
          `Results exist for task '${orphan.taskId}' outside the current manifest.`,
          orphan.path
        )
      );
    }
  } catch (error) {
    errors.push(
      issue(
        "results_read_failed",
        error instanceof Error ? error.message : String(error),
        workspaceRelative(projectWorkspace, workspace.resultsDir)
      )
    );
  }

  return { errors, warnings };
}

function validationReport(
  errors: ValidationIssue[],
  warnings: ValidationIssue[]
): ValidationReport {
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: summarizeValidationReport(errors, warnings)
  };
}

export async function validatePackage(options: {
  projectRoot: PackageWorkspaceRef;
}): Promise<ValidationReport> {
  if (typeof options.projectRoot !== "string") {
    const projectWorkspace = await resolveProjectWorkspace(options.projectRoot.rootPath);
    const report = await validateWorkspacePackage(projectWorkspace, options.projectRoot);
    return validationReport(report.errors, report.warnings);
  }

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const workspace = await resolveProjectWorkspace(options.projectRoot);
  let migrationPlan: Awaited<ReturnType<typeof detectDefaultCanvasWorkspaceMigration>>;
  try {
    migrationPlan = await detectDefaultCanvasWorkspaceMigration(workspace);
  } catch (error) {
    errors.push(
      issue(
        "default_canvas_migration_read_failed",
        error instanceof Error ? error.message : String(error),
        "."
      )
    );
    migrationPlan = {
      action: "none",
      reason: "Default canvas migration state could not be inspected.",
      legacyPaths: legacyDefaultCanvasWorkspacePaths(workspace),
      canonicalPaths: canonicalDefaultCanvasWorkspacePaths(workspace),
      legacyFiles: [],
      canonicalFiles: [],
      diagnostics: []
    };
  }
  if (migrationPlan.action === "conflict") {
    errors.push(...migrationPlan.diagnostics);
  }
  const seenPackageDirs = new Set<string>();
  const workspaceReports: Array<{ errors: ValidationIssue[]; warnings: ValidationIssue[] }> = [];

  try {
    const loaded = await loadProjectGraph(options.projectRoot);
    const canonicalDefaultMissingWithLegacyRoot = hasCanonicalDefaultCanvasMissingWithLegacyRoot(
      loaded,
      migrationPlan.action
    );
    if (canonicalDefaultMissingWithLegacyRoot) {
      errors.push(
        issue(
          "default_canvas_canonical_missing_legacy_root_present",
          "project-graph.json points at the canonical default canvas, but canonical data is missing while legacy root default canvas data exists. Run 'planweave project-graph migrate' or restore canonical files.",
          "project-graph.json:canvases"
        )
      );
    } else if (migrationPlan.action === "migrate" || migrationPlan.action === "mixed_identical") {
      warnings.push(...migrationPlan.diagnostics);
    }
    const graphInput =
      loaded.source !== "project_graph" && migrationPlan.action === "migrate"
        ? graphWithLegacyRootDefaultCanvas(loaded)
        : canonicalDefaultMissingWithLegacyRoot
          ? graphWithoutCanonicalDefaultCanvas(loaded)
          : loaded;
    const graph = await compileProjectGraph(graphInput);
    errors.push(...graph.diagnostics.errors.map(prefixProjectGraphIssue));
    warnings.push(...graph.diagnostics.warnings.map(prefixProjectGraphIssue));
    for (const canvasId of graph.canvasIdsInOrder) {
      const canvas = graph.canvasesById.get(canvasId);
      if (!canvas) {
        continue;
      }
      if (canvas.id === "default" && canonicalDefaultMissingWithLegacyRoot) {
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
        errors.push(
          issue(
            "project_graph_schema",
            zodIssue.message,
            projectGraphIssuePath(zodIssue.path.join("."))
          )
        );
      }
    } else {
      errors.push(
        issue(
          "project_graph_read_failed",
          error instanceof Error ? error.message : String(error),
          "project-graph.json"
        )
      );
    }
  }

  for (const report of workspaceReports) {
    errors.push(...report.errors);
    warnings.push(...report.warnings);
  }

  return validationReport(errors, warnings);
}
