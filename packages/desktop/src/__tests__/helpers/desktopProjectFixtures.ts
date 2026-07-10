import type {
  DesktopLayout,
  DesktopProjectSnapshot,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import { graph } from "./graphFixtures";

export const project: DesktopProjectSummary = {
  projectId: "P-001",
  name: "Demo project",
  rootPath: "/tmp/demo",
  workspaceRoot: "/tmp/demo",
  activeCanvasId: "canvas-main",
  taskCanvases: [
    {
      canvasId: "canvas-main",
      name: "Main canvas",
      taskCount: 2,
      diagnostics: [],
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z"
    }
  ]
};

export const layout: DesktopLayout = {
  version: "desktop-layout/v1",
  projectId: project.projectId,
  nodes: [],
  updatedAt: "2026-05-23T00:00:00.000Z"
};

export function projectSnapshot(
  overrides: Partial<DesktopProjectSnapshot> = {}
): DesktopProjectSnapshot {
  return {
    projectPromptMarkdown: null,
    projectPromptPolicy: null,
    graph,
    layout,
    todoGroups: null,
    executionPlan: null,
    statistics: null,
    pendingImportRecoveries: [],
    diagnostics: [],
    errors: [],
    ...overrides
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}
