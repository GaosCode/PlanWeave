import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DesktopGraphViewModel,
  DesktopLayout,
  DesktopProjectSnapshot,
  DesktopProjectExecutionPlan,
  DesktopProjectSummary,
  DesktopStatistics,
  DesktopTodoGroups,
  ProjectPromptPolicy
} from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "../bridge";
import type { createTranslator } from "../i18n";
import type { DesktopSettingsUpdate } from "../types";

export type UseDesktopProjectArgs = {
  setError: (message: string | null) => void;
  t: ReturnType<typeof createTranslator>;
  updateSettings: (update: DesktopSettingsUpdate) => void;
};

export function resolveProjectCanvasId(project: DesktopProjectSummary, requestedCanvasId?: string | null): string | null {
  if (requestedCanvasId !== undefined) {
    return requestedCanvasId;
  }
  if (project.activeCanvasId && project.taskCanvases.some((canvas) => canvas.canvasId === project.activeCanvasId)) {
    return project.activeCanvasId;
  }
  return project.taskCanvases[0]?.canvasId ?? null;
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

type ApplyDesktopProjectSnapshotOptions = {
  includeLayout?: boolean;
  includePrompt?: boolean;
};

export function useDesktopProject({
  setError,
  t,
  updateSettings
}: UseDesktopProjectArgs) {
  const [projects, setProjects] = useState<DesktopProjectSummary[]>([]);
  const [projectLoading, setProjectLoading] = useState(Boolean(bridge));
  const [selectedProject, setSelectedProject] = useState<DesktopProjectSummary | null>(null);
  const [selectedCanvasId, setSelectedCanvasId] = useState<string | null>(null);
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const [graph, setGraph] = useState<DesktopGraphViewModel | null>(null);
  const [layout, setLayout] = useState<DesktopLayout | null>(null);
  const [todoGroups, setTodoGroups] = useState<DesktopTodoGroups | null>(null);
  const [executionPlan, setExecutionPlan] = useState<DesktopProjectExecutionPlan | null>(null);
  const [statistics, setStatistics] = useState<DesktopStatistics | null>(null);
  const [projectPromptMarkdown, setProjectPromptMarkdown] = useState<string | null>(null);
  const [projectPromptPolicy, setProjectPromptPolicy] = useState<ProjectPromptPolicy | null>(null);
  const currentCanvasRef = useRef<{
    canvasId: string | null;
    hasGraph: boolean;
    projectRoot: string | null;
  }>({
    canvasId: null,
    hasGraph: false,
    projectRoot: null
  });

  useEffect(() => {
    currentCanvasRef.current = {
      canvasId: selectedCanvasId,
      hasGraph: Boolean(graph),
      projectRoot: selectedProject?.rootPath ?? null
    };
  }, [graph, selectedCanvasId, selectedProject?.rootPath]);

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
      return snapshot.errors;
    },
    []
  );

  const loadProject = useCallback(
    async (project: DesktopProjectSummary, requestedCanvasId?: string | null) => {
      if (!bridge) {
        setProjectLoading(false);
        return;
      }
      setProjectLoading(true);
      const canvasId = resolveProjectCanvasId(project, requestedCanvasId);
      const currentCanvas = currentCanvasRef.current;
      const canKeepCurrentCanvas =
        currentCanvas.hasGraph && currentCanvas.projectRoot === project.rootPath && currentCanvas.canvasId === canvasId;
      setSelectedProject(project);
      setSelectedCanvasId(canvasId);
      setExpandedProjectId(project.projectId);
      setError(null);
      if (!canKeepCurrentCanvas) {
        setGraph(null);
        setLayout(null);
        setTodoGroups(null);
        setExecutionPlan(null);
        setStatistics(null);
        setProjectPromptMarkdown(null);
        setProjectPromptPolicy(null);
      }
      const canvasRef = desktopCanvasReference(project, canvasId);
      const errors: string[] = [];
      try {
        const snapshot = await bridge.getDesktopProjectSnapshot(canvasRef);
        errors.push(...applyDesktopProjectSnapshot(snapshot, { includeLayout: true, includePrompt: true }));
        if (snapshot.graph) {
          try {
            await bridge.refreshPackageFileChanges(canvasRef);
            await bridge.watchPackageFiles(canvasRef);
          } catch (caught) {
            errors.push(errorMessage(caught));
          }
        }
      } catch (caught) {
        errors.push(errorMessage(caught));
      }
      if (errors.length > 0) {
        setError(errors.join("\n"));
      }
      updateSettings({ runtimePath: project.workspaceRoot });
      setProjectLoading(false);
    },
    [applyDesktopProjectSnapshot, setError, updateSettings]
  );

  useEffect(() => {
    if (!bridge) {
      setProjectLoading(false);
      return;
    }
    let cancelled = false;
    bridge
      .listProjects()
      .then((items) => {
        if (cancelled) {
          return;
        }
        setProjects(items);
        if (items[0]) {
          void loadProject(items[0]);
          return;
        }
        setProjectLoading(false);
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return;
        }
        setProjectLoading(false);
        setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [loadProject, setError]);

  useEffect(() => {
    const projectRoot = selectedProject?.rootPath;
    const canvasId = selectedCanvasId;
    return () => {
      if (bridge && projectRoot) {
        void bridge.unwatchPackageFiles({ projectRoot, canvasId });
      }
    };
  }, [selectedCanvasId, selectedProject?.rootPath]);

  const refreshGraph = useCallback(async () => {
    if (!bridge || !selectedProject) {
      return;
    }
    const nextGraph = await bridge.getGraphViewModel(desktopCanvasReference(selectedProject, selectedCanvasId));
    setGraph(nextGraph);
  }, [selectedCanvasId, selectedProject]);

  const refreshProjectDerivedState = useCallback(async (options: ApplyDesktopProjectSnapshotOptions = {}) => {
    if (!bridge || !selectedProject) {
      return;
    }
    const canvasRef = desktopCanvasReference(selectedProject, selectedCanvasId);
    const snapshot = await bridge.getDesktopProjectSnapshot(canvasRef);
    const errors = applyDesktopProjectSnapshot(snapshot, options);
    if (errors.length > 0) {
      setError(errors.join("\n"));
    }
  }, [applyDesktopProjectSnapshot, selectedCanvasId, selectedProject, setError]);

  const refreshGraphAndLayout = useCallback(async () => {
    await refreshProjectDerivedState({ includeLayout: true });
  }, [refreshProjectDerivedState]);

  const updateProjectPromptPolicy = useCallback(
    async (patch: Partial<ProjectPromptPolicy>) => {
      if (!bridge || !selectedProject) {
        return;
      }
      setProjectPromptPolicy(await bridge.updateProjectPromptPolicy(selectedProject.rootPath, patch));
    },
    [selectedProject]
  );

  const updateProjectPrompt = useCallback(
    async (markdown: string) => {
      if (!bridge || !selectedProject) {
        return;
      }
      setProjectPromptMarkdown(await bridge.updateProjectPrompt(selectedProject.rootPath, markdown));
    },
    [selectedProject]
  );

  const refreshProjectSummary = useCallback(
    async (projectRoot: string, canvasId?: string | null) => {
      if (!bridge) {
        return null;
      }
      const nextProjects = await bridge.listProjects();
      setProjects(nextProjects);
      const project = nextProjects.find((item) => item.rootPath === projectRoot) ?? null;
      if (project && selectedProject?.rootPath === projectRoot) {
        setSelectedProject(project);
        if (canvasId !== undefined) {
          setSelectedCanvasId(canvasId);
        }
      }
      return project;
    },
    [selectedProject?.rootPath]
  );

  const handleOpenProject = useCallback(async () => {
    if (!bridge) {
      setError(t("openProjectBridgeUnavailable"));
      return;
    }
    try {
      const selectedPath = await bridge.chooseProjectFolder();
      if (!selectedPath) {
        return;
      }
      const project = await bridge.initOrOpenProject(selectedPath);
      setProjects((items) => (items.some((item) => item.projectId === project.projectId) ? items : [...items, project]));
      await loadProject(project);
    } catch (caught) {
      setError(`${t("openProjectFailedHint")}\n${errorMessage(caught)}`);
    }
  }, [loadProject, setError, t]);

  const removeProject = useCallback(
    async (project: DesktopProjectSummary) => {
      if (!bridge) {
        return;
      }
      await bridge.removeProject(project.projectId);
      const nextProjects = await bridge.listProjects();
      setProjects(nextProjects);
      if (selectedProject?.projectId !== project.projectId) {
        return;
      }
      const nextProject = nextProjects[0] ?? null;
      if (nextProject) {
        await loadProject(nextProject);
        return;
      }
      setSelectedProject(null);
      setSelectedCanvasId(null);
      setExpandedProjectId(null);
      setGraph(null);
      setLayout(null);
      setTodoGroups(null);
      setExecutionPlan(null);
      setStatistics(null);
      setProjectPromptMarkdown(null);
      setProjectPromptPolicy(null);
    },
    [loadProject, selectedProject?.projectId]
  );

  return {
    expandedProjectId,
    executionPlan,
    graph,
    handleOpenProject,
    layout,
    loadProject,
    projectLoading,
    projects,
    projectPromptMarkdown,
    projectPromptPolicy,
    refreshProjectSummary,
    refreshGraph,
    refreshGraphAndLayout,
    refreshProjectDerivedState,
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
