import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { DesktopAutoRunState, DesktopBlockDetail, DesktopProjectSummary, DesktopRunRecord, ValidationIssue } from "@planweave-ai/runtime";
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
  const [taskFocusRequest, setTaskFocusRequest] = useState<{ taskId: string; version: number } | null>(null);
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
  }, [clearSelectedBlockRecords, clearTaskPanelSelection, setBlockInspectorOpen, setSelectedBlock, setSelectedRunRecord]);

  const setAutoRunStateFromControl = useCallback((nextState: SetStateAction<DesktopAutoRunState | null>) => {
    setAutoRunState(nextState);
    setAutoRunDiagnostics(clearDiagnostics);
  }, []);

  const refreshLatestAutoRunSummary = useCallback(
    async (projectRoot = projectState.selectedProject?.rootPath, canvasId = projectState.selectedCanvasId) => {
      if (!bridge || !projectRoot) {
        setAutoRunState(null);
        setAutoRunDiagnostics(clearDiagnostics);
        return null;
      }
      const summary = await bridge.getLatestAutoRunSummaryWithDiagnostics({ projectRoot, canvasId });
      setAutoRunState(summary.state);
      setAutoRunDiagnostics(summary.diagnostics);
      return summary.state;
    },
    [projectState.selectedCanvasId, projectState.selectedProject?.rootPath, setAutoRunState, setAutoRunDiagnostics]
  );

  const selectTaskPanel = useCallback(
    (taskId: string | null) => {
      setSelectedTaskPanelId(taskId);
      setTaskFocusRequest((current) => (taskId ? { taskId, version: (current?.version ?? 0) + 1 } : null));
      setActiveView("graph");
    },
    [setActiveView]
  );

  const openTaskInspector = useCallback(
    async (taskId: string, canvasIdOverride?: string | null) => {
      const canvasId = canvasIdOverride === undefined ? projectState.selectedCanvasId : canvasIdOverride;
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
    [language, projectState.selectedCanvasId, projectState.selectedProject, selectTaskPanel, setError]
  );

  const openBlockInspector = useCallback(
    async (ref: string, canvasIdOverride?: string | null) => {
      const canvasId = canvasIdOverride === undefined ? projectState.selectedCanvasId : canvasIdOverride;
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
    [language, projectState.selectedCanvasId, projectState.selectedProject, selectBlock, selectTaskPanel, setError]
  );

  const openProject = useCallback(
    async (project: DesktopProjectSummary, canvasId?: string | null, options: { recordCanvasSelection?: boolean } = {}) => {
      const nextCanvasId = resolveProjectCanvasId(project, canvasId);
      if (bridge && canvasId !== undefined && nextCanvasId && options.recordCanvasSelection !== false) {
        await bridge.selectTaskCanvas(project.rootPath, nextCanvasId);
      }
      clearSelectionForCanvasChange();
      await projectState.loadProject(project, nextCanvasId);
      await refreshLatestAutoRunSummary(project.rootPath, nextCanvasId);
    },
    [clearSelectionForCanvasChange, projectState.loadProject, refreshLatestAutoRunSummary]
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
      const canvas = await bridge.createTaskCanvas(project.rootPath);
      const refreshed = await projectState.refreshProjectSummary(project.rootPath, canvas.canvasId);
      await openProject(refreshed ?? project, canvas.canvasId);
      return canvas;
    },
    [openProject, projectState.refreshProjectSummary]
  );

  const duplicateTaskCanvas = useCallback(
    async (project: DesktopProjectSummary, canvasId: string) => {
      if (!bridge) {
        return null;
      }
      const canvas = await bridge.duplicateTaskCanvas(project.rootPath, canvasId);
      const refreshed = await projectState.refreshProjectSummary(project.rootPath, canvas.canvasId);
      await openProject(refreshed ?? project, canvas.canvasId);
      return canvas;
    },
    [openProject, projectState.refreshProjectSummary]
  );

  const createProjectFromTaskCanvas = useCallback(
    async (project: DesktopProjectSummary, canvasId: string) => {
      if (!bridge) {
        return null;
      }
      const createdProject = await bridge.createProjectFromTaskCanvas(project.rootPath, canvasId);
      await projectState.refreshProjects({ selectProjectId: createdProject.projectId });
      return createdProject;
    },
    [projectState.refreshProjects]
  );

  const deleteTaskCanvas = useCallback(
    async (project: DesktopProjectSummary, canvasId: string) => {
      if (!bridge) {
        return;
      }
      const canvases = await bridge.removeTaskCanvas(project.rootPath, canvasId);
      const nextCanvasId = canvases[0]?.canvasId ?? null;
      const refreshed = await projectState.refreshProjectSummary(project.rootPath, nextCanvasId);
      if (projectState.selectedProject?.projectId === project.projectId && refreshed) {
        await openProject(refreshed, nextCanvasId);
      }
    },
    [openProject, projectState.refreshProjectSummary, projectState.selectedProject?.projectId]
  );

  const renameTaskCanvas = useCallback(
    async (project: DesktopProjectSummary, canvasId: string, name: string) => {
      if (!bridge) {
        return null;
      }
      const canvas = await bridge.renameTaskCanvas(project.rootPath, canvasId, name);
      const refreshed = await projectState.refreshProjectSummary(project.rootPath, projectState.selectedCanvasId);
      if (projectState.selectedProject?.projectId === project.projectId && refreshed) {
        await openProject(refreshed, projectState.selectedCanvasId);
      }
      return canvas;
    },
    [openProject, projectState.refreshProjectSummary, projectState.selectedCanvasId, projectState.selectedProject?.projectId]
  );

  useEffect(() => {
    if (!initialSelectionEffectSkipped.current) {
      initialSelectionEffectSkipped.current = true;
      return;
    }
    clearSelectionForCanvasChange();
  }, [clearSelectionForCanvasChange, projectState.selectedCanvasId, projectState.selectedProject?.projectId]);

  useEffect(() => {
    void refreshLatestAutoRunSummary();
  }, [refreshLatestAutoRunSummary]);

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
    renameTaskCanvas,
    reloadCurrentCanvas,
    selectedTaskPanelId,
    setAutoRunState: setAutoRunStateFromControl,
    taskFocusRequest,
    selectTaskPanel
  };
}
