import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ZodError } from "zod";
import { optionalReadFile, optionalStat } from "../fs/optionalFile.js";
import { compilePackageGraph } from "../graph/compileTaskGraph.js";
import { validateGraphQuality } from "../graph/validateGraphQuality.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { resolvePlanweaveHome } from "../paths.js";
import { requireInitializedProjectWorkspace } from "../project.js";
import {
  compileProjectGraph,
  loadProjectGraph,
  projectCanvasWorkspace,
  projectGraphManifestSchema,
  projectGraphPath,
  type ProjectCanvasNode,
  type ProjectGraphManifest
} from "../projectGraph/index.js";
import { manifestSchema } from "../schema/manifest.js";
import { createEmptyState } from "../state.js";
import { summarizeValidationReport } from "../validation/validationSummary.js";
import type {
  GraphQualityReport,
  PlanPackageManifest,
  ProjectWorkspace,
  ValidationIssue,
  ValidationReport
} from "../types.js";

export type PackageDraftMode = "single-canvas" | "project";

export type PackageDraftCanvasReport = {
  canvasId: string | null;
  packageDir: string;
  validation: ValidationReport;
  graphQuality: GraphQualityReport | null;
  fileCount: number;
};

export type PackageDraftValidationResult = {
  ok: boolean;
  draftRoot: string;
  mode: PackageDraftMode | null;
  validation: ValidationReport;
  canvases: PackageDraftCanvasReport[];
};

export type PackageDraftFileDiff = {
  path: string;
  type: "added" | "changed" | "removed" | "unchanged";
};

export type PackageDraftImportEffect = {
  type: "replace_package" | "reset_state" | "reset_results" | "write_project_graph" | "remove_canvas";
  path: string;
};

export type PackageDraftImportPreview = PackageDraftValidationResult & {
  target: {
    projectRoot: string;
    canvasId: string | null;
  };
  fileDiffs: PackageDraftFileDiff[];
  effects: PackageDraftImportEffect[];
  summary: {
    fileCount: number;
    added: number;
    changed: number;
    removed: number;
    unchanged: number;
  };
};

export type PackageDraftImportApplyResult = PackageDraftImportPreview & {
  applied: boolean;
};

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, path };
}

function validationReport(errors: ValidationIssue[], warnings: ValidationIssue[] = []): ValidationReport {
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: summarizeValidationReport(errors, warnings)
  };
}

function zodIssues(error: ZodError, code: string, prefix: string): ValidationIssue[] {
  return error.issues.map((zodIssue) => {
    const suffix = zodIssue.path.length > 0 ? `:${zodIssue.path.join(".")}` : "";
    return issue(code, zodIssue.message, `${prefix}${suffix}`);
  });
}

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

function emptyStateContent(): string {
  return `${JSON.stringify(createEmptyState(), null, 2)}\n`;
}

function isInside(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), resolve(target));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function draftWorkspace(draftRoot: string, packageDir: string): ProjectWorkspace {
  const id = basename(draftRoot) || "package-draft";
  return {
    id,
    kind: "managed",
    rootPath: draftRoot,
    sourceRoot: null,
    planweaveHome: resolvePlanweaveHome(),
    workspaceRoot: draftRoot,
    projectFile: join(draftRoot, "project.json"),
    packageDir,
    manifestFile: join(packageDir, "manifest.json"),
    stateFile: join(dirname(packageDir), "state.json"),
    resultsDir: join(dirname(packageDir), "results"),
    projectPromptFile: join(draftRoot, "policy", "project-prompt.md")
  };
}

function deriveCanvasId(packageDir: string): string | null {
  const parts = packageDir.split(sep);
  const packageIndex = parts.length - 1;
  if (parts[packageIndex] !== "package" || packageIndex < 2 || parts[packageIndex - 2] !== "canvases") {
    return null;
  }
  return parts[packageIndex - 1] ?? null;
}

async function countFiles(root: string): Promise<number> {
  const files: string[] = [];
  await visitFiles(root, root, files);
  return files.length;
}

async function visitFiles(root: string, dir: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await visitFiles(root, path, files);
    } else if (entry.isFile()) {
      files.push(toPosix(relative(root, path)));
    }
  }
}

async function readFileMap(root: string, prefix = ""): Promise<Map<string, string>> {
  const paths: string[] = [];
  if (!(await optionalStat(root))) {
    return new Map();
  }
  await visitFiles(root, root, paths);
  const files = new Map<string, string>();
  for (const path of paths) {
    files.set(toPosix(join(prefix, path)), await readFile(join(root, path), "utf8"));
  }
  return files;
}

