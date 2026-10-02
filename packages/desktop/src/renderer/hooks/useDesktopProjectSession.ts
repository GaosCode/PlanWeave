import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type {
  DesktopAutoRunState,
  DesktopBlockDetail,
  DesktopProjectSummary,
  DesktopRunRecord,
  ValidationIssue
} from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "../bridge";
import type { Language } from "../i18n";
import type { AppView } from "../types";
import { resolveProjectCanvasId, useDesktopProject } from "./useDesktopProject";

type DesktopProjectState = ReturnType<typeof useDesktopProject>;

type UseDesktopProjectSessionArgs = {
  clearSelectedBlockRecords: () => void;
  language: Language;
  projectState: DesktopProjectState;
  selectBlock: (ref: string, canvasId?: string | null) => Promise<DesktopBlockDetail | undefined>;
  setActiveView: (view: AppView) => void;
  setBlockInspectorOpen: (open: boolean) => void;
  setError: (message: string | null) => void;
  setSelectedBlock: (block: DesktopBlockDetail | null) => void;
  setSelectedRunRecord: (record: DesktopRunRecord | null) => void;
};

function clearDiagnostics(current: ValidationIssue[]) {
  return current.length === 0 ? current : [];
}

export function useDesktopProjectSession({
  clearSelectedBlockRecords,
  language,
  projectState,
  selectBlock,
  setActiveView,
  setBlockInspectorOpen,
  setError,
  setSelectedBlock,
  setSelectedRunRecord
}: UseDesktopProjectSessionArgs) {
  const [autoRunState, setAutoRunState] = useState<DesktopAutoRunState | null>(null);
  const [autoRunDiagnostics, setAutoRunDiagnostics] = useState<ValidationIssue[]>([]);
  const initialSelectionEffectSkipped = useRef(false);
  const summaryError = useRef(setError);
  useEffect(() => {
    summaryError.current = setError;
  }, [setError]);
  const [taskFocusRequest, setTaskFocusRequest] = useState<{
    taskId: string;
    version: number;
  } | null>(null);
  const [selectedTaskPanelId, setSelectedTaskPanelId] = useState<string | null>(null);

  const clearTaskPanelSelection = useCallback(() => {
    setSelectedTaskPanelId(null);
    setTaskFocusRequest(null);
  }, []);

  const clearSelectionForCanvasChange = useCallback(() => {
    setSelectedBlock(null);
    clearTaskPanelSelection();
    setSelectedRunRecord(null);
    setBlockInspectorOpen(false);
    clearSelectedBlockRecords();
  }, [
    clearSelectedBlockRecords,
    clearTaskPanelSelection,
    setBlockInspectorOpen,
    setSelectedBlock,
    setSelectedRunRecord
  ]);

  const setAutoRunStateFromControl = useCallback(
    (nextState: SetStateAction<DesktopAutoRunState | null>) => {
      const projectRoot = projectState.selectedProject?.rootPath;
      if (!projectRoot) return;
      const request = projectState.beginProjectRequest(
        { projectRoot, canvasId: projectState.selectedCanvasId },
        "autoRun"
      );
      if (!request.isCurrent()) return;
      setAutoRunState(nextState);
      setAutoRunDiagnostics(clearDiagnostics);
    },
    [
      projectState.beginProjectRequest,
      projectState.selectedCanvasId,
      projectState.selectedProject?.rootPath
    ]
  );

  const refreshLatestAutoRunSummary = useCallback(
    async (
      projectRoot = projectState.selectedProject?.rootPath,
      canvasId = projectState.selectedCanvasId
    ) => {
      if (!bridge || !projectRoot) {
        setAutoRunState(null);
        setAutoRunDiagnostics(clearDiagnostics);
        return null;
      }
      const request = projectState.beginProjectRequest({ projectRoot, canvasId }, "autoRun");
      if (!request.isCurrent()) return null;
      try {
        const summary = await bridge.getLatestAutoRunSummaryWithDiagnostics({
          projectRoot,
          canvasId
        });
        if (!request.isCurrent()) return null;
        setAutoRunState(summary.state);
        setAutoRunDiagnostics(summary.diagnostics);
        return summary.state;
      } catch (caught) {
        if (request.isCurrent())
          summaryError.current(caught instanceof Error ? caught.message : String(caught));
        return null;
      }
    },
    [
      projectState.beginProjectRequest,
      projectState.selectedCanvasId,
      projectState.selectedProject?.rootPath
    ]
  );

  const selectTaskPanel = useCallback(
    (taskId: string | null) => {
      setSelectedTaskPanelId(taskId);
      setTaskFocusRequest((current) =>
        taskId ? { taskId, version: (current?.version ?? 0) + 1 } : null
      );
      setActiveView("graph");
    },
    [setActiveView]
  );

  const restoreTaskPanelSelection = useCallback((taskId: string | null) => {
    setSelectedTaskPanelId(taskId);
    setTaskFocusRequest(null);
  }, []);

  const openTaskInspector = useCallback(
    async (taskId: string, canvasIdOverride?: string | null) => {
      const canvasId =
        canvasIdOverride === undefined ? projectState.selectedCanvasId : canvasIdOverride;
      try {
        selectTaskPanel(taskId);
        if (!bridge || !projectState.selectedProject) {
          return;
        }
        await bridge.openTaskInspectorWindow({
          taskId,
          canvas: desktopCanvasReference(projectState.selectedProject, canvasId),
          language
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [
      language,
      projectState.selectedCanvasId,
      projectState.selectedProject,
      selectTaskPanel,
      setError
    ]
  );

  const openBlockInspector = useCallback(
    async (ref: string, canvasIdOverride?: string | null) => {
      const canvasId =
        canvasIdOverride === undefined ? projectState.selectedCanvasId : canvasIdOverride;
      try {
        const block = await selectBlock(ref, canvasId);
        if (block) {
          selectTaskPanel(block.taskId);
        }
        if (!bridge || !projectState.selectedProject) {
          return;
        }
        await bridge.openBlockInspectorWindow({
          blockRef: ref,
          canvas: desktopCanvasReference(projectState.selectedProject, canvasId),
          language
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [
      language,
      projectState.selectedCanvasId,
      projectState.selectedProject,
      selectBlock,
      selectTaskPanel,
      setError
    ]
  );

  const openProject = useCallback(
    async (
      project: DesktopProjectSummary,
      canvasId?: string | null,
      options: { recordCanvasSelection?: boolean } = {}
    ) => {
      const nextCanvasId = resolveProjectCanvasId(project, canvasId);
      const selection = projectState.beginProjectSelection(project, nextCanvasId);
      try {
        if (
          bridge &&
          canvasId !== undefined &&
          nextCanvasId &&
          options.recordCanvasSelection !== false
        ) {
          await bridge.selectTaskCanvas(project.rootPath, nextCanvasId);
          if (!selection.isCurrent()) return;
        }
        if (!selection.isCurrent()) return;
        clearSelectionForCanvasChange();
        const loading = projectState.loadProject(project, nextCanvasId, selection);
        const request = projectState.beginProjectRequest(
          { projectRoot: project.rootPath, canvasId: nextCanvasId },
          "autoRun"
        );
        await loading;
        if (!selection.isCurrent() || !request.isCurrent()) return;
        await refreshLatestAutoRunSummary(project.rootPath, nextCanvasId);
      } catch (caught) {
        if (selection.isCurrent()) throw caught;
      } finally {
        selection.finishLoading();
      }
    },
    [
      clearSelectionForCanvasChange,
      projectState.beginProjectRequest,
      projectState.beginProjectSelection,
      projectState.loadProject,
      refreshLatestAutoRunSummary
    ]
  );

  const reloadCurrentCanvas = useCallback(async () => {
    if (!projectState.selectedProject) {
      return;
    }
    await openProject(projectState.selectedProject, projectState.selectedCanvasId);
  }, [openProject, projectState.selectedCanvasId, projectState.selectedProject]);

  const createTaskCanvas = useCallback(
    async (project: DesktopProjectSummary) => {
      if (!bridge) {
        return null;
      }
      const selection = projectState.captureProjectSelection();
      try {
        const canvas = await bridge.createTaskCanvas(project.rootPath);
        if (!selection.isCurrent()) return canvas;
        const refreshed = await projectState.refreshProjectSummary(project.rootPath);
        if (!selection.isCurrent()) return canvas;
        await openProject(refreshed ?? project, canvas.canvasId);
        return canvas;
      } catch (caught) {
        if (selection.isCurrent()) throw caught;
        return null;
      }
    },
    [openProject, projectState.captureProjectSelection, projectState.refreshProjectSummary]
  );

  const duplicateTaskCanvas = useCallback(
    async (project: DesktopProjectSummary, canvasId: string) => {
      if (!bridge) {
        return null;
      }
      const selection = projectState.captureProjectSelection();
      try {
        const canvas = await bridge.duplicateTaskCanvas(project.rootPath, canvasId);
        if (!selection.isCurrent()) return canvas;
        const refreshed = await projectState.refreshProjectSummary(project.rootPath);
        if (!selection.isCurrent()) return canvas;
        await openProject(refreshed ?? project, canvas.canvasId);
        return canvas;
      } catch (caught) {
        if (selection.isCurrent()) throw caught;
        return null;
      }
    },
    [openProject, projectState.captureProjectSelection, projectState.refreshProjectSummary]
  );

  const createProjectFromTaskCanvas = useCallback(
    async (project: DesktopProjectSummary, canvasId: string) => {
      if (!bridge) {
        return null;
      }
      const selection = projectState.captureProjectSelection();
      try {
        const createdProject = await bridge.createProjectFromTaskCanvas(project.rootPath, canvasId);
        if (!selection.isCurrent()) return createdProject;
        await projectState.refreshProjects({ selectProjectId: createdProject.projectId });
        return createdProject;
      } catch (caught) {
        if (selection.isCurrent()) throw caught;
        return null;
      }
    },
    [projectState.captureProjectSelection, projectState.refreshProjects]
  );

  const deleteTaskCanvas = useCallback(
    async (project: DesktopProjectSummary, canvasId: string) => {
      if (!bridge) {
        return;
      }
      const selection = projectState.captureProjectSelection();
      try {
        const canvases = await bridge.removeTaskCanvas(project.rootPath, canvasId);
        if (!selection.isCurrent()) return;
        const nextCanvasId = canvases[0]?.canvasId ?? null;
        const refreshed = await projectState.refreshProjectSummary(project.rootPath);
        if (!selection.isCurrent()) return;
        if (projectState.selectedProject?.projectId === project.projectId && refreshed) {
          await openProject(refreshed, nextCanvasId);
        }
      } catch (caught) {
        if (selection.isCurrent()) throw caught;
      }
    },
    [
      openProject,
      projectState.captureProjectSelection,
      projectState.refreshProjectSummary,
      projectState.selectedProject?.projectId
    ]
  );

  const renameTaskCanvas = useCallback(
    async (project: DesktopProjectSummary, canvasId: string, name: string) => {
      if (!bridge) {
        return null;
      }
      const selection = projectState.captureProjectSelection();
      try {
        const canvas = await bridge.renameTaskCanvas(project.rootPath, canvasId, name);
        if (!selection.isCurrent()) return canvas;
        const refreshed = await projectState.refreshProjectSummary(
          project.rootPath,
          projectState.selectedCanvasId
        );
        if (!selection.isCurrent()) return canvas;
        if (projectState.selectedProject?.projectId === project.projectId && refreshed) {
          await openProject(refreshed, projectState.selectedCanvasId);
        }
        return canvas;
      } catch (caught) {
        if (selection.isCurrent()) throw caught;
        return null;
      }
    },
    [
      openProject,
      projectState.captureProjectSelection,
      projectState.refreshProjectSummary,
      projectState.selectedCanvasId,
      projectState.selectedProject?.projectId
    ]
  );

  useEffect(() => {
    void projectState.selectedCanvasId;
    void projectState.selectedProject?.projectId;
    if (!initialSelectionEffectSkipped.current) {
      initialSelectionEffectSkipped.current = true;
      return;
    }
    clearSelectionForCanvasChange();
  }, [
    clearSelectionForCanvasChange,
    projectState.selectedCanvasId,
    projectState.selectedProject?.projectId
  ]);

  useEffect(() => {
    setAutoRunState(null);
    setAutoRunDiagnostics(clearDiagnostics);
    void refreshLatestAutoRunSummary();
  }, [refreshLatestAutoRunSummary]);

  useEffect(() => {
    if (!projectState.runtimeRefreshSnapshot || !projectState.isRuntimeAutoRunCurrent()) {
      return;
    }
    setAutoRunState(projectState.runtimeRefreshSnapshot.latestAutoRun);
    setAutoRunDiagnostics(projectState.runtimeRefreshSnapshot.diagnostics);
  }, [projectState.runtimeRefreshSnapshot, projectState.isRuntimeAutoRunCurrent]);

  return {
    ...projectState,
    autoRunDiagnostics,
    autoRunState,
    clearSelectionForCanvasChange,
    clearTaskPanelSelection,
    createTaskCanvas,
    createProjectFromTaskCanvas,
    deleteTaskCanvas,
    duplicateTaskCanvas,
    openBlockInspector,
    openProject,
    openTaskInspector,
    refreshLatestAutoRunSummary,
    restoreTaskPanelSelection,
    renameTaskCanvas,
    reloadCurrentCanvas,
    selectedTaskPanelId,
    setAutoRunState: setAutoRunStateFromControl,
    taskFocusRequest,
    selectTaskPanel
  };
}
