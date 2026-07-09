import {
  useCallback,
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from "react";
import type {
  DesktopGraphViewModel,
  DesktopProjectSnapshot,
  DesktopProjectSummary,
  ValidationIssue,
  ProjectPromptPolicy
} from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "../bridge";
import type { createTranslator } from "../i18n";
import type { DesktopSettingsUpdate } from "../types";
import type {
  ApplyDesktopProjectSnapshotOptions,
  CurrentDesktopCanvasRef
} from "./useDesktopProjectSnapshot";

type UseDesktopProjectLoaderArgs = {
  applyDesktopProjectSnapshot: (
    snapshot: DesktopProjectSnapshot,
    options?: ApplyDesktopProjectSnapshotOptions
  ) => string[];
  clearProjectState: () => void;
  currentCanvasRef: MutableRefObject<CurrentDesktopCanvasRef>;
  refreshDesktopGraphDiagnostics: (canvasRef: {
    projectRoot: string;
    canvasId?: string | null;
  }) => Promise<boolean>;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
  setExpandedProjectId: Dispatch<SetStateAction<string | null>>;
  setGraph: (value: DesktopGraphViewModel | null) => void;
  setGraphDiagnostics: (value: ValidationIssue[]) => void;
  setProjectLoading: (value: boolean) => void;
  setProjectPromptMarkdown: (value: string | null) => void;
  setProjectPromptPolicy: (value: ProjectPromptPolicy | null) => void;
  setProjectRefreshing: (value: boolean) => void;
  setProjects: Dispatch<SetStateAction<DesktopProjectSummary[]>>;
  setSelectedCanvasId: Dispatch<SetStateAction<string | null>>;
  setSelectedProject: (value: DesktopProjectSummary | null) => void;
  t: ReturnType<typeof createTranslator>;
  updateSettings: (update: DesktopSettingsUpdate) => void;
};

export function resolveProjectCanvasId(
  project: DesktopProjectSummary,
  requestedCanvasId?: string | null
): string | null {
  if (requestedCanvasId !== undefined) {
    return requestedCanvasId;
  }
  if (
    project.activeCanvasId &&
    project.taskCanvases.some((canvas) => canvas.canvasId === project.activeCanvasId)
  ) {
    return project.activeCanvasId;
  }
  return project.taskCanvases[0]?.canvasId ?? null;
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

export function useDesktopProjectLoader({
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
}: UseDesktopProjectLoaderArgs) {
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
        currentCanvas.hasGraph &&
        currentCanvas.projectRoot === project.rootPath &&
        currentCanvas.canvasId === canvasId;
      currentCanvasRef.current = {
        canvasId,
        hasGraph: canKeepCurrentCanvas ? currentCanvas.hasGraph : false,
        projectRoot: project.rootPath
      };
      setSelectedProject(project);
      setSelectedCanvasId(canvasId);
      setExpandedProjectId(project.projectId);
      setError(null);
      if (!canKeepCurrentCanvas) {
        clearProjectState();
      }
      const canvasRef = desktopCanvasReference(project, canvasId);
      const isCurrentCanvasRequest = () => {
        const currentCanvas = currentCanvasRef.current;
        return (
          currentCanvas.projectRoot === canvasRef.projectRoot &&
          currentCanvas.canvasId === canvasRef.canvasId
        );
      };
      const errors: string[] = [];
      try {
        const snapshot = await bridge.getDesktopProjectSnapshot(canvasRef);
        if (!isCurrentCanvasRequest()) {
          return;
        }
        errors.push(
          ...applyDesktopProjectSnapshot(snapshot, { includeLayout: true, includePrompt: true })
        );
        if (snapshot.graph) {
          try {
            const diagnosticsApplied = await refreshDesktopGraphDiagnostics(canvasRef);
            if (!diagnosticsApplied || !isCurrentCanvasRequest()) {
              return;
            }
            await bridge.refreshPackageFileChanges(canvasRef);
            if (!isCurrentCanvasRequest()) {
              return;
            }
            await bridge.watchPackageFiles(canvasRef);
            if (!isCurrentCanvasRequest()) {
              return;
            }
          } catch (caught) {
            if (!isCurrentCanvasRequest()) {
              return;
            }
            errors.push(errorMessage(caught));
          }
        } else {
          if (!isCurrentCanvasRequest()) {
            return;
          }
          setGraphDiagnostics([]);
        }
      } catch (caught) {
        if (!isCurrentCanvasRequest()) {
          return;
        }
        errors.push(errorMessage(caught));
      }
      if (!isCurrentCanvasRequest()) {
        return;
      }
      if (errors.length > 0) {
        setError(errors.join("\n"));
      }
      updateSettings({ runtimePath: project.workspaceRoot });
      setProjectLoading(false);
    },
    [
      applyDesktopProjectSnapshot,
      clearProjectState,
      currentCanvasRef,
      refreshDesktopGraphDiagnostics,
      setError,
      setExpandedProjectId,
      setGraphDiagnostics,
      setProjectLoading,
      setSelectedCanvasId,
      setSelectedProject,
      updateSettings
    ]
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
        setError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [loadProject, setError, setProjectLoading, setProjects]);

  const refreshGraph = useCallback(async () => {
    if (!bridge || !selectedProject) {
      return;
    }
    const canvasRef = desktopCanvasReference(selectedProject, selectedCanvasId);
    const nextGraph = await bridge.getGraphViewModel(canvasRef);
    setGraph(nextGraph);
    await refreshDesktopGraphDiagnostics(canvasRef);
  }, [refreshDesktopGraphDiagnostics, selectedCanvasId, selectedProject, setGraph]);

  const refreshProjectDerivedState = useCallback(
    async (options: ApplyDesktopProjectSnapshotOptions = {}) => {
      if (!bridge || !selectedProject) {
        return;
      }
      const canvasRef = desktopCanvasReference(selectedProject, selectedCanvasId);
      const snapshot = await bridge.getDesktopProjectSnapshot(canvasRef);
      const currentCanvas = currentCanvasRef.current;
      if (
        currentCanvas.projectRoot !== canvasRef.projectRoot ||
        currentCanvas.canvasId !== canvasRef.canvasId
      ) {
        return;
      }
      const errors = applyDesktopProjectSnapshot(snapshot, options);
      if (snapshot.graph) {
        const diagnosticsApplied = await refreshDesktopGraphDiagnostics(canvasRef);
        if (!diagnosticsApplied) {
          return;
        }
      } else {
        setGraphDiagnostics([]);
      }
      if (errors.length > 0) {
        setError(errors.join("\n"));
      }
    },
    [
      applyDesktopProjectSnapshot,
      currentCanvasRef,
      refreshDesktopGraphDiagnostics,
      selectedCanvasId,
      selectedProject,
      setError,
      setGraphDiagnostics
    ]
  );

  const refreshGraphAndLayout = useCallback(async () => {
    await refreshProjectDerivedState({ includeLayout: true });
  }, [refreshProjectDerivedState]);

  const updateProjectPromptPolicy = useCallback(
    async (patch: Partial<ProjectPromptPolicy>) => {
      if (!bridge || !selectedProject) {
        return;
      }
      setProjectPromptPolicy(
        await bridge.updateProjectPromptPolicy(selectedProject.rootPath, patch)
      );
    },
    [selectedProject, setProjectPromptPolicy]
  );

  const updateProjectPrompt = useCallback(
    async (markdown: string) => {
      if (!bridge || !selectedProject) {
        return;
      }
      setProjectPromptMarkdown(
        await bridge.updateProjectPrompt(selectedProject.rootPath, markdown)
      );
    },
    [selectedProject, setProjectPromptMarkdown]
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
    [selectedProject?.rootPath, setProjects, setSelectedCanvasId, setSelectedProject]
  );

  const refreshProjects = useCallback(
    async (options: { selectProjectId?: string } = {}) => {
      if (!bridge) {
        return;
      }
      setProjectRefreshing(true);
      try {
        const nextProjects = await bridge.listProjects();
        setProjects(nextProjects);
        const requestedProject = options.selectProjectId
          ? (nextProjects.find((item) => item.projectId === options.selectProjectId) ?? null)
          : null;
        if (requestedProject) {
          await loadProject(requestedProject);
          return;
        }
        const currentProject =
          nextProjects.find((item) => item.projectId === selectedProject?.projectId) ??
          nextProjects.find((item) => item.rootPath === selectedProject?.rootPath) ??
          null;
        if (currentProject) {
          setSelectedProject(currentProject);
          setSelectedCanvasId((currentCanvasId) =>
            currentCanvasId &&
            currentProject.taskCanvases.some((canvas) => canvas.canvasId === currentCanvasId)
              ? currentCanvasId
              : resolveProjectCanvasId(currentProject)
          );
          setExpandedProjectId((currentExpandedProjectId) =>
            currentExpandedProjectId === selectedProject?.projectId
              ? currentProject.projectId
              : currentExpandedProjectId
          );
          setError(null);
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
        clearProjectState();
        setError(null);
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setProjectRefreshing(false);
      }
    },
    [
      clearProjectState,
      loadProject,
      selectedProject?.projectId,
      selectedProject?.rootPath,
      setError,
      setExpandedProjectId,
      setProjectRefreshing,
      setProjects,
      setSelectedCanvasId,
      setSelectedProject
    ]
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
      setProjects((items) =>
        items.some((item) => item.projectId === project.projectId) ? items : [...items, project]
      );
      await loadProject(project);
    } catch (caught) {
      setError(`${t("openProjectFailedHint")}\n${errorMessage(caught)}`);
    }
  }, [loadProject, setError, setProjects, t]);

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
      clearProjectState();
    },
    [
      clearProjectState,
      loadProject,
      selectedProject?.projectId,
      setExpandedProjectId,
      setProjects,
      setSelectedCanvasId,
      setSelectedProject
    ]
  );

  return {
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
  };
}
