export type ProjectMetadata = {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
};

export type ProjectWorkspace = {
  id: string;
  rootPath: string;
  planweaveHome: string;
  workspaceRoot: string;
  projectFile: string;
  packageDir: string;
  manifestFile: string;
  stateFile: string;
  resultsDir: string;
  projectPromptFile: string;
};

export type PackageWorkspaceRef = string | ProjectWorkspace;

export type InitWorkspaceResult = {
  workspace: ProjectWorkspace;
  project: ProjectMetadata;
  created: boolean;
  projectGraph?: {
    path: string;
    created: boolean;
    source: "project_graph" | "legacy_registry" | "legacy_default_canvas";
    canvasCount: number;
  };
  backup?: {
    backupDir: string;
    packageDir?: string;
    stateFile?: string;
    resultsDir?: string;
  };
};

export type ProjectPathsResult = {
  workspaceDir: string;
  projectId: string;
  projectDir: string;
  projectGraphPath: string;
  packageDir: string;
  statePath: string;
  resultsDir: string;
  activeCanvasId: string | null;
  canvases: ProjectCanvasPath[];
};

export type ProjectCanvasPath = {
  canvasId: string;
  name: string;
  packageDir: string;
  statePath: string;
  resultsDir: string;
};
