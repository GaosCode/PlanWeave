import { useCallback, useEffect, useRef } from "react";
import type {
  DesktopGraphViewModel,
  DesktopLayout,
  DesktopProjectExecutionPlan,
  DesktopProjectSnapshot,
  DesktopProjectSummary,
  DesktopRuntimeRefreshSnapshot,
  DesktopStatistics,
  DesktopTodoGroups,
  PendingImportTransaction,
  ProjectPromptPolicy,
  ValidationIssue
} from "@planweave-ai/runtime";
import { bridge } from "../bridge";
import { isDesktopPerformanceDiagnostic } from "../diagnostics";

export type ApplyDesktopProjectSnapshotOptions = {
  includeLayout?: boolean;
  includePrompt?: boolean;
};

export type CurrentDesktopCanvasRef = {
  canvasId: string | null;
  hasGraph: boolean;
  projectRoot: string | null;
};

type UseDesktopProjectSnapshotArgs = {
  graph: DesktopGraphViewModel | null;
  selectedCanvasId: string | null;
  selectedProjectRoot: string | null;
  setExecutionPlan: (value: DesktopProjectExecutionPlan | null) => void;
  setGraph: (value: DesktopGraphViewModel | null) => void;
  setGraphDiagnostics: (value: ValidationIssue[]) => void;
  setLayout: (value: DesktopLayout | null) => void;
  setPendingImportRecoveries: (value: PendingImportTransaction[]) => void;
  setProjectDiagnostics: (value: ValidationIssue[]) => void;
  setProjectPromptMarkdown: (value: string | null) => void;
  setProjectPromptPolicy: (value: ProjectPromptPolicy | null) => void;
  setRuntimeDiagnostics: (value: ValidationIssue[]) => void;
  setRuntimeRefreshSnapshot: (value: DesktopRuntimeRefreshSnapshot | null) => void;
  setStatistics: (value: DesktopStatistics | null) => void;
  setTodoGroups: (value: DesktopTodoGroups | null) => void;
};

export function useDesktopProjectSnapshot({
  graph,
  selectedCanvasId,
  selectedProjectRoot,
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
}: UseDesktopProjectSnapshotArgs) {
  const currentCanvasRef = useRef<CurrentDesktopCanvasRef>({
    canvasId: null,
    hasGraph: false,
    projectRoot: null
  });

  useEffect(() => {
    currentCanvasRef.current = {
      canvasId: selectedCanvasId,
      hasGraph: Boolean(graph),
      projectRoot: selectedProjectRoot
    };
  }, [graph, selectedCanvasId, selectedProjectRoot]);

  const clearProjectState = useCallback(() => {
    setGraph(null);
    setLayout(null);
    setTodoGroups(null);
    setExecutionPlan(null);
    setStatistics(null);
    setProjectDiagnostics([]);
    setGraphDiagnostics([]);
    setRuntimeDiagnostics([]);
    setRuntimeRefreshSnapshot(null);
    setProjectPromptMarkdown(null);
    setProjectPromptPolicy(null);
    setPendingImportRecoveries([]);
  }, [
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
  ]);

  const applyDesktopProjectSnapshot = useCallback(
    (snapshot: DesktopProjectSnapshot, options: ApplyDesktopProjectSnapshotOptions = {}) => {
      if (options.includePrompt) {
        setProjectPromptMarkdown(snapshot.projectPromptMarkdown);
        setProjectPromptPolicy(snapshot.projectPromptPolicy);
      }
      setGraph(snapshot.graph);
      if (options.includeLayout) {
        setLayout(snapshot.layout);
      }
      setTodoGroups(snapshot.todoGroups);
      setExecutionPlan(snapshot.executionPlan);
      setStatistics(snapshot.statistics);
      setPendingImportRecoveries(snapshot.pendingImportRecoveries);
      setProjectDiagnostics(snapshot.diagnostics);
      return snapshot.errors.filter((_, index) => {
        const diagnostic = snapshot.diagnostics[index];
        return !diagnostic || !isDesktopPerformanceDiagnostic(diagnostic);
      });
    },
    [
      setExecutionPlan,
      setGraph,
      setLayout,
      setPendingImportRecoveries,
      setProjectDiagnostics,
      setProjectPromptMarkdown,
      setProjectPromptPolicy,
      setStatistics,
      setTodoGroups
    ]
  );

  const applyRuntimeRefreshSnapshot = useCallback(
    (snapshot: DesktopRuntimeRefreshSnapshot) => {
      setRuntimeDiagnostics(snapshot.diagnostics);
      setRuntimeRefreshSnapshot(snapshot);
      return snapshot.errors.filter((_, index) => {
        const diagnostic = snapshot.diagnostics[index];
        return !diagnostic || !isDesktopPerformanceDiagnostic(diagnostic);
      });
    },
    [setRuntimeDiagnostics, setRuntimeRefreshSnapshot]
  );

  const refreshDesktopGraphDiagnostics = useCallback(async (canvasRef: { projectRoot: string; canvasId?: string | null }) => {
    if (!bridge) {
      return false;
    }
    const diagnostics = await bridge.getDesktopGraphDiagnostics(canvasRef);
    const currentCanvas = currentCanvasRef.current;
    if (currentCanvas.projectRoot !== canvasRef.projectRoot || currentCanvas.canvasId !== canvasRef.canvasId) {
      return false;
    }
    setGraphDiagnostics(diagnostics.diagnostics);
    return true;
  }, [setGraphDiagnostics]);

  return {
    applyDesktopProjectSnapshot,
    applyRuntimeRefreshSnapshot,
    clearProjectState,
    currentCanvasRef,
    refreshDesktopGraphDiagnostics
  };
}
