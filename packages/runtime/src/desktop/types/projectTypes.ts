export type DesktopTaskCanvasSummary = {
  canvasId: string;
  name: string;
  taskCount: number;
  createdAt: string;
  updatedAt: string;
};

export type DesktopProjectSummary = {
  projectId: string;
  name: string;
  rootPath: string;
  workspaceRoot: string;
  taskCanvases: DesktopTaskCanvasSummary[];
};
