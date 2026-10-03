import { useCallback, useLayoutEffect, useRef } from "react";
import type {
  DesktopGraphViewModel,
  DesktopLayout,
  DesktopProjectExecutionPlan,
  DesktopProjectSnapshot,
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
  requireCurrentCanvas?: boolean;
  throwOnErrors?: boolean;
  isOwnerCurrent?: () => boolean;
};

export type CurrentDesktopCanvasRef = {
  canvasId: string | null;
  hasGraph: boolean;
  projectRoot: string | null;
};

export type DesktopSelectionReceipt = { isCurrent: () => boolean };

type SnapshotWriteScope = { graph: boolean; derived: boolean; layout: boolean; prompt: boolean };

function snapshotDiagnosticDomain(diagnostic: ValidationIssue): keyof SnapshotWriteScope {
  if (diagnostic.code !== "desktop_snapshot_part_failed") return "derived";
  switch (diagnostic.path) {
    case "graph":
      return "graph";
    case "layout":
      return "layout";
    case "projectPromptMarkdown":
    case "projectPromptPolicy":
      return "prompt";
    case "todoGroups":
    case "executionPlan":
    case "statistics":
    case "pendingImportRecoveries":
      return "derived";
    default:
      throw new Error(`Unknown desktop snapshot diagnostic part: ${diagnostic.path}`);
  }
}

