import { useCallback, useState } from "react";
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
  setError: (message: string | null) => void;
  t: ReturnType<typeof createTranslator>;
  updateSettings: (update: DesktopSettingsUpdate) => void;
};

export function useDesktopProject({ setError, t, updateSettings }: UseDesktopProjectArgs) {
  const [projects, setProjects] = useState<DesktopProjectSummary[]>([]);
  const [projectLoading, setProjectLoading] = useState(Boolean(bridge));
  const [projectRefreshing, setProjectRefreshing] = useState(false);
  const [selectedProject, setSelectedProject] = useState<DesktopProjectSummary | null>(null);
  const [selectedCanvasId, setSelectedCanvasId] = useState<string | null>(null);
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
    applyDesktopProjectSnapshot,
    applyRuntimeRefreshSnapshot,
    clearProjectState,
    currentCanvasRef,
    refreshDesktopGraphDiagnostics
  } = useDesktopProjectSnapshot({
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
    applyDesktopProjectSnapshot,
    clearProjectState,
    currentCanvasRef,
    refreshDesktopGraphDiagnostics,
    selectedCanvasId,
    selectedProject,
    setError,
    setExpandedProjectId,
    setGraph,
    setGraphDiagnostics,
    setProjectLoading,
    setProjectPromptMarkdown,
    setProjectPromptPolicy,
    setProjectRefreshing,
    setProjects,
    setSelectedCanvasId,
    setSelectedProject,
    t,
    updateSettings
  });

  const refreshRuntimeState = useCallback(async () => {
    if (!bridge || !selectedProject) {
      return;
    }
    const canvasRef = desktopCanvasReference(selectedProject, selectedCanvasId);
    const snapshot = await bridge.getDesktopRuntimeRefresh(canvasRef);
    const currentCanvas = currentCanvasRef.current;
    if (
      currentCanvas.projectRoot !== canvasRef.projectRoot ||
      currentCanvas.canvasId !== canvasRef.canvasId
    ) {
      return;
    }
    const errors = applyRuntimeRefreshSnapshot(snapshot);
    const diagnosticsApplied = await refreshDesktopGraphDiagnostics(canvasRef);
    if (!diagnosticsApplied) {
      return;
    }
    if (errors.length > 0) {
      setError(errors.join("\n"));
    }
  }, [
    applyRuntimeRefreshSnapshot,
    currentCanvasRef,
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
    graph,
    refreshGraph,
    refreshRuntimeState,
    selectedCanvasId,
    selectedProject,
    setError
  });

  return {
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
    setLayout,
    statistics,
    todoGroups,
    updateProjectPrompt,
    updateProjectPromptPolicy
  };
}
