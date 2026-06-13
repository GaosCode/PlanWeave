import type { ProjectWorkspace, ValidationIssue } from "../types.js";

export const supportedProjectGraphVersion = "plan-project/v1" as const;
export const projectGraphNodeTypes = ["canvas"] as const;
export const projectGraphEdgeTypes = ["depends_on"] as const;

export type ProjectGraphNodeType = (typeof projectGraphNodeTypes)[number];
export type ProjectGraphEdgeType = (typeof projectGraphEdgeTypes)[number];

export type ProjectCanvasNode = {
  id: string;
  type: "canvas";
  title: string;
  description?: string;
  packageDir: string;
  stateFile: string;
  resultsDir: string;
};

export type ProjectCanvasEdge = {
  from: string;
  to: string;
  type: "depends_on";
};

export type ProjectTaskRef = {
  canvasId: string;
  taskId: string;
};

export type ProjectCrossTaskEdge = {
  from: ProjectTaskRef;
  to: ProjectTaskRef;
  type: "depends_on";
};

export type ProjectGraphManifest = {
  version: typeof supportedProjectGraphVersion;
  canvases: ProjectCanvasNode[];
  edges: ProjectCanvasEdge[];
  crossTaskEdges: ProjectCrossTaskEdge[];
};

export type ProjectGraphSource = "project_graph" | "legacy_registry" | "legacy_default_canvas";

export type LoadedProjectGraph = {
  workspace: ProjectWorkspace;
  manifest: ProjectGraphManifest;
  source: ProjectGraphSource;
  diagnostics: ValidationIssue[];
};

export type ProjectTaskRefString = string;

export type CompiledProjectGraph = {
  manifest: ProjectGraphManifest;
  source: ProjectGraphSource;
  canvasesById: Map<string, ProjectCanvasNode>;
  canvasIdsInOrder: string[];
  taskRefsInProjectOrder: ProjectTaskRef[];
  canvasDependenciesByCanvas: Map<string, string[]>;
  canvasDependentsByCanvas: Map<string, string[]>;
  crossTaskEdges: ProjectCrossTaskEdge[];
  crossTaskDependenciesByTaskRef: Map<ProjectTaskRefString, ProjectTaskRefString[]>;
  crossTaskDependentsByTaskRef: Map<ProjectTaskRefString, ProjectTaskRefString[]>;
  taskDependenciesByTaskRef: Map<ProjectTaskRefString, ProjectTaskRefString[]>;
  taskDependentsByTaskRef: Map<ProjectTaskRefString, ProjectTaskRefString[]>;
  diagnostics: {
    errors: ValidationIssue[];
    warnings: ValidationIssue[];
  };
  canvasReachable(from: string, to: string): boolean;
  taskDependencies(ref: ProjectTaskRef): ProjectTaskRef[];
  taskDependents(ref: ProjectTaskRef): ProjectTaskRef[];
  crossTaskDependencies(ref: ProjectTaskRef): ProjectTaskRef[];
  crossTaskDependents(ref: ProjectTaskRef): ProjectTaskRef[];
  taskReachable(from: ProjectTaskRef, to: ProjectTaskRef): boolean;
};
