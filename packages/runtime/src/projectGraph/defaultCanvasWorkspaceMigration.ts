import { cp, mkdir, readFile, rename } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { optionalReaddir, optionalStat } from "../fs/optionalFile.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import type { ProjectWorkspace, ValidationIssue } from "../types.js";
import { normalizeRegistry } from "../desktop/canvasRegistry.js";
import { manifestSchema } from "../schema/manifest.js";
import { canonicalCanvasWorkspacePaths, canonicalProjectCanvasNode } from "./canonicalWorkspace.js";
import { projectGraphFromLegacyRegistry } from "./migration.js";
import { projectGraphManifestSchema } from "./schema.js";
import { supportedProjectGraphVersion, type ProjectGraphManifest } from "./types.js";

const defaultCanvasId = "default";
const ignoredFileNames = new Set([".DS_Store", "Thumbs.db"]);

type WorkspaceSnapshot = {
  hasMeaningfulFiles: boolean;
  files: Map<string, string>;
};

export type DefaultCanvasWorkspacePaths = {
  workspaceRoot: string;
  packageDir: string;
  stateFile: string;
  resultsDir: string;
};

export type DefaultCanvasWorkspaceMigrationAction = "none" | "migrate" | "mixed_identical" | "conflict";

export type DefaultCanvasWorkspaceMigrationPlan = {
  action: DefaultCanvasWorkspaceMigrationAction;
  reason: string;
  legacyPaths: DefaultCanvasWorkspacePaths;
  canonicalPaths: DefaultCanvasWorkspacePaths;
  legacyFiles: string[];
  canonicalFiles: string[];
  diagnostics: ValidationIssue[];
};

export type DefaultCanvasWorkspaceMigrationApplyResult = DefaultCanvasWorkspaceMigrationPlan & {
  projectGraphPath: string;
  legacyBackupPaths: Partial<DefaultCanvasWorkspacePaths> & { workspaceRoot?: string };
};

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, path };
}

export function legacyDefaultCanvasWorkspacePaths(projectWorkspace: ProjectWorkspace): DefaultCanvasWorkspacePaths {
  return {
    workspaceRoot: projectWorkspace.workspaceRoot,
    packageDir: join(projectWorkspace.workspaceRoot, "package"),
    stateFile: join(projectWorkspace.workspaceRoot, "state.json"),
    resultsDir: join(projectWorkspace.workspaceRoot, "results")
  };
}

export function canonicalDefaultCanvasWorkspacePaths(projectWorkspace: ProjectWorkspace): DefaultCanvasWorkspacePaths {
  const paths = canonicalCanvasWorkspacePaths(defaultCanvasId);
  const workspaceRoot = join(projectWorkspace.workspaceRoot, "canvases", defaultCanvasId);
  return {
    workspaceRoot,
    packageDir: join(projectWorkspace.workspaceRoot, paths.packageDir),
    stateFile: join(projectWorkspace.workspaceRoot, paths.stateFile),
    resultsDir: join(projectWorkspace.workspaceRoot, paths.resultsDir)
  };
}

function projectGraphPath(projectWorkspace: ProjectWorkspace): string {
  return join(projectWorkspace.workspaceRoot, "project-graph.json");
}

function workspaceRelative(projectWorkspace: ProjectWorkspace, path: string): string {
  return relative(projectWorkspace.workspaceRoot, path).split("\\").join("/");
}

function isIgnoredPath(path: string): boolean {
  return path.split(/[\\/]/).some((part) => ignoredFileNames.has(part));
}

