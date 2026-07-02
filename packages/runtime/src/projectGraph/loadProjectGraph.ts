import { join } from "node:path";
import { optionalStat } from "../fs/optionalFile.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { projectWorkspacePaths, resolveProjectWorkspace } from "../project.js";
import type { ProjectWorkspace, ValidationIssue } from "../types.js";
import { normalizeRegistry } from "../desktop/canvasRegistry.js";
import { defaultCanvasProjectGraph, projectGraphFromLegacyRegistry } from "./migration.js";
import { projectGraphManifestSchema } from "./schema.js";
import type { LoadedProjectGraph, ProjectGraphManifest } from "./types.js";

const defaultCanvasId = "default";

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, path };
}

export function projectGraphPath(workspace: ProjectWorkspace): string {
  return join(workspace.workspaceRoot, "project-graph.json");
}

function projectGraphWorkspace(workspace: ProjectWorkspace): ProjectWorkspace {
  const workspaceRoot = join(workspace.planweaveHome, "projects", workspace.id);
  return projectWorkspacePaths({
    id: workspace.id,
    kind: workspace.kind,
    rootPath: workspace.rootPath,
    sourceRoot: workspace.sourceRoot,
    planweaveHome: workspace.planweaveHome,
    workspaceRoot,
  });
}

async function manifestTitle(manifestFile: string): Promise<string> {
  try {
    const raw = await readJsonFile<unknown>(manifestFile);
    if (raw && typeof raw === "object" && !Array.isArray(raw) && "project" in raw) {
      const project = (raw as { project?: unknown }).project;
      if (project && typeof project === "object" && !Array.isArray(project) && typeof (project as { title?: unknown }).title === "string") {
        return (project as { title: string }).title.trim() || "任务画布";
      }
    }
  } catch (error) {
    void error;
    return "任务画布";
  }
  return "任务画布";
}

async function defaultProjectGraph(workspace: ProjectWorkspace): Promise<ProjectGraphManifest> {
  return defaultCanvasProjectGraph(await manifestTitle(workspace.manifestFile));
}

async function legacyProjectGraph(workspace: ProjectWorkspace): Promise<ProjectGraphManifest> {
  const registryFile = join(workspace.workspaceRoot, "desktop", "canvases.json");
  const registry = normalizeRegistry(await readJsonFile<unknown>(registryFile));
  return projectGraphFromLegacyRegistry(registry);
}

export async function loadProjectGraphForWorkspace(workspaceRef: ProjectWorkspace): Promise<LoadedProjectGraph> {
  const workspace = projectGraphWorkspace(workspaceRef);
  const path = projectGraphPath(workspace);
  if (await optionalStat(path)) {
    return {
      workspace,
      manifest: projectGraphManifestSchema.parse(await readJsonFile<unknown>(path)) as ProjectGraphManifest,
      source: "project_graph",
      diagnostics: []
    };
  }
  const registryFile = join(workspace.workspaceRoot, "desktop", "canvases.json");
  if (await optionalStat(registryFile)) {
    return {
      workspace,
      manifest: await legacyProjectGraph(workspace),
      source: "legacy_registry",
      diagnostics: [
        issue(
          "project_graph_missing_legacy_registry_used",
          "Project graph manifest is missing; derived canvas graph from legacy desktop canvas registry.",
          "project-graph.json"
        )
      ]
    };
  }
  return {
    workspace,
    manifest: await defaultProjectGraph(workspace),
    source: "legacy_default_canvas",
    diagnostics: [
      issue(
        "project_graph_missing_default_canvas_used",
        "Project graph manifest is missing; derived canvas graph from the default package workspace.",
        "project-graph.json"
      )
    ]
  };
}

export async function loadProjectGraph(projectRoot: string): Promise<LoadedProjectGraph> {
  return loadProjectGraphForWorkspace(await resolveProjectWorkspace(projectRoot));
}

export async function writeProjectGraph(workspace: ProjectWorkspace, manifest: ProjectGraphManifest): Promise<ProjectGraphManifest> {
  const parsed = projectGraphManifestSchema.parse(manifest) as ProjectGraphManifest;
  await writeJsonFile(projectGraphPath(workspace), parsed);
  return parsed;
}
