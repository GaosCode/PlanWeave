import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  resolveProjectWorkspace,
  resolveTaskCanvasWorkspace,
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
    let canvas: ProjectWorkspace;
    try {
      canvas = await resolveTaskCanvasWorkspace(project.rootPath, scope.canvasId);
    } catch {
      throw new CanvasRuntimeResolutionError("runtime_canvas_not_found");
    }
    let projectWorkspaceRoot: string;
    let canvasWorkspaceRoot: string;
    try {
      projectWorkspaceRoot = await realpath(project.workspaceRoot);
      canvasWorkspaceRoot = await realpath(canvas.workspaceRoot);
    } catch {
      throw new CanvasRuntimeResolutionError("runtime_canvas_not_found");
    }
    if (!contained(projectWorkspaceRoot, canvasWorkspaceRoot)) {
      throw new CanvasRuntimeResolutionError("runtime_project_escape");
    }
    return { scope, project, canvas };
  }
}
