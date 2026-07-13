import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Edge, ReactFlowInstance } from "@xyflow/react";
import type { DesktopGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import type { AppViewHistoryController } from "../hooks/useAppViewHistory";
import {
  blockWorkspaceTarget,
  graphNavigationSnapshotSchema,
  resolveGraphNavigationSnapshot,
  runWorkspaceTarget,
  taskWorkspaceTarget
} from "../taskWorkspaceNavigation";
import type {
  RunWorkspaceTargetInput,
  TaskWorkspaceNavigationTarget
} from "../taskWorkspaceNavigation";
import type { AppFlowNode } from "../types";

type OpenProject = (
  project: DesktopProjectSummary,
  canvasId?: string | null,
  options?: { recordCanvasSelection?: boolean }
) => Promise<void>;

type RestoreSelection = (taskId: string | null, blockRef: string | null) => Promise<void>;

type RestoreAttempt = {
  generation: number;
  routeKey: string;
};

function sameRestoreAttempt(left: RestoreAttempt | null, right: RestoreAttempt): boolean {
  return left?.generation === right.generation && left.routeKey === right.routeKey;
}

export function useTaskWorkspaceGraphNavigation(options: {
  flowInstance: ReactFlowInstance<AppFlowNode, Edge> | null;
  graph: DesktopGraphViewModel | null;
  history: AppViewHistoryController;
  openProject: OpenProject;
  projectLoading: boolean;
  projects: DesktopProjectSummary[];
  restoreSelection: RestoreSelection;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
}) {
  const {
    flowInstance,
    graph,
    history,
    openProject,
    projectLoading,
    projects,
    restoreSelection,
    selectedCanvasId,
    selectedProject,
    setError
  } = options;
  const routeKey = `${history.historyIndex}:${JSON.stringify(history.route)}`;
  const routeGeneration = useRef<RestoreAttempt>({ generation: 0, routeKey });
  const completedRestoreGeneration = useRef<number | null>(null);
  const inFlightRestore = useRef<RestoreAttempt | null>(null);
  const awaitingCanvasRender = useRef<RestoreAttempt | null>(null);
  const [restoreDriveVersion, setRestoreDriveVersion] = useState(0);

  if (routeGeneration.current.routeKey !== routeKey) {
    routeGeneration.current = {
      generation: routeGeneration.current.generation + 1,
      routeKey
    };
    completedRestoreGeneration.current = null;
    inFlightRestore.current = null;
    awaitingCanvasRender.current = null;
  }

  const openWorkspaceTarget = useCallback(
    (navigationTarget: TaskWorkspaceNavigationTarget) => {
      if (!(selectedProject && selectedCanvasId && flowInstance && graph)) {
        setError("Task Workspace requires an open project canvas and graph viewport.");
        return;
      }
      const sameAuthority =
        navigationTarget.projectRoot === selectedProject.rootPath &&
        navigationTarget.canvasId === selectedCanvasId;
      const sourceTask = sameAuthority
        ? graph.tasks.find((task) => task.taskId === navigationTarget.taskId)
        : undefined;
      const sourceBlockRef = sourceTask?.blocks.some(
        (block) => block.ref === navigationTarget.blockRef
      )
        ? navigationTarget.blockRef
        : null;
      const graphSnapshot = graphNavigationSnapshotSchema.parse({
        projectRoot: selectedProject.rootPath,
        canvasId: selectedCanvasId,
        viewport: flowInstance.getViewport(),
        selectedTaskId: sourceTask?.taskId ?? null,
        selectedBlockRef: sourceBlockRef
      });
      history.openTaskWorkspace(navigationTarget, { view: "graph", graphSnapshot });
    },
    [flowInstance, graph, history.openTaskWorkspace, selectedCanvasId, selectedProject, setError]
  );
  const openTaskWorkspace = useCallback(
    (target: { taskId: string; blockRef?: string }) => {
      if (!(selectedProject && selectedCanvasId)) {
        setError("Task Workspace requires an open project canvas and graph viewport.");
        return;
      }
      openWorkspaceTarget(
        target.blockRef
          ? blockWorkspaceTarget({
              projectRoot: selectedProject.rootPath,
              canvasId: selectedCanvasId,
              taskId: target.taskId,
              blockRef: target.blockRef
            })
          : taskWorkspaceTarget({
              projectRoot: selectedProject.rootPath,
              canvasId: selectedCanvasId,
              taskId: target.taskId
            })
      );
    },
    [openWorkspaceTarget, selectedCanvasId, selectedProject, setError]
  );

  useEffect(() => {
    const snapshot = history.graphSnapshot;
    if (!snapshot) {
      return;
    }
    const attempt = routeGeneration.current;
    const isCurrentAttempt = () => sameRestoreAttempt(routeGeneration.current, attempt);
    if (
      completedRestoreGeneration.current === attempt.generation ||
      sameRestoreAttempt(inFlightRestore.current, attempt)
    ) {
      return;
    }
    if (projectLoading) {
      return;
    }
    const project = projects.find((candidate) => candidate.rootPath === snapshot.projectRoot);
    if (!project) {
      completedRestoreGeneration.current = attempt.generation;
      setError(`Cannot restore graph source: project '${snapshot.projectRoot}' is unavailable.`);
      return;
    }
    const canvasExists = project.taskCanvases.some(
      (canvas) => canvas.canvasId === snapshot.canvasId
    );
    if (!canvasExists) {
      completedRestoreGeneration.current = attempt.generation;
      setError(`Cannot restore graph source: canvas '${snapshot.canvasId}' is unavailable.`);
      return;
    }
    if (
      selectedProject?.rootPath !== snapshot.projectRoot ||
      selectedCanvasId !== snapshot.canvasId
    ) {
      if (sameRestoreAttempt(awaitingCanvasRender.current, attempt)) {
        return;
      }
      inFlightRestore.current = attempt;
      void openProject(project, snapshot.canvasId, { recordCanvasSelection: false })
        .then(() => {
          if (isCurrentAttempt()) {
            awaitingCanvasRender.current = attempt;
          }
        })
        .catch((error: unknown) => {
          if (isCurrentAttempt()) {
            completedRestoreGeneration.current = attempt.generation;
            setError(error instanceof Error ? error.message : String(error));
          }
        })
        .finally(() => {
          if (sameRestoreAttempt(inFlightRestore.current, attempt)) {
            inFlightRestore.current = null;
          }
          if (isCurrentAttempt()) {
            setRestoreDriveVersion((current) => current + 1);
          }
        });
      return;
    }
    awaitingCanvasRender.current = null;
    if (!graph || !flowInstance) {
      return;
    }
    const resolution = resolveGraphNavigationSnapshot(snapshot, {
      hasProject: ({ projectRoot }) => projectRoot === project.rootPath,
      hasCanvas: ({ projectRoot, canvasId }) =>
        projectRoot === project.rootPath &&
        project.taskCanvases.some((canvas) => canvas.canvasId === canvasId),
      hasTask: ({ projectRoot, canvasId, taskId }) =>
        projectRoot === project.rootPath &&
        canvasId === snapshot.canvasId &&
        graph.tasks.some((task) => task.taskId === taskId),
      hasBlock: ({ projectRoot, canvasId, taskId, blockRef }) =>
        projectRoot === project.rootPath &&
        canvasId === snapshot.canvasId &&
        graph.tasks
          .find((task) => task.taskId === taskId)
          ?.blocks.some((block) => block.ref === blockRef) === true,
      hasRecord: () => false
    });
    if (resolution.status === "invalid") {
      completedRestoreGeneration.current = attempt.generation;
      setError(`Cannot restore graph source: ${resolution.message}`);
      return;
    }
    inFlightRestore.current = attempt;
    void restoreSelection(snapshot.selectedTaskId, snapshot.selectedBlockRef)
      .then(() => {
        if (!isCurrentAttempt()) {
          return;
        }
        return flowInstance.setViewport(snapshot.viewport, { duration: 0 });
      })
      .then(() => {
        if (isCurrentAttempt()) {
          completedRestoreGeneration.current = attempt.generation;
        }
      })
      .catch((error: unknown) => {
        if (isCurrentAttempt()) {
          completedRestoreGeneration.current = attempt.generation;
          setError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (sameRestoreAttempt(inFlightRestore.current, attempt)) {
          inFlightRestore.current = null;
        }
      });
  }, [
    flowInstance,
    graph,
    history.graphSnapshot,
    history.historyIndex,
    openProject,
    projectLoading,
    projects,
    restoreDriveVersion,
    restoreSelection,
    selectedCanvasId,
    selectedProject,
    setError
  ]);

  const openBlockWorkspace = useCallback(
    (blockRef: string) => {
      const separatorIndex = blockRef.indexOf("#");
      if (separatorIndex <= 0) {
        setError(`Cannot open Task Workspace: block ref '${blockRef}' is invalid.`);
        return;
      }
      const taskId = blockRef.slice(0, separatorIndex);
      openTaskWorkspace({ taskId, blockRef });
    },
    [openTaskWorkspace, setError]
  );
  const openTaskWorkspaceById = useCallback(
    (taskId: string) => openTaskWorkspace({ taskId }),
    [openTaskWorkspace]
  );
  const openRunWorkspace = useCallback(
    (target: RunWorkspaceTargetInput) => openWorkspaceTarget(runWorkspaceTarget(target)),
    [openWorkspaceTarget]
  );

  return useMemo(
    () => ({ openBlockWorkspace, openRunWorkspace, openTaskWorkspace: openTaskWorkspaceById }),
    [openBlockWorkspace, openRunWorkspace, openTaskWorkspaceById]
  );
}