async function readFilePathSet(root: string, prefix = ""): Promise<Set<string>> {
  const paths: string[] = [];
  if (!(await optionalStat(root))) {
    return new Set();
  }
  await visitFiles(root, root, paths);
  return new Set(paths.map((path) => toPosix(join(prefix, path))));
}

function workspacePath(workspace: ProjectWorkspace, absolutePath: string): string {
  return toPosix(relative(workspace.workspaceRoot, absolutePath));
}

function addEntries(target: Map<string, string>, entries: Map<string, string>): void {
  for (const [path, content] of entries) {
    target.set(path, content);
  }
}

async function addOptionalFile(target: Map<string, string>, path: string, absolutePath: string): Promise<void> {
  const content = await optionalReadFile(absolutePath, "utf8");
  if (content !== null) {
    target.set(path, content);
  }
}

async function addRemovalOnlyFiles(target: Map<string, string>, root: string, prefix: string): Promise<void> {
  for (const path of await readFilePathSet(root, prefix)) {
    target.set(path, "");
  }
}

function mergeReports(reports: ValidationReport[]): ValidationReport {
  return validationReport(
    reports.flatMap((report) => report.errors),
    reports.flatMap((report) => report.warnings)
  );
}

async function validateCanvasWorkspace(canvasId: string | null, workspace: ProjectWorkspace): Promise<PackageDraftCanvasReport> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  let manifest: PlanPackageManifest | null = null;
  try {
    manifest = manifestSchema.parse(await readJsonFile<unknown>(workspace.manifestFile)) as PlanPackageManifest;
  } catch (error) {
    if (error instanceof ZodError) {
      errors.push(...zodIssues(error, "manifest_schema", canvasId ? `${canvasId}/manifest.json` : "manifest.json"));
    } else {
      errors.push(issue("manifest_read_failed", error instanceof Error ? error.message : String(error), canvasId ? `${canvasId}/manifest.json` : "manifest.json"));
    }
  }

  let graphQuality: GraphQualityReport | null = null;
  if (manifest) {
    const graph = await compilePackageGraph(manifest, workspace.packageDir);
    errors.push(...graph.diagnostics.errors);
    warnings.push(...graph.diagnostics.warnings);
    graphQuality = await validateGraphQuality({ projectRoot: workspace });
  }

  return {
    canvasId,
    packageDir: workspace.packageDir,
    validation: validationReport(errors, warnings),
    graphQuality,
    fileCount: (await optionalStat(workspace.packageDir)) ? await countFiles(workspace.packageDir) : 0
  };
}

async function loadDraftProjectGraph(draftRoot: string): Promise<ProjectGraphManifest | null> {
  const path = join(draftRoot, "project-graph.json");
  if (!(await optionalStat(path))) {
    return null;
  }
  return projectGraphManifestSchema.parse(await readJsonFile<unknown>(path)) as ProjectGraphManifest;
}

export async function validatePackageDraft(options: { draftRoot: string }): Promise<PackageDraftValidationResult> {
  const draftRoot = resolve(options.draftRoot);
  const rootErrors: ValidationIssue[] = [];
  const rootWarnings: ValidationIssue[] = [];
  const canvases: PackageDraftCanvasReport[] = [];
  let mode: PackageDraftMode | null = null;

  if (!(await optionalStat(draftRoot))) {
    const validation = validationReport([issue("draft_root_missing", "Package draft root does not exist.", ".")]);
    return { ok: false, draftRoot, mode: null, validation, canvases };
  }

  try {
    const projectGraph = await loadDraftProjectGraph(draftRoot);
    if (projectGraph) {
      mode = "project";
      const workspace = draftWorkspace(draftRoot, draftRoot);
      const projectGraphReport = await compileProjectGraph({
        workspace,
        manifest: projectGraph,
        source: "project_graph",
        diagnostics: []
      });
      rootErrors.push(...projectGraphReport.diagnostics.errors);
      rootWarnings.push(...projectGraphReport.diagnostics.warnings);
      for (const canvas of projectGraph.canvases) {
        const canvasWorkspace = projectCanvasWorkspace(workspace, canvas);
        canvases.push(await validateCanvasWorkspace(canvas.id, canvasWorkspace));
      }
    } else if (await optionalStat(join(draftRoot, "manifest.json"))) {
      mode = "single-canvas";
      canvases.push(await validateCanvasWorkspace(null, draftWorkspace(draftRoot, draftRoot)));
    } else {
      rootErrors.push(issue("draft_root_invalid", "Package draft root must contain manifest.json or project-graph.json.", "."));
    }
  } catch (error) {
    if (error instanceof ZodError) {
      rootErrors.push(...zodIssues(error, "project_graph_schema", "project-graph.json"));
    } else {
      rootErrors.push(issue("draft_read_failed", error instanceof Error ? error.message : String(error), "."));
    }
  }

  const validation = mergeReports([validationReport(rootErrors, rootWarnings), ...canvases.map((canvas) => canvas.validation)]);
  const qualityErrorCount = canvases.reduce((count, canvas) => count + (canvas.graphQuality?.summary.errorCount ?? 0), 0);
  return {
    ok: validation.ok && qualityErrorCount === 0,
    draftRoot,
    mode,
    validation,
    canvases
  };
}