type UseDesktopProjectSnapshotArgs = {
  planweaveHome: string;
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
  planweaveHome,
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

  const snapshotDiagnostics = useRef<ValidationIssue[]>([]);

  const lifecycle = useRef({
    home: planweaveHome,
    mounted: true,
    generation: 0,
    load: 0,
    graph: 0,
    derived: 0,
    layout: 0,
    prompt: 0,
    runtime: 0,
    autoRun: 0,
    diagnostics: 0,
    projects: 0
  });
  const invalidateProjectRequests = useCallback(() => {
    lifecycle.current.generation += 1;
  }, []);
  useLayoutEffect(() => {
    if (lifecycle.current.home === planweaveHome) return;
    lifecycle.current.home = planweaveHome;
    invalidateProjectRequests();
    setProjectPromptMarkdown(null);
    setProjectPromptPolicy(null);
  }, [invalidateProjectRequests, planweaveHome, setProjectPromptMarkdown, setProjectPromptPolicy]);
  const selectCanvas = useCallback(
    (projectRoot: string | null, canvasId: string | null) => {
      const current = currentCanvasRef.current;
      if (current.projectRoot !== projectRoot || current.canvasId !== canvasId) {
        invalidateProjectRequests();
        currentCanvasRef.current = { projectRoot, canvasId, hasGraph: false };
      }
    },
    [invalidateProjectRequests]
  );
  useLayoutEffect(() => {
    lifecycle.current.mounted = true;
    return () => {
      lifecycle.current.mounted = false;
      invalidateProjectRequests();
    };
  }, [invalidateProjectRequests]);
  useLayoutEffect(() => {
    selectCanvas(selectedProjectRoot, selectedCanvasId);
    currentCanvasRef.current.hasGraph = Boolean(graph);
  }, [graph, selectedCanvasId, selectedProjectRoot, selectCanvas]);

  const captureProjectSelection = useCallback((category?: "projects"): DesktopSelectionReceipt => {
    const generation = lifecycle.current.generation;
    const sequence = category ? ++lifecycle.current[category] : null;
    return {
      isCurrent: () =>
        lifecycle.current.mounted &&
        lifecycle.current.generation === generation &&
        (!category || lifecycle.current[category] === sequence)
    };
  }, []);
  const beginSelectionIntent = useCallback(
    (canvas?: { projectRoot: string; canvasId: string | null }) => {
      invalidateProjectRequests();
      if (canvas) selectCanvas(canvas.projectRoot, canvas.canvasId);
      return captureProjectSelection();
    },
    [captureProjectSelection, invalidateProjectRequests, selectCanvas]
  );

  const beginProjectRequest = useCallback(
    (
      canvas: { projectRoot: string; canvasId?: string | null },
      category:
        | "load"
        | "graph"
        | "derived"
        | "layout"
        | "prompt"
        | "runtime"
        | "diagnostics"
        | "autoRun"
    ) => {
      const generation = lifecycle.current.generation;
      const targetsCurrentCanvas =
        lifecycle.current.mounted &&
        currentCanvasRef.current.projectRoot === canvas.projectRoot &&
        currentCanvasRef.current.canvasId === canvas.canvasId;
      const sequence = targetsCurrentCanvas
        ? ++lifecycle.current[category]
        : lifecycle.current[category];
      if (targetsCurrentCanvas && category === "graph") lifecycle.current.diagnostics += 1;
      if (targetsCurrentCanvas && (category === "load" || category === "runtime")) {
        lifecycle.current.autoRun += 1;
      }
      const autoRunSequence = lifecycle.current.autoRun;
      const graphSequence = lifecycle.current.graph;
      const isSelectionCurrent = () =>
        targetsCurrentCanvas &&
        lifecycle.current.mounted &&
        lifecycle.current.generation === generation &&
        currentCanvasRef.current.projectRoot === canvas.projectRoot &&
        currentCanvasRef.current.canvasId === canvas.canvasId;
      return {
        isSelectionCurrent,
        isAutoRunCurrent: () =>
          isSelectionCurrent() && lifecycle.current.autoRun === autoRunSequence,
        isGraphCurrent: () => isSelectionCurrent() && lifecycle.current.graph === graphSequence,
        isCurrent: () => isSelectionCurrent() && lifecycle.current[category] === sequence
      };
    },
    []
  );

  const beginSnapshotRequest = useCallback(
    (
      canvas: { projectRoot: string; canvasId?: string | null },
      options: ApplyDesktopProjectSnapshotOptions
    ) => {
      const graph = beginProjectRequest(canvas, "graph");
      const derived = beginProjectRequest(canvas, "derived");
      const layout = options.includeLayout ? beginProjectRequest(canvas, "layout") : null;
      const prompt = options.includePrompt ? beginProjectRequest(canvas, "prompt") : null;
      return {
        graph,
        isCurrent: () =>
          graph.isCurrent() ||
          derived.isCurrent() ||
          Boolean(layout?.isCurrent()) ||
          Boolean(prompt?.isCurrent()),
        writeScope: () => ({
          graph: graph.isCurrent(),
          derived: derived.isCurrent(),
          layout: Boolean(layout?.isCurrent()),
          prompt: Boolean(prompt?.isCurrent())
        })
      };
    },
    [beginProjectRequest]
  );

  const clearProjectState = useCallback(() => {
    invalidateProjectRequests();
    snapshotDiagnostics.current = [];
    currentCanvasRef.current.hasGraph = false;
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
    invalidateProjectRequests,
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

  const applyDesktopGraph = useCallback(
    (value: DesktopGraphViewModel | null) => {
      setGraph(value);
      setGraphDiagnostics([]);
      if (
        snapshotDiagnostics.current.some((issue) => snapshotDiagnosticDomain(issue) === "graph")
      ) {
        snapshotDiagnostics.current = snapshotDiagnostics.current.filter(
          (issue) => snapshotDiagnosticDomain(issue) !== "graph"
        );
        setProjectDiagnostics(snapshotDiagnostics.current);
      }
    },
    [setGraph, setGraphDiagnostics, setProjectDiagnostics]
  );

  const applyDesktopProjectSnapshot = useCallback(
    (snapshot: DesktopProjectSnapshot, getScope: () => SnapshotWriteScope) => {
      const scope = getScope();
      if (scope.prompt) {
        setProjectPromptMarkdown(snapshot.projectPromptMarkdown);
        setProjectPromptPolicy(snapshot.projectPromptPolicy);
      }
      if (scope.graph) {
        applyDesktopGraph(snapshot.graph);
      }
      if (scope.layout) {
        setLayout(snapshot.layout);
      }
      if (scope.derived) {
        setTodoGroups(snapshot.todoGroups);
        setExecutionPlan(snapshot.executionPlan);
        setStatistics(snapshot.statistics);
        setPendingImportRecoveries(snapshot.pendingImportRecoveries);
      }
      return () => {
        const currentScope = getScope();
        if (!Object.values(currentScope).some(Boolean)) return [];
        if (snapshot.errors.length !== snapshot.diagnostics.length) {
          throw new Error("Desktop snapshot errors and diagnostics must have matching entries.");
        }
        const diagnostics = snapshot.diagnostics.filter(
          (issue) => currentScope[snapshotDiagnosticDomain(issue)]
        );
        const nextDiagnostics = [
          ...snapshotDiagnostics.current.filter(
            (issue) => !currentScope[snapshotDiagnosticDomain(issue)]
          ),
          ...diagnostics
        ];
        if (
          nextDiagnostics.length !== snapshotDiagnostics.current.length ||
          nextDiagnostics.some((issue, index) => issue !== snapshotDiagnostics.current[index])
        ) {
          snapshotDiagnostics.current = nextDiagnostics;
          setProjectDiagnostics(nextDiagnostics);
        }
        return snapshot.errors.filter((_, index) => {
          const issue = snapshot.diagnostics[index]!;
          return (
            currentScope[snapshotDiagnosticDomain(issue)] && !isDesktopPerformanceDiagnostic(issue)
          );
        });
      };
    },
    [
      setExecutionPlan,
      applyDesktopGraph,
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

  const refreshDesktopGraphDiagnostics = useCallback(
    async (
      canvasRef: { projectRoot: string; canvasId?: string | null },
      isOwnerCurrent: () => boolean
    ) => {
      if (!bridge || !isOwnerCurrent()) return false;
      const request = beginProjectRequest(canvasRef, "diagnostics");
      try {
        const diagnostics = await bridge.getDesktopGraphDiagnostics(canvasRef);
        if (!request.isCurrent() || !isOwnerCurrent()) return false;
        setGraphDiagnostics(diagnostics.diagnostics);
        return true;
      } catch (caught) {
        if (!request.isCurrent() || !isOwnerCurrent()) return false;
        throw caught;
      }
    },
    [beginProjectRequest, setGraphDiagnostics]
  );

  return {
    beginSelectionIntent,
    captureProjectSelection,
    beginProjectRequest,
    beginSnapshotRequest,
    selectCanvas,
    applyDesktopProjectSnapshot,
    applyDesktopGraph,
    applyRuntimeRefreshSnapshot,
    clearProjectState,
    currentCanvasRef,
    refreshDesktopGraphDiagnostics
  };
}
