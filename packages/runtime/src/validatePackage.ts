import { isAbsolute, join, relative } from "node:path";
import { ZodError } from "zod";
import { optionalStat } from "./fs/optionalFile.js";
import { compilePackageGraph } from "./graph/compileTaskGraph.js";
import { readJsonFile } from "./json.js";
import { findOrphanResultsFromGraph, findOrphanStateFromGraph } from "./package/orphans.js";
import { validatePackageStorageIdentityFiles } from "./package/packageStorageIdentity.js";
import { locateProjectWorkspace } from "./project.js";
import {
  compileProjectGraph,
  detectDefaultCanvasWorkspaceMigration,
  projectCanvasWorkspace,
  type CompiledProjectGraph,
  type LoadedProjectGraph,
  type ProjectCanvasNode
} from "./projectGraph/index.js";
import {
  LegacyProjectGraphSourceReadError,
  loadProjectGraphWithLegacySourceContext
} from "./projectGraph/loadProjectGraph.js";
import { ProjectCanvasWorkspacePathError } from "./projectGraph/projectGraphWorkspace.js";
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

function prefixPackageIssue(
  projectWorkspace: ProjectWorkspace,
  workspace: ProjectWorkspace,
  validationIssue: ValidationIssue
): ValidationIssue {
  const { code, path } = validationIssue;
  if (!path) {
    return validationIssue;
  }
  if (code.startsWith("prompt_") || code === "stale_prompt_reference") {
    return {
      ...validationIssue,
      path: workspaceRelative(projectWorkspace, join(workspace.packageDir, path))
    };
  }
  return {
    ...validationIssue,
    path: `${workspaceRelative(projectWorkspace, workspace.manifestFile)}:${path}`
  };
}