function compareFileMaps(draft: Map<string, string>, target: Map<string, string>): PackageDraftFileDiff[] {
  const paths = [...new Set([...draft.keys(), ...target.keys()])].sort((left, right) => left.localeCompare(right));
  return paths.map((path) => {
    if (!draft.has(path)) {
      return { path, type: "removed" };
    }
    if (!target.has(path)) {
      return { path, type: "added" };
    }
    return { path, type: draft.get(path) === target.get(path) ? "unchanged" : "changed" };
  });
}

type PackageDraftImportPlan = {
  projectWorkspace: ProjectWorkspace;
  sourceFiles: Map<string, string>;
  targetFiles: Map<string, string>;
  effects: PackageDraftImportEffect[];
  resolvedCanvasId: string | null;
  removedCanvases: ProjectCanvasNode[];
};

async function singleCanvasImportPlan(projectRoot: string, draftRoot: string, canvasId?: string | null): Promise<PackageDraftImportPlan> {
  const projectWorkspace = await requireInitializedProjectWorkspace(projectRoot);
  const { resolveTaskCanvasWorkspace } = await import("../desktop/canvasApi.js");
  const canvasWorkspace = await resolveTaskCanvasWorkspace(projectRoot, canvasId);
  const sourceFiles = new Map<string, string>();
  const targetFiles = new Map<string, string>();
  addEntries(sourceFiles, await readFileMap(draftRoot, "package"));
  sourceFiles.set("state.json", emptyStateContent());
  addEntries(targetFiles, await readFileMap(canvasWorkspace.packageDir, "package"));
  await addOptionalFile(targetFiles, "state.json", canvasWorkspace.stateFile);
  await addRemovalOnlyFiles(targetFiles, canvasWorkspace.resultsDir, "results");
  return {
    projectWorkspace,
    sourceFiles,
    targetFiles,
    effects: [
      { type: "replace_package", path: "package" },
      { type: "reset_state", path: "state.json" },
      { type: "reset_results", path: "results" }
    ],
    resolvedCanvasId: canvasId ?? deriveCanvasId(canvasWorkspace.packageDir),
    removedCanvases: []
  };
}

async function projectImportPlan(projectRoot: string, draftRoot: string): Promise<PackageDraftImportPlan> {
  const projectWorkspace = await requireInitializedProjectWorkspace(projectRoot);
  const projectGraph = await loadDraftProjectGraph(draftRoot);
  if (!projectGraph) {
    throw new Error("Project package draft requires project-graph.json.");
  }
  const sourceFiles = new Map<string, string>();
  const targetFiles = new Map<string, string>();
  const effects: PackageDraftImportEffect[] = [{ type: "write_project_graph", path: "project-graph.json" }];
  sourceFiles.set("project-graph.json", await readFile(join(draftRoot, "project-graph.json"), "utf8"));
  await addOptionalFile(targetFiles, "project-graph.json", projectGraphPath(projectWorkspace));

  for (const canvas of projectGraph.canvases) {
    const sourcePackageDir = resolve(draftRoot, canvas.packageDir);
    if (!isInside(draftRoot, sourcePackageDir)) {
      throw new Error(`Draft canvas packageDir '${canvas.packageDir}' is outside draftRoot.`);
    }
    const targetWorkspace = projectCanvasWorkspace(projectWorkspace, canvas);
    const packagePrefix = workspacePath(projectWorkspace, targetWorkspace.packageDir);
    addEntries(sourceFiles, await readFileMap(sourcePackageDir, packagePrefix));
    sourceFiles.set(workspacePath(projectWorkspace, targetWorkspace.stateFile), emptyStateContent());
    addEntries(targetFiles, await readFileMap(targetWorkspace.packageDir, packagePrefix));
    await addOptionalFile(targetFiles, workspacePath(projectWorkspace, targetWorkspace.stateFile), targetWorkspace.stateFile);
    await addRemovalOnlyFiles(targetFiles, targetWorkspace.resultsDir, workspacePath(projectWorkspace, targetWorkspace.resultsDir));
    effects.push(
      { type: "replace_package", path: packagePrefix },
      { type: "reset_state", path: workspacePath(projectWorkspace, targetWorkspace.stateFile) },
      { type: "reset_results", path: workspacePath(projectWorkspace, targetWorkspace.resultsDir) }
    );
  }

  const currentProjectGraph = await loadProjectGraph(projectRoot);
  const nextCanvasIds = new Set(projectGraph.canvases.map((canvas) => canvas.id));
  const removedCanvases = currentProjectGraph.manifest.canvases.filter((canvas) => !nextCanvasIds.has(canvas.id));
  for (const canvas of removedCanvases) {
    const targetWorkspace = projectCanvasWorkspace(projectWorkspace, canvas);
    await addRemovalOnlyFiles(targetFiles, targetWorkspace.packageDir, workspacePath(projectWorkspace, targetWorkspace.packageDir));
    await addOptionalFile(targetFiles, workspacePath(projectWorkspace, targetWorkspace.stateFile), targetWorkspace.stateFile);
    await addRemovalOnlyFiles(targetFiles, targetWorkspace.resultsDir, workspacePath(projectWorkspace, targetWorkspace.resultsDir));
    effects.push({ type: "remove_canvas", path: canvas.id });
  }

  return {
    projectWorkspace,
    sourceFiles,
    targetFiles,
    effects,
    resolvedCanvasId: null,
    removedCanvases
  };
}

