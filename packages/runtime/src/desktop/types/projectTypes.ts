import type { DesktopCanvasDiagnosticIssue, DesktopCanvasExecutionPolicy } from "./graphTypes.js";

export type DesktopTaskCanvasSummary = {
  canvasId: string;
  name: string;
  packageDir: string | null;
  executionPolicy: DesktopCanvasExecutionPolicy | null;
  taskCount: number;
  missingPromptCount: number;
  diagnostics: DesktopCanvasDiagnosticIssue[];
  createdAt: string;
  updatedAt: string;
};

export type DesktopProjectSummary = {
  projectId: string;
  name: string;
  kind: "external" | "managed";
  rootPath: string;
  sourceRoot: string | null;
  workspaceRoot: string;
  activeCanvasId: string | null;
  taskCanvases: DesktopTaskCanvasSummary[];
};