function prefixLayoutIssue(
  projectWorkspace: ProjectWorkspace,
  workspace: ProjectWorkspace,
  validationIssue: ValidationIssue
): ValidationIssue {
  const { path } = validationIssue;
  if (!path) {
    return validationIssue;
  }
  const separator = path.indexOf(":");
  const filePath = separator === -1 ? path : path.slice(0, separator);
  const suffix = separator === -1 ? "" : path.slice(separator);
  return {
    ...validationIssue,
    path: `${workspaceRelative(projectWorkspace, join(workspace.workspaceRoot, filePath))}${suffix}`
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

function canvasSourcePath(loaded: LoadedProjectGraph, field: string): string {
  if (loaded.source === "legacy_registry") {
    return `desktop/canvases.json:${field}`;
  }
  return projectGraphIssuePath(field);
}

function resolveValidationCanvasWorkspace(
  loaded: LoadedProjectGraph,
  canvas: ProjectCanvasNode,
  index: number,
  errors: ValidationIssue[]
): ProjectWorkspace | null {
  try {
    return projectCanvasWorkspace(loaded.workspace, canvas);
  } catch (error) {
    if (!(error instanceof ProjectCanvasWorkspacePathError)) {
      throw error;
    }
    errors.push(
      issue(
        "project_canvas_workspace_invalid",
        `Canvas '${canvas.id}': ${error.message}`,
        canvasSourcePath(loaded, `canvases.${index}`)
      )
    );
    return null;
  }
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

function legacyRootDefaultGraph(paths: {
  packageDir: string;
  stateFile: string;
  resultsDir: string;
}) {
  return {
    version: "plan-project/v1" as const,
    canvases: [
      {
        id: "default",
        type: "canvas" as const,
        title: "任务画布",
        packageDir: paths.packageDir,
        stateFile: paths.stateFile,
        resultsDir: paths.resultsDir
      }
    ],
    edges: [],
    crossTaskEdges: []
  };
}

function graphWithLegacyRootDefaultCanvas(
  loaded: LoadedProjectGraph,
  paths: { packageDir: string; stateFile: string; resultsDir: string }
): LoadedProjectGraph {
  const legacyDefault = legacyRootDefaultGraph(paths).canvases[0];
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
  for (const error of await validatePackageStorageIdentityFiles(workspace)) {
    errors.push({ ...error, path: error.path && workspaceRelative(projectWorkspace, error.path) });
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

  let graph: Awaited<ReturnType<typeof compilePackageGraph>>;
  try {
    graph = await compilePackageGraph(manifest, workspace.packageDir);
  } catch (error) {
    errors.push(
      issue(
        "package_graph_compile_failed",
        error instanceof Error ? error.message : String(error),
        workspaceRelative(projectWorkspace, workspace.manifestFile)
      )
    );
    return { errors, warnings };
  }
  errors.push(
    ...graph.diagnostics.errors.map((item) => prefixPackageIssue(projectWorkspace, workspace, item))
  );
  warnings.push(
    ...graph.diagnostics.warnings.map((item) =>
      prefixPackageIssue(projectWorkspace, workspace, item)
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
    ...layoutReport.errors.map((item) => prefixLayoutIssue(projectWorkspace, workspace, item))
  );
  warnings.push(
    ...layoutReport.warnings.map((item) => prefixLayoutIssue(projectWorkspace, workspace, item))
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
  canvasId?: string;
}): Promise<ValidationReport> {
  if (typeof options.projectRoot !== "string") {
    const projectWorkspace = await locateProjectWorkspace(
      options.projectRoot.rootPath,
      options.projectRoot.planweaveHome
    );
    const report = await validateWorkspacePackage(projectWorkspace, options.projectRoot);
    return validationReport(report.errors, report.warnings);
  }

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const workspace = await locateProjectWorkspace(options.projectRoot);
  let loaded: LoadedProjectGraph;
  try {
    loaded = await loadProjectGraphWithLegacySourceContext(workspace);
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
    } else if (error instanceof LegacyProjectGraphSourceReadError) {
      errors.push(
        issue(
          error.source === "default_manifest"
            ? "manifest_read_failed"
            : "project_graph_read_failed",
          error.message,
          workspaceRelative(workspace, error.path)
        )
      );
    } else {
      errors.push(
        issue(
          "project_graph_read_failed",
          error instanceof Error ? error.message : String(error),
          "project-graph.json"
        )
      );
    }
    return validationReport(errors, warnings);
  }

  if (options.canvasId !== undefined) {
    const index = loaded.manifest.canvases.findIndex((canvas) => canvas.id === options.canvasId);
    if (index === -1) {
      errors.push(
        issue(
          "project_canvas_missing",
          `Task canvas '${options.canvasId}' does not exist.`,
          canvasSourcePath(loaded, "canvases")
        )
      );
      return validationReport(errors, warnings);
    }
    const selected = resolveValidationCanvasWorkspace(
      loaded,
      loaded.manifest.canvases[index],
      index,
      errors
    );
    if (!selected) {
      return validationReport(errors, warnings);
    }
    const report = await validateWorkspacePackage(workspace, selected);
    return validationReport(report.errors, report.warnings);
  }

  const canvasWorkspaces = new Map(
    loaded.manifest.canvases.map((canvas, index) => [
      canvas,
      resolveValidationCanvasWorkspace(loaded, canvas, index, errors)
    ])
  );
  const defaultCanvas = loaded.manifest.canvases.find((canvas) => canvas.id === "default");
  let migrationPlan: Awaited<ReturnType<typeof detectDefaultCanvasWorkspaceMigration>> | undefined;
  if (!defaultCanvas || canvasWorkspaces.get(defaultCanvas)) {
    try {
      migrationPlan = await detectDefaultCanvasWorkspaceMigration(workspace, {
        ...loaded,
        manifest: {
          ...loaded.manifest,
          canvases: loaded.manifest.canvases.filter((canvas) => canvasWorkspaces.get(canvas))
        }
      });
    } catch (error) {
      errors.push(
        issue(
          "default_canvas_migration_read_failed",
          error instanceof Error ? error.message : String(error),
          "."
        )
      );
    }
  }
  if (migrationPlan?.action === "conflict") {
    errors.push(...migrationPlan.diagnostics);
  }
  const canonicalDefaultMissingWithLegacyRoot = hasCanonicalDefaultCanvasMissingWithLegacyRoot(
    loaded,
    migrationPlan?.action ?? "unavailable"
  );
  if (canonicalDefaultMissingWithLegacyRoot) {
    errors.push(
      issue(
        "default_canvas_canonical_missing_legacy_root_present",
        "project-graph.json points at the canonical default canvas, but canonical data is missing while legacy root default canvas data exists. Run 'planweave project-graph migrate' or restore canonical files.",
        "project-graph.json:canvases"
      )
    );
  } else if (migrationPlan?.action === "migrate" || migrationPlan?.action === "mixed_identical") {
    warnings.push(...migrationPlan.diagnostics);
  }
  const graphInput =
    loaded.source === "legacy_default_canvas" && migrationPlan?.action === "migrate"
      ? graphWithLegacyRootDefaultCanvas(loaded, migrationPlan.legacyPaths)
      : canonicalDefaultMissingWithLegacyRoot
        ? graphWithoutCanonicalDefaultCanvas(loaded)
        : loaded;
  let graph: CompiledProjectGraph | undefined;
  try {
    graph = await compileProjectGraph(graphInput);
  } catch (error) {
    errors.push(
      issue(
        "project_graph_compile_failed",
        error instanceof Error ? error.message : String(error),
        "project-graph.json"
      )
    );
  }

  const seenPackageDirs = new Set<string>();
  const workspaceReports: Array<{ errors: ValidationIssue[]; warnings: ValidationIssue[] }> = [];
  for (const canvas of graphInput.manifest.canvases) {
    const resolved = canvasWorkspaces.get(canvas);
    if (resolved === null) {
      continue;
    }
    const canvasWorkspace = resolved ?? projectCanvasWorkspace(loaded.workspace, canvas);
    if (seenPackageDirs.has(canvasWorkspace.packageDir)) {
      continue;
    }
    seenPackageDirs.add(canvasWorkspace.packageDir);
    workspaceReports.push(await validateWorkspacePackage(workspace, canvasWorkspace));
  }

  if (graph) {
    for (const diagnostic of graph.diagnostics.errors) {
      if (diagnostic.code !== "project_canvas_workspace_invalid") {
        errors.push(
          diagnostic.code === "project_canvas_manifest_read_failed"
            ? diagnostic
            : prefixProjectGraphIssue(diagnostic)
        );
      }
    }
    warnings.push(...graph.diagnostics.warnings.map(prefixProjectGraphIssue));
  }
  for (const report of workspaceReports) {
    errors.push(...report.errors);
    warnings.push(...report.warnings);
  }

  return validationReport(errors, warnings);
}
