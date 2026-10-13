import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from "react";
import type {
  DesktopGraphViewModel,
  DesktopProjectSummary,
  ValidationIssue,
  ProjectPromptPolicy
} from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "../bridge";
import { beginDesktopWatchRegistration } from "../desktopWatchRegistration";
import type { createTranslator } from "../i18n";
import type { DesktopSettingsUpdate } from "../types";
import type {
  ApplyDesktopProjectSnapshotOptions,
  CurrentDesktopCanvasRef,
  DesktopSelectionReceipt
} from "./useDesktopProjectSnapshot";

type UseDesktopProjectLoaderArgs = {
  planweaveHome: string;
  beginProjectSelection: (
    project: DesktopProjectSummary,
    canvasId: string | null
  ) => DesktopSelectionReceipt & { finishLoading: () => void };
  beginSelectionIntent: ReturnType<
    typeof import("./useDesktopProjectSnapshot").useDesktopProjectSnapshot
  >["beginSelectionIntent"];
  captureProjectSelection: ReturnType<
    typeof import("./useDesktopProjectSnapshot").useDesktopProjectSnapshot
  >["captureProjectSelection"];

  beginProjectRequest: ReturnType<
    typeof import("./useDesktopProjectSnapshot").useDesktopProjectSnapshot
  >["beginProjectRequest"];
  autoSelectInitialProject: boolean;
  beginSnapshotRequest: ReturnType<
    typeof import("./useDesktopProjectSnapshot").useDesktopProjectSnapshot
  >["beginSnapshotRequest"];
  applyDesktopProjectSnapshot: ReturnType<
    typeof import("./useDesktopProjectSnapshot").useDesktopProjectSnapshot
  >["applyDesktopProjectSnapshot"];
  clearProjectState: () => void;
  currentCanvasRef: MutableRefObject<CurrentDesktopCanvasRef>;
  initialProjectPath: string;
  refreshDesktopGraphDiagnostics: (
    canvasRef: {
      projectRoot: string;
      canvasId?: string | null;
    },
    isOwnerCurrent: () => boolean
  ) => Promise<boolean>;
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
  settingsHydrated: boolean;
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
  setGraph,
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
}: UseDesktopProjectLoaderArgs) {
  const promptWrites = useRef({ markdown: 0, policy: 0 });
  const packageWatch = useRef<
    | (ReturnType<typeof beginDesktopWatchRegistration> & {
        isCurrent: () => boolean;
      })
    | null
  >(null);
  const stopPackageWatch = useCallback(() => {
    const registration = packageWatch.current;
    if (!registration) return;
    packageWatch.current = null;
    registration.retire();
    void bridge?.unwatchPackageFiles(registration.reference).catch((caught: unknown) => {
      if (packageWatch.current === null && registration.isCurrent()) setError(errorMessage(caught));
    });
  }, [setError]);
  const stopPackageWatchRef = useRef(stopPackageWatch);
  stopPackageWatchRef.current = stopPackageWatch;
  useLayoutEffect(() => {
    if (packageWatch.current && !packageWatch.current.isCurrent()) stopPackageWatch();
  });
  useLayoutEffect(() => () => stopPackageWatchRef.current(), []);
  const initialProjectsLoaded = useRef(false);
  const initialProjectsHome = useRef(planweaveHome);
  const initialProjectPathRef = useRef<string | null>(null);
  const autoSelectInitialProjectRef = useRef<boolean | null>(null);
  if (settingsHydrated && initialProjectPathRef.current === null) {
    initialProjectPathRef.current = initialProjectPath;
    autoSelectInitialProjectRef.current = autoSelectInitialProject;
  }

  const loadProject = useCallback(
    async (
      project: DesktopProjectSummary,
      requestedCanvasId?: string | null,
      existingSelection?: DesktopSelectionReceipt & { finishLoading: () => void },
      isOperationCurrent?: () => boolean
    ) => {
      if (isOperationCurrent && !isOperationCurrent()) return;
      const canvasId = resolveProjectCanvasId(project, requestedCanvasId);
      const selection = existingSelection ?? beginProjectSelection(project, canvasId);
      if (!selection.isCurrent()) return;
      if (!bridge) {
        selection.finishLoading();
        return;
      }
      const canvasRef = desktopCanvasReference(project, canvasId);
      const loadRequest = beginProjectRequest(canvasRef, "load");
      const isCurrent = () =>
        loadRequest.isCurrent() && (!isOperationCurrent || isOperationCurrent());
      const request = beginSnapshotRequest(canvasRef, { includeLayout: true, includePrompt: true });
      const errors: string[] = [];
      let publishSnapshotDiagnostics: (() => string[]) | null = null;
      try {
        try {
          const snapshot = await bridge.getDesktopProjectSnapshot(canvasRef);
          if (!isCurrent()) return;
          if (request.isCurrent()) {
            publishSnapshotDiagnostics = applyDesktopProjectSnapshot(snapshot, request.writeScope);
            if (snapshot.graph && request.graph.isCurrent()) {
              await refreshDesktopGraphDiagnostics(
                canvasRef,
                () => isCurrent() && request.graph.isCurrent()
              );
            }
          }
          if (!isCurrent()) return;
          if (snapshot.graph) {
            await bridge.refreshPackageFileChanges(canvasRef);
            if (!isCurrent()) return;
            stopPackageWatch();
            const registration = { ...beginDesktopWatchRegistration(project, canvasId), isCurrent };
            packageWatch.current = registration;
            try {
              await bridge.watchPackageFiles(registration.reference);
            } catch (caught) {
              registration.retire();
              if (packageWatch.current === registration) packageWatch.current = null;
              throw caught;
            }
          }
        } catch (caught) {
          if (!isCurrent() || !request.isCurrent()) return;
          errors.push(errorMessage(caught));
        }
        if (!isCurrent()) return;
        if (publishSnapshotDiagnostics) errors.push(...publishSnapshotDiagnostics());
        if (request.isCurrent() && errors.length > 0) setError(errors.join("\n"));
        updateSettings({ runtimePath: project.workspaceRoot });
      } finally {
        if (loadRequest.isCurrent()) selection.finishLoading();
      }
    },
    [
      applyDesktopProjectSnapshot,
      beginProjectRequest,
      beginProjectSelection,
      beginSnapshotRequest,
      refreshDesktopGraphDiagnostics,
      setError,
      stopPackageWatch,
      updateSettings
    ]
  );

  useEffect(() => {
    if (initialProjectsHome.current !== planweaveHome) {
      initialProjectsHome.current = planweaveHome;
      initialProjectsLoaded.current = false;
    }
    if (!settingsHydrated || initialProjectsLoaded.current) {
      return;
    }
    if (!bridge) {
      setProjectLoading(false);
      return;
    }
    let cancelled = false;
    const request = captureProjectSelection("projects");
    bridge
      .listProjects()
      .then((items) => {
        if (cancelled) return;
        initialProjectsLoaded.current = true;
        if (!request.isCurrent()) return;
        setProjects(items);
        if (autoSelectInitialProjectRef.current === false) {
          setProjectLoading(false);
          return;
        }
        const persistedProject = items.find(
          (item) => item.workspaceRoot === initialProjectPathRef.current
        );
        const initialProject = persistedProject ?? items[0];
        if (initialProject) {
          void loadProject(initialProject);
          return;
        }
        setProjectLoading(false);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        initialProjectsLoaded.current = true;
        if (!request.isCurrent()) return;
        setProjectLoading(false);
        setError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [
    captureProjectSelection,
    loadProject,
    planweaveHome,
    setError,
    setProjectLoading,
    setProjects,
    settingsHydrated
  ]);

  const refreshGraph = useCallback(async () => {
    if (!bridge || !selectedProject) {
      return;
    }
    const canvasRef = desktopCanvasReference(selectedProject, selectedCanvasId);
    const request = beginProjectRequest(canvasRef, "graph");
    if (!request.isCurrent()) return;
    try {
      const nextGraph = await bridge.getGraphViewModel(canvasRef);
      if (!request.isCurrent()) return;
      setGraph(nextGraph);
      setGraphDiagnostics([]);
      await refreshDesktopGraphDiagnostics(canvasRef, request.isCurrent);
    } catch (caught) {
      if (request.isCurrent()) throw caught;
    }
  }, [
    beginProjectRequest,
    refreshDesktopGraphDiagnostics,
    selectedCanvasId,
    selectedProject,
    setGraph,
    setGraphDiagnostics
  ]);

  const refreshProjectDerivedState = useCallback(
    async (options: ApplyDesktopProjectSnapshotOptions = {}) => {
      if (!bridge || !selectedProject || options.isOwnerCurrent?.() === false) return;
      const canvasRef = desktopCanvasReference(selectedProject, selectedCanvasId);
      const request = beginSnapshotRequest(canvasRef, options);
      const assertCurrent = () => {
        if (request.isCurrent() && options.isOwnerCurrent?.() !== false) return true;
        if (options.requireCurrentCanvas) throw new Error("project_canvas_changed_during_refresh");
        return false;
      };
      if (!assertCurrent()) return;
      try {
        const snapshot = await bridge.getDesktopProjectSnapshot(canvasRef);
        if (!assertCurrent()) return;
        const publishSnapshotDiagnostics = applyDesktopProjectSnapshot(
          snapshot,
          request.writeScope
        );
        if (snapshot.graph && request.graph.isCurrent()) {
          await refreshDesktopGraphDiagnostics(canvasRef, request.graph.isCurrent);
          if (!assertCurrent()) return;
        }
        const errors = publishSnapshotDiagnostics();
        if (errors.length > 0) {
          setError(errors.join("\n"));
          if (options.throwOnErrors) throw new Error(errors.join("\n"));
        }
      } catch (caught) {
        if (request.isCurrent() || options.requireCurrentCanvas) throw caught;
      }
    },
    [
      applyDesktopProjectSnapshot,
      beginSnapshotRequest,
      refreshDesktopGraphDiagnostics,
      selectedCanvasId,
      selectedProject,
      setError
    ]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a Home switch reloads the current project's authority; selection loads already include it.
  useEffect(() => {
    if (!selectedProject) return;
    const request = beginProjectRequest(
      desktopCanvasReference(selectedProject, selectedCanvasId),
      "prompt"
    );
    void refreshProjectDerivedState({ includePrompt: true }).catch((caught: unknown) => {
      if (request.isSelectionCurrent()) setError(errorMessage(caught));
    });
  }, [planweaveHome]);

  const refreshGraphAndLayout = useCallback(async () => {
    await refreshProjectDerivedState({ includeLayout: true });
  }, [refreshProjectDerivedState]);

  const updateProjectPromptPolicy = useCallback(
    async (patch: Partial<ProjectPromptPolicy>) => {
      if (!bridge || !selectedProject) {
        return;
      }
      const request = beginProjectRequest(
        desktopCanvasReference(selectedProject, selectedCanvasId),
        "prompt"
      );
      if (!request.isSelectionCurrent()) return;
      const write = ++promptWrites.current.policy;
      const current = () => request.isSelectionCurrent() && promptWrites.current.policy === write;
      try {
        const updated = await bridge.updateProjectPromptPolicy(selectedProject.rootPath, patch);
        if (current()) setProjectPromptPolicy(updated);
      } catch (caught) {
        if (current()) setError(errorMessage(caught));
      }
    },
    [beginProjectRequest, selectedCanvasId, selectedProject, setError, setProjectPromptPolicy]
  );

  const updateProjectPrompt = useCallback(
    async (markdown: string): Promise<boolean> => {
      if (!bridge || !selectedProject) {
        return false;
      }
      const request = beginProjectRequest(
        desktopCanvasReference(selectedProject, selectedCanvasId),
        "prompt"
      );
      if (!request.isSelectionCurrent()) return false;
      const write = ++promptWrites.current.markdown;
      const current = () => request.isSelectionCurrent() && promptWrites.current.markdown === write;
      try {
        const updated = await bridge.updateProjectPrompt(selectedProject.rootPath, markdown);
        if (!current()) return false;
        setProjectPromptMarkdown(updated);
        return true;
      } catch (caught) {
        if (current()) {
          setError(errorMessage(caught));
          throw caught;
        }
      }
      return false;
    },
    [beginProjectRequest, selectedCanvasId, selectedProject, setError, setProjectPromptMarkdown]
  );

  const refreshProjectSummary = useCallback(
    async (projectRoot: string, canvasId?: string | null) => {
      if (!bridge) {
        return null;
      }
      const request = captureProjectSelection("projects");
      const nextProjects = await bridge.listProjects();
      if (!request.isCurrent()) return null;
      setProjects(nextProjects);
      const project = nextProjects.find((item) => item.rootPath === projectRoot) ?? null;
      if (project && currentCanvasRef.current.projectRoot === projectRoot) {
        setSelectedProject(project);
        if (canvasId !== undefined) {
          setSelectedCanvasId(canvasId);
        }
      }
      return project;
    },
    [
      captureProjectSelection,
      currentCanvasRef,
      setProjects,
      setSelectedCanvasId,
      setSelectedProject
    ]
  );

  const refreshProjects = useCallback(
    async (
      options: { selectProjectId?: string; selectCanvasId?: string; isCurrent?: () => boolean } = {}
    ) => {
      if (!bridge || (options.isCurrent && !options.isCurrent())) {
        return;
      }
      const request = captureProjectSelection("projects");
      const isCurrent = () => request.isCurrent() && (!options.isCurrent || options.isCurrent());
      setProjectRefreshing(true);
      try {
        const nextProjects = await bridge.listProjects();
        if (!isCurrent()) return;
        setProjects(nextProjects);
        const requestedProject = options.selectProjectId
          ? (nextProjects.find((item) => item.projectId === options.selectProjectId) ?? null)
          : null;
        if (requestedProject) {
          await loadProject(requestedProject, options.selectCanvasId, undefined, options.isCurrent);
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
          await loadProject(nextProject, undefined, undefined, options.isCurrent);
          return;
        }
        setSelectedProject(null);
        setSelectedCanvasId(null);
        setExpandedProjectId(null);
        clearProjectState();
        setError(null);
      } catch (caught) {
        if (isCurrent()) setError(errorMessage(caught));
      } finally {
        if (request.isCurrent()) setProjectRefreshing(false);
      }
    },
    [
      captureProjectSelection,
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
      return false;
    }
    const request = beginSelectionIntent();
    try {
      const selectedPath = await bridge.chooseProjectFolder();
      if (!request.isCurrent() || !selectedPath) {
        return false;
      }
      const project = await bridge.initOrOpenProject(selectedPath);
      if (!request.isCurrent()) return false;
      setProjects((items) =>
        items.some((item) => item.projectId === project.projectId) ? items : [...items, project]
      );
      await loadProject(project);
      return true;
    } catch (caught) {
      if (request.isCurrent()) setError(`${t("openProjectFailedHint")}\n${errorMessage(caught)}`);
      return false;
    }
  }, [beginSelectionIntent, loadProject, setError, setProjects, t]);

  const removeProject = useCallback(
    async (project: DesktopProjectSummary) => {
      if (!bridge) {
        return;
      }
      const request = captureProjectSelection("projects");
      await bridge.removeProject(project.projectId);
      if (!request.isCurrent()) return;
      const nextProjects = await bridge.listProjects();
      if (!request.isCurrent()) return;
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
      captureProjectSelection,
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