async function collectDirectoryFiles(root: string, prefix: string, files: Map<string, string>): Promise<void> {
  if (!(await optionalStat(root))) {
    return;
  }
  const entries = await optionalReaddir(root, { withFileTypes: true });
  if (!entries) {
    return;
  }
  for (const entry of entries) {
    const absolutePath = join(root, entry.name);
    const relativePath = join(prefix, entry.name).split("\\").join("/");
    if (isIgnoredPath(relativePath)) {
      continue;
    }
    if (entry.isDirectory()) {
      await collectDirectoryFiles(absolutePath, relativePath, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    files.set(relativePath, await normalizedFileContent(absolutePath));
  }
}

async function normalizedFileContent(path: string): Promise<string> {
  const raw = await readFile(path);
  if (extname(path) === ".json") {
    try {
      return `json:${JSON.stringify(JSON.parse(raw.toString("utf8")))}`;
    } catch {
      return `raw:${raw.toString("base64")}`;
    }
  }
  return `raw:${raw.toString("base64")}`;
}

async function collectSnapshot(paths: DefaultCanvasWorkspacePaths): Promise<WorkspaceSnapshot> {
  const files = new Map<string, string>();
  await collectDirectoryFiles(paths.packageDir, "package", files);
  if ((await optionalStat(paths.stateFile)) && !isIgnoredPath(basename(paths.stateFile))) {
    files.set("state.json", await normalizedFileContent(paths.stateFile));
  }
  await collectDirectoryFiles(paths.resultsDir, "results", files);
  return {
    hasMeaningfulFiles: files.size > 0,
    files
  };
}

function snapshotsEqual(left: WorkspaceSnapshot, right: WorkspaceSnapshot): boolean {
  if (left.files.size !== right.files.size) {
    return false;
  }
  for (const [path, value] of left.files) {
    if (right.files.get(path) !== value) {
      return false;
    }
  }
  return true;
}

function sortedKeys(files: Map<string, string>): string[] {
  return [...files.keys()].sort();
}

function detectDiagnostics(input: {
  projectWorkspace: ProjectWorkspace;
  legacy: WorkspaceSnapshot;
  canonical: WorkspaceSnapshot;
  action: DefaultCanvasWorkspaceMigrationAction;
}): ValidationIssue[] {
  const legacyPath = workspaceRelative(input.projectWorkspace, legacyDefaultCanvasWorkspacePaths(input.projectWorkspace).packageDir);
  const canonicalPath = workspaceRelative(input.projectWorkspace, canonicalDefaultCanvasWorkspacePaths(input.projectWorkspace).workspaceRoot);
  if (input.action === "migrate") {
    return [
      issue(
        "default_canvas_legacy_root_layout",
        `Legacy root default canvas data exists at '${legacyPath}' and should be migrated explicitly to '${canonicalPath}'.`,
        legacyPath
      )
    ];
  }
  if (input.action === "mixed_identical") {
    return [
      issue(
        "default_canvas_legacy_root_redundant",
        `Legacy root default canvas data duplicates canonical default canvas data and can be quarantined by an explicit migration.`,
        legacyPath
      )
    ];
  }
  if (input.action === "conflict") {
    return [
      issue(
        "default_canvas_legacy_root_conflict",
        `Legacy root default canvas data and canonical default canvas data both exist but do not match. Resolve the conflict before migration.`,
        legacyPath
      )
    ];
  }
  return [];
}

export async function detectDefaultCanvasWorkspaceMigration(projectWorkspace: ProjectWorkspace): Promise<DefaultCanvasWorkspaceMigrationPlan> {
  const legacyPaths = legacyDefaultCanvasWorkspacePaths(projectWorkspace);
  const canonicalPaths = canonicalDefaultCanvasWorkspacePaths(projectWorkspace);
  const legacy = await collectSnapshot(legacyPaths);
  const canonical = await collectSnapshot(canonicalPaths);
  let action: DefaultCanvasWorkspaceMigrationAction = "none";
  let reason = "No legacy root default canvas data exists.";

  if (legacy.hasMeaningfulFiles && !canonical.hasMeaningfulFiles) {
    action = "migrate";
    reason = "Legacy root default canvas data exists and canonical default canvas data is empty.";
  } else if (legacy.hasMeaningfulFiles && canonical.hasMeaningfulFiles && snapshotsEqual(legacy, canonical)) {
    action = "mixed_identical";
    reason = "Legacy root default canvas data matches canonical default canvas data.";
  } else if (legacy.hasMeaningfulFiles && canonical.hasMeaningfulFiles) {
    action = "conflict";
    reason = "Legacy root default canvas data differs from canonical default canvas data.";
  } else if (canonical.hasMeaningfulFiles) {
    reason = "Canonical default canvas data exists and no legacy root data exists.";
  }

  return {
    action,
    reason,
    legacyPaths,
    canonicalPaths,
    legacyFiles: sortedKeys(legacy.files),
    canonicalFiles: sortedKeys(canonical.files),
    diagnostics: detectDiagnostics({ projectWorkspace, legacy, canonical, action })
  };
}

async function defaultCanvasTitle(paths: DefaultCanvasWorkspacePaths): Promise<string> {
  try {
    const raw = await readJsonFile<unknown>(join(paths.packageDir, "manifest.json"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const project = (raw as { project?: unknown }).project;
      if (project && typeof project === "object" && !Array.isArray(project)) {
        const title = (project as { title?: unknown }).title;
        if (typeof title === "string" && title.trim()) {
          return title.trim();
        }
      }
    }
  } catch {
    return "任务画布";
  }
  return "任务画布";
}

async function readProjectGraph(projectWorkspace: ProjectWorkspace, title: string): Promise<ProjectGraphManifest> {
  const path = projectGraphPath(projectWorkspace);
  if (await optionalStat(path)) {
    return projectGraphManifestSchema.parse(await readJsonFile<unknown>(path)) as ProjectGraphManifest;
  }
  const registryPath = join(projectWorkspace.workspaceRoot, "desktop", "canvases.json");
  if (await optionalStat(registryPath)) {
    return projectGraphFromLegacyRegistry(normalizeRegistry(await readJsonFile<unknown>(registryPath)));
  }
  return {
    version: supportedProjectGraphVersion,
    canvases: [canonicalProjectCanvasNode({ id: defaultCanvasId, title })],
    edges: [],
    crossTaskEdges: []
  };
}

async function writeCanonicalProjectGraph(projectWorkspace: ProjectWorkspace, title: string): Promise<void> {
  const graph = await readProjectGraph(projectWorkspace, title);
  const defaultCanvas = graph.canvases.find((canvas) => canvas.id === defaultCanvasId);
  const nextDefaultCanvas = canonicalProjectCanvasNode({
    id: defaultCanvasId,
    title: defaultCanvas?.title ?? title,
    ...(defaultCanvas?.description ? { description: defaultCanvas.description } : {})
  });
  const nextCanvases = defaultCanvas
    ? graph.canvases.map((canvas) => (canvas.id === defaultCanvasId ? nextDefaultCanvas : canvas))
    : [nextDefaultCanvas, ...graph.canvases];
  const nextGraph = projectGraphManifestSchema.parse({
    ...graph,
    canvases: nextCanvases
  }) as ProjectGraphManifest;
  await writeJsonFile(projectGraphPath(projectWorkspace), nextGraph);
}

async function copyIfExists(from: string, to: string, options?: { recursive?: boolean }): Promise<void> {
  if (!(await optionalStat(from))) {
    return;
  }
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: options?.recursive ?? false, force: true });
}

async function verifyCanonical(paths: DefaultCanvasWorkspacePaths): Promise<void> {
  const rawManifest = await readJsonFile<unknown>(join(paths.packageDir, "manifest.json"));
  manifestSchema.parse(rawManifest);
  if (await optionalStat(paths.stateFile)) {
    await readJsonFile<unknown>(paths.stateFile);
  }
  if (await optionalStat(paths.resultsDir)) {
    await optionalReaddir(paths.resultsDir, { withFileTypes: true });
  }
}

async function quarantineLegacyPaths(projectWorkspace: ProjectWorkspace, legacyPaths: DefaultCanvasWorkspacePaths): Promise<Partial<DefaultCanvasWorkspacePaths> & { workspaceRoot?: string }> {
  const quarantineRoot = join(projectWorkspace.workspaceRoot, "migration-quarantine", `default-canvas-root-${Date.now()}`);
  const backupPaths: Partial<DefaultCanvasWorkspacePaths> & { workspaceRoot?: string } = {};
  await mkdir(quarantineRoot, { recursive: true });
  if (await optionalStat(legacyPaths.packageDir)) {
    backupPaths.packageDir = join(quarantineRoot, "package");
    await rename(legacyPaths.packageDir, backupPaths.packageDir);
  }
  if (await optionalStat(legacyPaths.stateFile)) {
    backupPaths.stateFile = join(quarantineRoot, "state.json");
    await rename(legacyPaths.stateFile, backupPaths.stateFile);
  }
  if (await optionalStat(legacyPaths.resultsDir)) {
    backupPaths.resultsDir = join(quarantineRoot, "results");
    await rename(legacyPaths.resultsDir, backupPaths.resultsDir);
  }
  if (backupPaths.packageDir || backupPaths.stateFile || backupPaths.resultsDir) {
    backupPaths.workspaceRoot = quarantineRoot;
  }
  return backupPaths;
}

export async function applyDefaultCanvasWorkspaceMigration(projectWorkspace: ProjectWorkspace): Promise<DefaultCanvasWorkspaceMigrationApplyResult> {
  const plan = await detectDefaultCanvasWorkspaceMigration(projectWorkspace);
  if (plan.action === "none") {
    return {
      ...plan,
      projectGraphPath: projectGraphPath(projectWorkspace),
      legacyBackupPaths: {}
    };
  }
  if (plan.action === "conflict") {
    throw new Error(plan.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("\n"));
  }

  if (plan.action === "migrate") {
    await copyIfExists(plan.legacyPaths.packageDir, plan.canonicalPaths.packageDir, { recursive: true });
    await copyIfExists(plan.legacyPaths.stateFile, plan.canonicalPaths.stateFile);
    await copyIfExists(plan.legacyPaths.resultsDir, plan.canonicalPaths.resultsDir, { recursive: true });
  }

  await verifyCanonical(plan.canonicalPaths);
  await writeCanonicalProjectGraph(projectWorkspace, await defaultCanvasTitle(plan.canonicalPaths));
  const legacyBackupPaths = await quarantineLegacyPaths(projectWorkspace, plan.legacyPaths);
  return {
    ...plan,
    projectGraphPath: projectGraphPath(projectWorkspace),
    legacyBackupPaths
  };
}
