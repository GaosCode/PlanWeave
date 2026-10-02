import type {
  DesktopGraphDiagnostics,
  DesktopGraphDiagnosticIssue,
  DesktopLayout,
  DesktopProjectSnapshot,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import { graph } from "./graphFixtures";

export const project: DesktopProjectSummary = {
  projectId: "P-001",
  name: "Demo project",
  kind: "external",
  sourceRoot: "/tmp/demo",
  rootPath: "/tmp/demo",
  workspaceRoot: "/tmp/demo",
  activeCanvasId: "canvas-main",
  taskCanvases: [
    {
      canvasId: "canvas-main",
      name: "Main canvas",
      packageDir: null,
      executionPolicy: null,
      taskCount: 2,
      missingPromptCount: 0,
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

export function projectDiagnostics(
  diagnostics: DesktopGraphDiagnosticIssue[] = []
): DesktopGraphDiagnostics {
  return {
    graphQuality: {
      ok: true,
      diagnostics: [],
      summary: {
        taskCount: 0,
        blockCount: 0,
        taskDependencyCount: 0,
        reviewBlockCount: 0,
        orphanTaskCount: 0,
        score: 100,
        errorCount: 0,
        warningCount: 0,
        infoCount: 0
      }
    },
    executionReadiness: {
      ok: true,
      diagnostics: [],
      nextClaimable: [],
      summary: {
        taskCount: 0,
        blockCount: 0,
        readyBlockCount: 0,
        currentRefCount: 0,
        openFeedbackCount: 0,
        errorCount: 0,
        warningCount: 0,
        infoCount: 0
      }
    },
    diagnostics
  };
}