async function importPlan(result: PackageDraftValidationResult, projectRoot: string, canvasId?: string | null): Promise<PackageDraftImportPlan | null> {
  if (result.mode === "single-canvas") {
    return singleCanvasImportPlan(projectRoot, result.draftRoot, canvasId);
  }
  if (result.mode === "project") {
    return projectImportPlan(projectRoot, result.draftRoot);
  }
  return null;
}

export async function previewPackageDraftImport(options: {
  draftRoot: string;
  projectRoot: string;
  canvasId?: string | null;
}): Promise<PackageDraftImportPreview> {
  const result = await validatePackageDraft({ draftRoot: options.draftRoot });
  const plan = await importPlan(result, options.projectRoot, options.canvasId);
  const fileDiffs = plan ? compareFileMaps(plan.sourceFiles, plan.targetFiles) : [];
  const summary = {
    fileCount: fileDiffs.length,
    added: fileDiffs.filter((diff) => diff.type === "added").length,
    changed: fileDiffs.filter((diff) => diff.type === "changed").length,
    removed: fileDiffs.filter((diff) => diff.type === "removed").length,
    unchanged: fileDiffs.filter((diff) => diff.type === "unchanged").length
  };
  return {
    ...result,
    target: {
      projectRoot: options.projectRoot,
      canvasId: plan?.resolvedCanvasId ?? null
    },
    fileDiffs,
    effects: plan?.effects ?? [],
    summary
  };
}

async function replacePathWithBackup(target: string, staged: string, backupRoot: string, key: string, changed: string[]): Promise<void> {
  const backup = join(backupRoot, key);
  await mkdir(dirname(backup), { recursive: true });
  let backedUp = false;
  if (await optionalStat(target)) {
    await rename(target, backup);
    backedUp = true;
    changed.push(target);
  }
  await mkdir(dirname(target), { recursive: true });
  await rename(staged, target);
  if (!backedUp) {
    changed.push(target);
  }
}

async function removePathWithBackup(target: string, backupRoot: string, key: string, changed: string[]): Promise<void> {
  if (!(await optionalStat(target))) {
    return;
  }
  const backup = join(backupRoot, key);
  await mkdir(dirname(backup), { recursive: true });
  await rename(target, backup);
  changed.push(target);
}

async function rollbackChangedPaths(changed: string[], backupRoot: string): Promise<void> {
  for (const target of changed.reverse()) {
    const key = target.replace(/[:/\\]/g, "_");
    const backup = join(backupRoot, key);
    await rm(target, { recursive: true, force: true });
    if (await optionalStat(backup)) {
      await mkdir(dirname(target), { recursive: true });
      await rename(backup, target);
    }
  }
}

