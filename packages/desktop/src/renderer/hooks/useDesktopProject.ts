import { useCallback, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import type {
  DesktopGraphViewModel,
  DesktopLayout,
  DesktopProjectExecutionPlan,
  DesktopProjectSummary,
  DesktopRuntimeRefreshSnapshot,
  DesktopStatistics,
  DesktopTodoGroups,
  PendingImportTransaction,
  ProjectPromptPolicy,
  ValidationIssue
} from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "../bridge";
import type { createTranslator } from "../i18n";
import type { DesktopSettingsUpdate } from "../types";
import { useDesktopImportRecovery } from "./useDesktopImportRecovery";
import { useDesktopProjectLoader } from "./useDesktopProjectLoader";
import { useDesktopProjectSnapshot } from "./useDesktopProjectSnapshot";
import { useDesktopRuntimeSubscriptions } from "./useDesktopRuntimeSubscriptions";

export { resolveProjectCanvasId } from "./useDesktopProjectLoader";

export type UseDesktopProjectArgs = {
  planweaveHome: string;
  autoSelectInitialProject?: boolean;
  initialProjectPath?: string;
  setError: (message: string | null) => void;
  settingsHydrated?: boolean;
  t: ReturnType<typeof createTranslator>;
  updateSettings: (update: DesktopSettingsUpdate) => void;
};

export function useDesktopProject({
  planweaveHome,
  autoSelectInitialProject = true,
  initialProjectPath = "",
  setError,
  settingsHydrated = true,
  t,
  updateSettings
}: UseDesktopProjectArgs) {
  const [projects, setProjects] = useState<DesktopProjectSummary[]>([]);
  const [projectLoading, setProjectLoading] = useState(Boolean(bridge));
  const [projectRefreshing, setProjectRefreshing] = useState(false);
  const [selectedProject, setSelectedProjectState] = useState<DesktopProjectSummary | null>(null);
  const [selectedCanvasId, setSelectedCanvasIdState] = useState<string | null>(null);
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const [graph, setGraph] = useState<DesktopGraphViewModel | null>(null);
  const [layout, setLayout] = useState<DesktopLayout | null>(null);
  const [todoGroups, setTodoGroups] = useState<DesktopTodoGroups | null>(null);
  const [executionPlan, setExecutionPlan] = useState<DesktopProjectExecutionPlan | null>(null);
  const [statistics, setStatistics] = useState<DesktopStatistics | null>(null);
  const [projectDiagnostics, setProjectDiagnostics] = useState<ValidationIssue[]>([]);
  const [graphDiagnostics, setGraphDiagnostics] = useState<ValidationIssue[]>([]);
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<ValidationIssue[]>([]);
  const [runtimeRefreshSnapshot, setRuntimeRefreshSnapshot] =
    useState<DesktopRuntimeRefreshSnapshot | null>(null);
  const [projectPromptMarkdown, setProjectPromptMarkdown] = useState<string | null>(null);
  const [projectPromptPolicy, setProjectPromptPolicy] = useState<ProjectPromptPolicy | null>(null);
  const [pendingImportRecoveries, setPendingImportRecoveries] = useState<
    PendingImportTransaction[]
  >([]);

  const {
    beginProjectRequest,
    beginSnapshotRequest,
    beginSelectionIntent,
    captureProjectSelection,
    selectCanvas,
    applyDesktopProjectSnapshot,
    applyDesktopGraph,
    applyRuntimeRefreshSnapshot,
    clearProjectState,
    currentCanvasRef,
    refreshDesktopGraphDiagnostics
  } = useDesktopProjectSnapshot({
    planweaveHome,
    graph,
    selectedCanvasId,
    selectedProjectRoot: selectedProject?.rootPath ?? null,
    setExecutionPlan,
    setGraph,
    setGraphDiagnostics,
    setLayout,
    setPendingImportRecoveries,
    setProjectDiagnostics,
    setProjectPromptMarkdown,
    setProjectPromptPolicy,
    setRuntimeDiagnostics,
    setRuntimeRefreshSnapshot,
    setStatistics,
    setTodoGroups
  });

  const setSelectedProject = useCallback(
    (value: DesktopProjectSummary | null) => {
      if (currentCanvasRef.current.projectRoot !== (value?.rootPath ?? null)) clearProjectState();
      selectCanvas(value?.rootPath ?? null, currentCanvasRef.current.canvasId);
      setSelectedProjectState(value);
    },
    [clearProjectState, currentCanvasRef, selectCanvas]
  );
  const setSelectedCanvasId = useCallback(
    (value: SetStateAction<string | null>) => {
      const canvasId =
        typeof value === "function" ? value(currentCanvasRef.current.canvasId) : value;
      if (currentCanvasRef.current.canvasId !== canvasId) clearProjectState();
      selectCanvas(currentCanvasRef.current.projectRoot, canvasId);
      setSelectedCanvasIdState(canvasId);
    },
    [clearProjectState, currentCanvasRef, selectCanvas]
  );

  const beginProjectSelection = useCallback(
    (project: DesktopProjectSummary, canvasId: string | null) => {
      const previous = currentCanvasRef.current;
      if (previous.projectRoot !== project.rootPath || previous.canvasId !== canvasId)
        clearProjectState();
      const receipt = beginSelectionIntent({ projectRoot: project.rootPath, canvasId });
      setSelectedProjectState(project);
      setSelectedCanvasIdState(canvasId);
      setExpandedProjectId(project.projectId);
      setProjectLoading(true);
      setProjectRefreshing(false);
      setError(null);
      return {
        ...receipt,
        finishLoading: () => {
          if (receipt.isCurrent()) setProjectLoading(false);
        }
      };
    },
    [beginSelectionIntent, clearProjectState, currentCanvasRef, setError]
  );
  const previousHome = useRef(planweaveHome);
  useLayoutEffect(() => {
    if (previousHome.current === planweaveHome) return;
    previousHome.current = planweaveHome;
    setProjectLoading(false);
    setProjectRefreshing(false);
  }, [planweaveHome]);

  const {
    handleOpenProject,
    loadProject,
    refreshGraph,
    refreshGraphAndLayout,
    refreshProjectDerivedState,
    refreshProjects,
    refreshProjectSummary,
    removeProject,
    updateProjectPrompt,
    updateProjectPromptPolicy
  } = useDesktopProjectLoader({
    planweaveHome,
    beginProjectSelection,
    beginSelectionIntent,
    captureProjectSelection,
    beginProjectRequest,
    beginSnapshotRequest,
    autoSelectInitialProject,
    applyDesktopProjectSnapshot,
    clearProjectState,
    currentCanvasRef,
    initialProjectPath,
    refreshDesktopGraphDiagnostics,
    selectedCanvasId,
    selectedProject,
    setError,
    setExpandedProjectId,
    setGraph: applyDesktopGraph,
    setGraphDiagnostics,
    setProjectLoading,
    setProjectPromptMarkdown,
    setProjectPromptPolicy,
    setProjectRefreshing,
    setProjects,
    setSelectedCanvasId,
    setSelectedProject,
    settingsHydrated,
    t,
    updateSettings
  });

  const runtimeAutoRunOwner = useRef<() => boolean>(() => false);
  const isRuntimeAutoRunCurrent = useCallback(() => runtimeAutoRunOwner.current(), []);

  const refreshRuntimeState = useCallback(async () => {
    if (!bridge || !selectedProject) {
      return;
    }
    const canvasRef = desktopCanvasReference(selectedProject, selectedCanvasId);
    const request = beginProjectRequest(canvasRef, "runtime");
    if (!request.isCurrent() || !request.isAutoRunCurrent()) return;
    try {
      const snapshot = await bridge.getDesktopRuntimeRefresh(canvasRef);
      if (!request.isCurrent() || !request.isAutoRunCurrent()) return;
      runtimeAutoRunOwner.current = request.isAutoRunCurrent;
      const errors = applyRuntimeRefreshSnapshot(snapshot);
      await refreshDesktopGraphDiagnostics(
        canvasRef,
        () => request.isCurrent() && request.isGraphCurrent()
      );
      if (!request.isCurrent() || !request.isAutoRunCurrent()) return;
      if (errors.length > 0) setError(errors.join("\n"));
    } catch (caught) {
      if (request.isCurrent() && request.isAutoRunCurrent()) throw caught;
    }
  }, [
    applyRuntimeRefreshSnapshot,
    beginProjectRequest,
    refreshDesktopGraphDiagnostics,
    selectedCanvasId,
    selectedProject,
    setError
  ]);

  const { rollbackPendingImportRecovery } = useDesktopImportRecovery({
    refreshProjectDerivedState,
    selectedProject,
    setError
  });

  useDesktopRuntimeSubscriptions({
    planweaveHome,
    captureProjectSelection,
    graph,
    refreshGraph,
    refreshRuntimeState,
    selectedCanvasId,
    selectedProject,
    setError
  });

  return {
    beginProjectSelection,
    captureProjectSelection,
    beginProjectRequest,
    isRuntimeAutoRunCurrent,
    expandedProjectId,
    executionPlan,
    graph,
    graphDiagnostics,
    handleOpenProject,
    layout,
    loadProject,
    pendingImportRecoveries,
    projectLoading,
    projects,
    projectDiagnostics,
    projectPromptMarkdown,
    projectPromptPolicy,
    projectRefreshing,
    refreshProjects,
    refreshProjectSummary,
    refreshGraph,
    refreshGraphAndLayout,
    refreshProjectDerivedState,
    refreshRuntimeState,
    rollbackPendingImportRecovery,
    runtimeDiagnostics,
    runtimeRefreshSnapshot,
    removeProject,
    selectedCanvasId,
    selectedProject,
    setSelectedCanvasId,
    setSelectedProject,
    setLayout,
    statistics,
    todoGroups,
    updateProjectPrompt,
    updateProjectPromptPolicy
  };
}
