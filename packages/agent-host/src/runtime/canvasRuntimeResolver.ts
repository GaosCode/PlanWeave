import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createEmptyState,
  projectWorkspacePaths,
  resolveProjectWorkspace,
  type ProjectWorkspace
} from "@planweave-ai/runtime";
import type { CanvasRuntimeLogicalScope } from "@planweave-ai/agent-host-protocol";
import type { AgentHostConfig } from "../config/schema.js";

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export class CanvasRuntimeResolutionError extends Error {
  constructor(
    readonly code:
      | "runtime_project_not_configured"
      | "runtime_project_missing"
      | "runtime_project_escape"
      | "runtime_project_identity_mismatch"
      | "runtime_canvas_not_found"
  ) {
    super(code);
    this.name = "CanvasRuntimeResolutionError";
  }
}

export type ResolvedCanvasRuntime = {
  scope: CanvasRuntimeLogicalScope;
  project: ProjectWorkspace;
  canvas: ProjectWorkspace;
};

export interface CanvasRuntimeResolverPort {
  configured(): boolean;
  mappings(): AgentHostConfig["runtimeProjects"];
  resolveProject(workspaceId: string, projectId: string): Promise<ProjectWorkspace>;
  resolve(scope: CanvasRuntimeLogicalScope): Promise<ResolvedCanvasRuntime>;
}

export class ConfiguredCanvasRuntimeResolver implements CanvasRuntimeResolverPort {
  constructor(private readonly config: AgentHostConfig) {}

  configured(): boolean {
    return this.config.runtimeProjects.length > 0;
  }

  mappings(): AgentHostConfig["runtimeProjects"] {
    return this.config.runtimeProjects;
  }

  async resolveProject(workspaceId: string, projectId: string): Promise<ProjectWorkspace> {
    const mapping = this.config.runtimeProjects.find(
      (candidate) => candidate.workspaceId === workspaceId && candidate.projectId === projectId
    );
    if (!mapping) throw new CanvasRuntimeResolutionError("runtime_project_not_configured");
    let root: string;
    let projectRoot: string;
    try {
      root = await realpath(this.config.workspaceRoot);
      projectRoot = await realpath(resolve(root, mapping.path));
    } catch {
      throw new CanvasRuntimeResolutionError("runtime_project_missing");
    }
    if (!contained(root, projectRoot)) {
      throw new CanvasRuntimeResolutionError("runtime_project_escape");
    }
    let project: ProjectWorkspace;
    try {
      project = await resolveProjectWorkspace(projectRoot);
    } catch {
      throw new CanvasRuntimeResolutionError("runtime_project_identity_mismatch");
    }
    let resolvedProjectRoot: string;
    try {
      resolvedProjectRoot = await realpath(project.rootPath);
    } catch {
      throw new CanvasRuntimeResolutionError("runtime_project_identity_mismatch");
    }
    if (project.id !== projectId || resolvedProjectRoot !== projectRoot) {
      throw new CanvasRuntimeResolutionError("runtime_project_identity_mismatch");
    }
    return project;
  }

  async resolve(scope: CanvasRuntimeLogicalScope): Promise<ResolvedCanvasRuntime> {
    const project = await this.resolveProject(scope.workspaceId, scope.projectId);
    await mkdir(this.config.dataDirectory, { recursive: true, mode: 0o700 });
    const dataDirectoryRoot = await realpath(this.config.dataDirectory);
    const runtimeCanvasesRoot = resolve(dataDirectoryRoot, "runtime-canvases");
    await this.ensureManagedDirectory(runtimeCanvasesRoot);
    let managedRoot = runtimeCanvasesRoot;
    for (const segment of [scope.workspaceId, scope.projectId, scope.canvasId]) {
      managedRoot = join(managedRoot, segment);
      if (!contained(runtimeCanvasesRoot, managedRoot)) {
        throw new CanvasRuntimeResolutionError("runtime_project_escape");
      }
      await this.ensureManagedDirectory(managedRoot);
    }
    const [resolvedRuntimeRoot, resolvedManagedRoot] = await Promise.all([
      realpath(runtimeCanvasesRoot),
      realpath(managedRoot)
    ]);
    if (!contained(resolvedRuntimeRoot, resolvedManagedRoot)) {
      throw new CanvasRuntimeResolutionError("runtime_project_escape");
    }
    const baseCanvas = projectWorkspacePaths({
      id: scope.projectId,
      kind: "managed",
      rootPath: managedRoot,
      sourceRoot: project.rootPath,
      planweaveHome: this.config.dataDirectory,
      workspaceRoot: managedRoot
    });
    const canvas: ProjectWorkspace = {
      ...baseCanvas,
      packageDir: join(managedRoot, "package"),
      manifestFile: join(managedRoot, "package", "manifest.json"),
      stateFile: join(managedRoot, "state.json"),
      resultsDir: join(managedRoot, "results"),
      projectPromptFile: join(managedRoot, "policy", "project-prompt.md")
    };
    await this.ensureManagedCanvas(canvas);
    return { scope, project, canvas };
  }

  private async ensureManagedCanvas(canvas: ProjectWorkspace): Promise<void> {
    await this.ensureManagedDirectory(canvas.packageDir);
    await this.ensureManagedDirectory(canvas.resultsDir);
    await this.ensureManagedDirectory(dirname(canvas.projectPromptFile));
    await this.writeOnce(canvas.stateFile, `${JSON.stringify(createEmptyState(), null, 2)}\n`);
    await this.writeOnce(canvas.projectPromptFile, "# Project Prompt\n");
  }

  private async ensureManagedDirectory(path: string): Promise<void> {
    try {
      const entry = await lstat(path);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new CanvasRuntimeResolutionError("runtime_project_escape");
      }
      return;
    } catch (error) {
      if (error instanceof CanvasRuntimeResolutionError) throw error;
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
    }
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new CanvasRuntimeResolutionError("runtime_project_escape");
    }
  }

  private async writeOnce(path: string, content: string): Promise<void> {
    try {
      await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
      const entry = await lstat(path);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new CanvasRuntimeResolutionError("runtime_project_escape");
      }
      await readFile(path, "utf8");
    }
  }
}