async function applySingleCanvasDraft(options: { draftRoot: string; projectRoot: string; canvasId?: string | null }): Promise<void> {
  const { resolveTaskCanvasWorkspace } = await import("../desktop/canvasApi.js");
  const workspace = await resolveTaskCanvasWorkspace(options.projectRoot, options.canvasId);
  const tempRoot = await mkdtemp(join(tmpdir(), "planweave-package-import-"));
  const backupRoot = join(tempRoot, "backup");
  const stagedPackage = join(tempRoot, "package");
  const stagedState = join(tempRoot, "state.json");
  const stagedResults = join(tempRoot, "results");
  const changed: string[] = [];
  try {
    await cp(resolve(options.draftRoot), stagedPackage, { recursive: true });
    await writeJsonFile(stagedState, createEmptyState());
    await mkdir(stagedResults, { recursive: true });
    await replacePathWithBackup(workspace.packageDir, stagedPackage, backupRoot, workspace.packageDir.replace(/[:/\\]/g, "_"), changed);
    await replacePathWithBackup(workspace.stateFile, stagedState, backupRoot, workspace.stateFile.replace(/[:/\\]/g, "_"), changed);
    await replacePathWithBackup(workspace.resultsDir, stagedResults, backupRoot, workspace.resultsDir.replace(/[:/\\]/g, "_"), changed);
  } catch (error) {
    await rollbackChangedPaths(changed, backupRoot);
    throw error;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function applyProjectDraft(options: { draftRoot: string; projectRoot: string }): Promise<void> {
  const plan = await projectImportPlan(options.projectRoot, resolve(options.draftRoot));
  const projectWorkspace = plan.projectWorkspace;
  const projectGraph = await loadDraftProjectGraph(resolve(options.draftRoot));
  if (!projectGraph) {
    throw new Error("Project package draft requires project-graph.json.");
  }
  const tempRoot = await mkdtemp(join(tmpdir(), "planweave-project-import-"));
  const backupRoot = join(tempRoot, "backup");
  const stagedGraph = join(tempRoot, "project-graph.json");
  const changed: string[] = [];
  try {
    await writeTextFile(stagedGraph, await readFile(join(resolve(options.draftRoot), "project-graph.json"), "utf8"));
    await replacePathWithBackup(projectGraphPath(projectWorkspace), stagedGraph, backupRoot, projectGraphPath(projectWorkspace).replace(/[:/\\]/g, "_"), changed);
    for (const canvas of projectGraph.canvases) {
      const sourcePackageDir = resolve(options.draftRoot, canvas.packageDir);
      if (!isInside(resolve(options.draftRoot), sourcePackageDir)) {
        throw new Error(`Draft canvas packageDir '${canvas.packageDir}' is outside draftRoot.`);
      }
      const targetWorkspace = projectCanvasWorkspace(projectWorkspace, canvas);
      const stagedPackage = join(tempRoot, "packages", canvas.id);
      const stagedState = join(tempRoot, "state", `${canvas.id}.json`);
      const stagedResults = join(tempRoot, "results", canvas.id);
      await cp(sourcePackageDir, stagedPackage, { recursive: true });
      await writeJsonFile(stagedState, createEmptyState());
      await mkdir(stagedResults, { recursive: true });
      await replacePathWithBackup(targetWorkspace.packageDir, stagedPackage, backupRoot, targetWorkspace.packageDir.replace(/[:/\\]/g, "_"), changed);
      await replacePathWithBackup(targetWorkspace.stateFile, stagedState, backupRoot, targetWorkspace.stateFile.replace(/[:/\\]/g, "_"), changed);
      await replacePathWithBackup(targetWorkspace.resultsDir, stagedResults, backupRoot, targetWorkspace.resultsDir.replace(/[:/\\]/g, "_"), changed);
    }
    for (const canvas of plan.removedCanvases) {
      const targetWorkspace = projectCanvasWorkspace(projectWorkspace, canvas);
      await removePathWithBackup(targetWorkspace.packageDir, backupRoot, targetWorkspace.packageDir.replace(/[:/\\]/g, "_"), changed);
      await removePathWithBackup(targetWorkspace.stateFile, backupRoot, targetWorkspace.stateFile.replace(/[:/\\]/g, "_"), changed);
      await removePathWithBackup(targetWorkspace.resultsDir, backupRoot, targetWorkspace.resultsDir.replace(/[:/\\]/g, "_"), changed);
    }
  } catch (error) {
    await rollbackChangedPaths(changed, backupRoot);
    throw error;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function applyPackageDraftImport(options: {
  draftRoot: string;
  projectRoot: string;
  canvasId?: string | null;
}): Promise<PackageDraftImportApplyResult> {
  const preview = await previewPackageDraftImport(options);
  if (!preview.ok || preview.mode === null) {
    return { ...preview, applied: false };
  }
  if (preview.mode === "single-canvas") {
    await applySingleCanvasDraft(options);
  } else {
    await applyProjectDraft({ draftRoot: options.draftRoot, projectRoot: options.projectRoot });
  }
  return { ...preview, applied: true };
}
