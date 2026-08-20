import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { type Edge, type ReactFlowInstance, useEdgesState, useNodesState } from "@xyflow/react";
import type { DesktopProjectSummary } from "@planweave-ai/runtime";
import { bridge, collaborationBridge, desktopCanvasReference } from "./bridge";
import { edgeTypes, nodeTypes } from "./graph/flowModel";
import { orderProjectsByPinnedIds } from "./settings";
import type { AppFlowNode } from "./types";
import { useReviewPipeline } from "./hooks/useReviewPipeline";
import { useGraphPaletteActions } from "./hooks/useGraphPaletteActions";
import { useSelectedBlock } from "./hooks/useSelectedBlock";
import { useDesktopProject } from "./hooks/useDesktopProject";
import { useDesktopProjectSession } from "./hooks/useDesktopProjectSession";
import { usePromptDrafts } from "./hooks/usePromptDrafts";
import { useGraphDeleteActions } from "./hooks/useGraphDeleteActions";
import { useTaskNodeFocus } from "./hooks/useTaskNodeFocus";
import { useTaskExecutorActions } from "./hooks/useTaskExecutorActions";
import { useTaskAgentEndpointSelection } from "./hooks/useTaskAgentEndpointSelection";
import { useOwnerControlPlaneAvailability } from "./hooks/useOwnerControlPlaneAvailability";
import { useWorkspaceAgentEndpointCatalog } from "./hooks/useWorkspaceAgentEndpointCatalog";
import { useWorkspaceAgentEndpointRun } from "./hooks/useWorkspaceAgentEndpointRun";
import { useDesktopProjectActions } from "./hooks/useDesktopProjectActions";
import { useGraphFlowModel } from "./hooks/useGraphFlowModel";
import { useGraphHistoryActions } from "./hooks/useGraphHistoryActions";
import { useSharedResourceHighlight } from "./hooks/useSharedResourceHighlight";
import { useLerpedNodeDrag } from "./hooks/useLerpedNodeDrag";
import { useCollaborationSurface } from "./hooks/useCollaborationSurface";
import { useCollaborationCanvasPresence } from "./hooks/useCollaborationCanvasPresence";
import { useWorkspaceCollaborationRuntimeAvailability } from "./hooks/useWorkspaceCollaborationRuntimeAvailability";
import { useSharedCanvasCommands } from "./hooks/useSharedCanvasCommands";
import { canvasReplicaProjectionToDesktopGraph } from "./collaboration/canvasReplicaGraphAdapter";
import { buildAppSettingsRouteProps } from "./AppSettingsRouteProps";
import { useAutoRunController, useFileSyncController } from "./controllers/AutoRunController";
import { useGraphWorkspaceController } from "./controllers/GraphWorkspaceController";
import { useNotificationController } from "./controllers/NotificationController";
import { useSearchController } from "./controllers/SearchController";
import { writeAgentScopePromptToClipboard } from "./agentPrompt";
import { uniqueDesktopDiagnostics } from "./diagnostics";
import type {
  WorkspaceTabsAutoRunProps,
  WorkspaceTabsFileSyncProps,
  WorkspaceTabsGraphWorkspaceProps,
  WorkspaceTabsNotificationsProps,
  WorkspaceTabsPlanningProps,
  WorkspaceTabsReviewProps,
  WorkspaceTabsSearchProps,
  WorkspaceTabsShellProps
} from "./views/WorkspaceTabs";
import type { ComponentProps } from "react";
import type { AppSettingsRoute } from "./AppSettingsRoute";
import type { ProjectSidebar } from "./sidebar/ProjectSidebar";
import type { TaskWorkspaceController } from "./task-workspace/contracts";
import { useTaskWorkspaceController } from "./task-workspace/useTaskWorkspaceController";
import { useTaskWorkspaceGraphNavigation } from "./task-workspace/useTaskWorkspaceGraphNavigation";
import {
  useRecordWorkspaceNavigation,
  type RecordNavigationSource,
  type RecordWorkspaceLocator
} from "./task-workspace/useRecordWorkspaceNavigation";
import type {
  RecordAuthorityTarget,
  TaskWorkspaceNavigationTarget
} from "./taskWorkspaceNavigation";
import { collaborationSurfaceCanvasIdForView } from "./collaboration/workspaceCollaborationScope";
import { useRemoteCanvasWorkspace } from "./hooks/useRemoteCanvasWorkspace";
import type { ProjectWorkspaceShellInput } from "./projectWorkspaceShell";
export type { ProjectWorkspaceShellInput } from "./projectWorkspaceShell";

type TaskCanvasSummary = DesktopProjectSummary["taskCanvases"][number];
type AppSettingsRouteProps = ComponentProps<typeof AppSettingsRoute>;
type ProjectSidebarProps = ComponentProps<typeof ProjectSidebar>;

function canvasPackageDir(project: DesktopProjectSummary, canvasId: string | null): string | null {
  return project.taskCanvases.find((canvas) => canvas.canvasId === canvasId)?.packageDir ?? null;
}

function unavailablePackageDirMessage(canvasId: string): string {
  return `Cannot copy agent prompt because packageDir is unavailable for canvas '${canvasId}'.`;
}

export type ProjectWorkspaceValue = {
  autoRun: WorkspaceTabsAutoRunProps;
  fileSync: WorkspaceTabsFileSyncProps;
  graphWorkspace: WorkspaceTabsGraphWorkspaceProps;
  notifications: WorkspaceTabsNotificationsProps;
  palette: {
    addPaletteComponent: ReturnType<typeof useGraphPaletteActions>["addPaletteComponent"];
    handlePaletteDragStart: ReturnType<typeof useGraphPaletteActions>["handlePaletteDragStart"];
  };
  planning: WorkspaceTabsPlanningProps;
  projectSidebar: Omit<
    ProjectSidebarProps,
    "collapsed" | "onResizeStart" | "onToggleSidebar" | "width"
  >;
  review: WorkspaceTabsReviewProps;
  search: WorkspaceTabsSearchProps;
  settingsRouteProps: AppSettingsRouteProps;
  shell: WorkspaceTabsShellProps;
  taskWorkspace: TaskWorkspaceController;
};

const ProjectWorkspaceContext = createContext<ProjectWorkspaceValue | null>(null);

export function useProjectWorkspace(): ProjectWorkspaceValue {
  const value = useContext(ProjectWorkspaceContext);
  if (!value) {
    throw new Error("useProjectWorkspace must be used within ProjectWorkspaceProvider");
  }
  return value;
}

export function ProjectWorkspaceProvider({
  children,
  shell: shellInput
}: {
  children: ReactNode;
  shell: ProjectWorkspaceShellInput;
}) {
  const {
    activeView,
    appHistory,
    agentDetectionRefreshing,
    agentDetections,
    globalPromptMarkdown,
    language,
    refreshAgentDetections,
    refreshRuntimeTools,
    runtimeTools,
    setActiveView,
    setError,
    setSuccessMessage,
    settings,
    settingsHydrated,
    t,
    updateLayoutSettings,
    updateGlobalPrompt,
    updateSettings,
    updateSettingsAndWait
  } = shellInput;

  const [, setBlockInspectorOpen] = useState(false);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<AppFlowNode, Edge> | null>(
    null
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<AppFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const lerpedNodeDrag = useLerpedNodeDrag({
    nodes,
    setNodes,
    onNodesChange,
    enabled: !settings.reducedMotion
  });

  const desktopProject = useDesktopProject({
    initialProjectPath: settings.runtimePath,
    setError,
    settingsHydrated,
    t,
    updateSettings
  });
  const {
    expandedProjectId,
    executionPlan,
    graph: localGraph,
    graphDiagnostics,
    handleOpenProject,
    layout: localLayout,
    projects,
    pendingImportRecoveries,
    projectLoading,
    projectDiagnostics,
    projectPromptMarkdown,
    projectPromptPolicy,
    projectRefreshing,
    refreshProjects,
    refreshProjectSummary,
    refreshGraph,
    refreshProjectDerivedState,
    rollbackPendingImportRecovery,
    runtimeDiagnostics,
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
  } = desktopProject;

  const remoteWorkspace = useRemoteCanvasWorkspace({ localProjectId: selectedProject?.projectId });
  const selectRemoteCanvas = useCallback(
    (canvas: Parameters<typeof remoteWorkspace.select>[0]) => {
      setSelectedProject(null);
      setSelectedCanvasId(null);
      remoteWorkspace.select(canvas);
      setActiveView("graph");
    },
    [remoteWorkspace.select, setActiveView, setSelectedCanvasId, setSelectedProject]
  );
  const activeCanvasId = remoteWorkspace.binding?.canvasId ?? selectedCanvasId;
  const workspaceProjectLoading = remoteWorkspace.binding ? false : projectLoading;
  const canvasBinding = useMemo(
    () =>
      remoteWorkspace.binding ??
      (selectedProject && selectedCanvasId
        ? {
            kind: "local" as const,
            localProjectId: selectedProject.projectId,
            canvasId: selectedCanvasId
          }
        : null),
    [remoteWorkspace.binding, selectedCanvasId, selectedProject]
  );
  // Shared canvas command session must be available before any durable package write hooks.
  const collaborationSurface = useCollaborationSurface({
    binding: canvasBinding,
    canvasId: collaborationSurfaceCanvasIdForView(activeView, activeCanvasId),
    localProjectId: selectedProject?.projectId ?? null,
    t
  });
  const sharedCanvasCommands = useSharedCanvasCommands({
    api: collaborationBridge,
    binding: canvasBinding,
    // A configured shared project remains read-only while offline; package writers must not
    // fall through to local direct writes merely because its session disconnected.
    enabled: canvasBinding !== null,
    sessionConnected: collaborationSurface.sessionConnected,
    profileId: collaborationSurface.activeProfileId,
    activeProjectId: collaborationSurface.activeProjectId,
    localOwnerDirectWriteAvailable: collaborationSurface.localOwnerDirectWriteAvailable,
    t,
    onAuthoritativeChange: async () => {
      await refreshProjectDerivedState();
    }
  });
  const replicaGraph = useMemo(
    () =>
      sharedCanvasCommands.projection
        ? canvasReplicaProjectionToDesktopGraph(sharedCanvasCommands.projection, localGraph)
        : remoteWorkspace.binding
          ? null
          : localGraph,
    [localGraph, remoteWorkspace.binding, sharedCanvasCommands.projection]
  );
  const layout =
    sharedCanvasCommands.projection?.content.layout ??
    (remoteWorkspace.binding ? null : localLayout);
  const collaborationRuntime = useWorkspaceCollaborationRuntimeAvailability({
    activeProfileId: collaborationSurface.activeProfileId,
    activeProjectId: collaborationSurface.activeProjectId,
    graph: replicaGraph,
    localOwnerDirectWriteAvailable: collaborationSurface.localOwnerDirectWriteAvailable,
    sessionConnected: collaborationSurface.sessionConnected,
    binding: canvasBinding
  });
  const graph = collaborationRuntime.graph;
  const ownerControlPlane = useOwnerControlPlaneAvailability();
  const agentEndpointCatalog = useWorkspaceAgentEndpointCatalog({
    agentDetections,
    agentTransport: settings.execution.agentTransport,
    enabled: ownerControlPlane.fleetCatalogEnabled,
    fleetCatalogBlockedCode: ownerControlPlane.fleetCatalogBlockedCode,
    graph,
    operatorProfileId: ownerControlPlane.operatorProfileId,
    updateSettingsAndWait
  });

  const pinnedProjectIds = useMemo(
    () => new Set(settings.pinnedProjectIds),
    [settings.pinnedProjectIds]
  );
  const orderedProjects = useMemo(
    () => orderProjectsByPinnedIds(projects, settings.pinnedProjectIds),
    [projects, settings.pinnedProjectIds]
  );
  const handleTogglePinnedProject = useCallback(
    (projectId: string) => {
      updateSettings((current) => {
        const currentPinnedProjectIds = new Set(current.pinnedProjectIds);
        return {
          pinnedProjectIds: currentPinnedProjectIds.has(projectId)
            ? current.pinnedProjectIds.filter((pinnedProjectId) => pinnedProjectId !== projectId)
            : [...current.pinnedProjectIds, projectId]
        };
      });
    },
    [updateSettings]
  );

  const {
    clearSelectedBlockRecords,
    handleBlockSelect,
    handleOpenRunRecord,
    restoreBlockSelection,
    saveSelectedBlockPrompt,
    saveSelectedBlockTitle,
    selectedBlock,
    setSelectedBlock,
    setSelectedRunRecord
  } = useSelectedBlock({
    refreshGraph,
    selectedCanvasId,
    selectedProject,
    setActiveView,
    setError,
    sharedCanvas: sharedCanvasCommands
  });

  const {
    autoRunDiagnostics,
    autoRunState,
    clearTaskPanelSelection,
    createProjectFromTaskCanvas: createProjectFromTaskCanvasInSession,
    createTaskCanvas: createTaskCanvasInSession,
    deleteTaskCanvas: deleteTaskCanvasInSession,
    duplicateTaskCanvas: duplicateTaskCanvasInSession,
    openBlockInspector: handleOpenBlockInspector,
    openProject: openProjectInSession,
    openTaskInspector: handleOpenTaskInspector,
    renameTaskCanvas: renameTaskCanvasInSession,
    reloadCurrentCanvas,
    restoreTaskPanelSelection,
    selectedTaskPanelId,
    selectTaskPanel: handleTaskPanelSelect,
    setAutoRunState,
    taskFocusRequest
  } = useDesktopProjectSession({
    clearSelectedBlockRecords,
    language,
    projectState: desktopProject,
    selectBlock: handleBlockSelect,
    setActiveView,
    setBlockInspectorOpen,
    setError,
    setSelectedBlock,
    setSelectedRunRecord
  });
  const openLocalProject = useCallback(
    async (...args: Parameters<typeof openProjectInSession>) => {
      remoteWorkspace.clear();
      return openProjectInSession(...args);
    },
    [openProjectInSession, remoteWorkspace.clear]
  );

  const createLocalProjectFromTaskCanvas = useCallback(
    async (project: DesktopProjectSummary, canvasId: string) => {
      const isCurrentSharedCanvas =
        sharedCanvasCommands.enabled &&
        selectedProject?.projectId === project.projectId &&
        selectedCanvasId === canvasId;
      if (isCurrentSharedCanvas) {
        if (!collaborationBridge) throw new Error(t("bridgeUnavailable"));
        await collaborationBridge.flushCollaborationCanvasReplicaMaterialization();
      }
      return createProjectFromTaskCanvasInSession(project, canvasId);
    },
    [
      createProjectFromTaskCanvasInSession,
      selectedCanvasId,
      selectedProject?.projectId,
      sharedCanvasCommands.enabled,
      t
    ]
  );

  const restoreTaskWorkspaceSourceSelection = useCallback(
    async (taskId: string | null, blockRef: string | null) => {
      setSelectedRunRecord(null);
      if (blockRef) {
        await restoreBlockSelection(blockRef);
      } else {
        setSelectedBlock(null);
        clearSelectedBlockRecords();
      }
      restoreTaskPanelSelection(taskId);
    },
    [
      clearSelectedBlockRecords,
      restoreBlockSelection,
      restoreTaskPanelSelection,
      setSelectedBlock,
      setSelectedRunRecord
    ]
  );
  const taskWorkspaceNavigation = useTaskWorkspaceGraphNavigation({
    flowInstance,
    graph,
    history: appHistory,
    openProject: openProjectInSession,
    projectLoading,
    projects,
    restoreSelection: restoreTaskWorkspaceSourceSelection,
    selectedCanvasId,
    selectedProject,
    setError
  });
  const taskWorkspace = useTaskWorkspaceController({
    agentEndpointCatalog: agentEndpointCatalog.endpoints,
    agentEndpointPreferences: settings.execution.agentEndpointPreferences,
    history: appHistory,
    operatorProfileId: ownerControlPlane.operatorProfileId,
    saveAgentEndpointPreference: agentEndpointCatalog.savePreference,
    sharedCanvas: sharedCanvasCommands
  });
  const currentRouteRef = useRef(appHistory.route);
  currentRouteRef.current = appHistory.route;
  const recordWorkspaceNavigationRef = useRef<
    ((source: RecordNavigationSource, locator: RecordWorkspaceLocator) => Promise<void>) | null
  >(null);
  const openRecordWorkspace = useCallback(
    (source: RecordNavigationSource, locator: RecordWorkspaceLocator) => {
      const open = recordWorkspaceNavigationRef.current;
      if (!open) {
        return Promise.reject(new Error("Task Workspace record navigation is unavailable."));
      }
      return open(source, locator);
    },
    []
  );
  const openAutoRunWorkspace = useCallback(
    (locator: Omit<RecordWorkspaceLocator, "expectedBlockRef">) =>
      openRecordWorkspace("autoRun", locator),
    [openRecordWorkspace]
  );
  const openSearchRunWorkspace = useCallback(
    (locator: RecordWorkspaceLocator) => openRecordWorkspace("search", locator),
    [openRecordWorkspace]
  );
  const openNotificationRunWorkspace = useCallback(
    (locator: Omit<RecordWorkspaceLocator, "expectedBlockRef">) =>
      openRecordWorkspace("notifications", locator),
    [openRecordWorkspace]
  );
  const openTaskWorkspaceFrom = useCallback(
    (source: "notifications" | "search", target: TaskWorkspaceNavigationTarget) => {
      if (currentRouteRef.current.view === source) {
        appHistory.openTaskWorkspace(target, { view: source });
      }
    },
    [appHistory.openTaskWorkspace]
  );

  const startAutoRunWithSelectedEndpoint = useWorkspaceAgentEndpointRun({
    activeProjectId: collaborationSurface.activeProjectId,
    agentEndpoints: agentEndpointCatalog.endpoints,
    collaborationController: collaborationSurface.controller,
    canvasBinding,
    graph,
    preferences: settings.execution.agentEndpointPreferences,
    selectedCanvasId: activeCanvasId,
    selectedProject,
    operatorProfileId: ownerControlPlane.operatorProfileId,
    ownerFleetDispatchEnabled: ownerControlPlane.fleetCatalogEnabled,
    runtimeAvailability: collaborationRuntime.availability,
    setError
  });

  const autoRunController = useAutoRunController({
    autoRunState,
    onAutoRunDerivedStateRefresh: refreshGraph,
    selectedCanvasId,
    selectedBlock,
    selectedProject,
    selectedTaskPanelId,
    openRunWorkspace: openAutoRunWorkspace,
    setAutoRunState,
    setError,
    t,
    tmuxMonitoringEnabled: settings.execution.tmuxMonitoring && runtimeTools.tmux.available,
    position: settings.layout.autoRunControl.position,
    onPositionCommit: (position) => updateLayoutSettings({ autoRunControl: { position } }),
    startAutoRunScope: startAutoRunWithSelectedEndpoint,
    runtimeAvailability: collaborationRuntime.availability
  });
  useTaskNodeFocus({
    activeView,
    flowInstance,
    nodes,
    selectedTaskPanelId,
    taskFocusRequest
  });

  const searchController = useSearchController({
    openRunWorkspace: openSearchRunWorkspace,
    openTaskWorkspace: (target) => openTaskWorkspaceFrom("search", target),
    selectedCanvasId,
    selectedProject,
    setError
  });
  const collaborationPresence = useCollaborationCanvasPresence({
    api: collaborationBridge,
    enabled: activeView === "graph" && canvasBinding !== null,
    sessionConnected: collaborationSurface.sessionConnected,
    binding: canvasBinding,
    profileId: collaborationSurface.activeProfileId,
    activeProjectId: collaborationSurface.activeProjectId,
    t
  });
  const recordNavigationSourceContextKeys = useMemo(() => {
    const selectedContext = [selectedProject?.rootPath ?? null, selectedCanvasId];
    const runContext = autoRunState
      ? [
          autoRunState.runId,
          autoRunState.projectRoot,
          autoRunState.canvasId,
          autoRunState.currentRef,
          autoRunState.latestRecordId,
          autoRunState.updatedAt
        ]
      : null;
    return {
      autoRun: JSON.stringify([...selectedContext, runContext]),
      notifications: JSON.stringify([
        ...selectedContext,
        autoRunState?.projectRoot ?? null,
        autoRunState?.canvasId ?? null,
        autoRunState?.latestRecordId ?? null,
        autoRunState?.updatedAt ?? null
      ]),
      search: JSON.stringify([
        ...selectedContext,
        searchController.searchQuery,
        searchController.searchCanvasScope,
        searchController.selectedSearchResultKinds
      ])
    };
  }, [autoRunState, searchController, selectedCanvasId, selectedProject]);
  const getNavigationRunRecord = useCallback((locator: RecordWorkspaceLocator) => {
    if (!bridge) {
      return Promise.reject(new Error("Task Workspace bridge is unavailable."));
    }
    return bridge.getRunRecord(
      { projectRoot: locator.projectRoot, canvasId: locator.canvasId },
      locator.recordId
    );
  }, []);
  const publishRecordWorkspaceTarget = useCallback(
    (source: RecordNavigationSource, target: RecordAuthorityTarget) => {
      if (source === "autoRun") {
        taskWorkspaceNavigation.openRunWorkspace(target);
        return;
      }
      appHistory.openTaskWorkspace(target, { view: source });
    },
    [appHistory.openTaskWorkspace, taskWorkspaceNavigation.openRunWorkspace]
  );
  const recordWorkspaceNavigation = useRecordWorkspaceNavigation({
    getRunRecord: getNavigationRunRecord,
    openTarget: publishRecordWorkspaceTarget,
    route: appHistory.route,
    sourceContextKeys: recordNavigationSourceContextKeys
  });
  useLayoutEffect(() => {
    recordWorkspaceNavigationRef.current = recordWorkspaceNavigation;
    return () => {
      if (recordWorkspaceNavigationRef.current === recordWorkspaceNavigation) {
        recordWorkspaceNavigationRef.current = null;
      }
    };
  }, [recordWorkspaceNavigation]);
  const visibleProjectDiagnostics = useMemo(
    () =>
      uniqueDesktopDiagnostics([
        ...projectDiagnostics,
        ...graphDiagnostics,
        ...runtimeDiagnostics,
        ...searchController.diagnostics,
        ...autoRunDiagnostics
      ]),
    [
      autoRunDiagnostics,
      graphDiagnostics,
      projectDiagnostics,
      runtimeDiagnostics,
      searchController.diagnostics
    ]
  );

  const {
    addReviewStep,
    clearReviewTaskSelection,
    moveReviewStep,
    removeReviewStep,
    reviewDefaultCyclesDraft,
    reviewDraft,
    reviewPipeline,
    reviewTaskId,
    saveReviewPipeline,
    setReviewDefaultCyclesDraft,
    setReviewTaskId,
    updateReviewStep
  } = useReviewPipeline({
    graph,
    projectLoading,
    reloadCurrentCanvas,
    selectedCanvasId,
    selectedProject,
    setError,
    t,
    sharedCanvas: sharedCanvasCommands
  });

  const { handleDeleteBlock, handleDeleteTaskNode } = useGraphDeleteActions({
    clearReviewTaskSelection,
    clearTaskPanelSelection,
    clearSelectedBlockRecords,
    deleteBlockConfirm: t("deleteBlockConfirm"),
    deleteTaskConfirm: t("deleteTaskConfirm"),
    loadProject: openProjectInSession,
    refreshProjectDerivedState,
    selectedCanvasId,
    selectedBlock,
    selectedProject,
    selectedTaskPanelId,
    setBlockInspectorOpen,
    setError,
    setSelectedBlock,
    setSelectedRunRecord,
    sharedCanvas: sharedCanvasCommands
  });

  const {
    applyLocalPromptConflicts,
    handlePromptChange,
    handlePromptSave,
    handleTitleChange,
    handleTitleSave,
    keepLocalPromptConflicts,
    promptDrafts,
    promptConflicts,
    reloadPromptConflicts,
    saveStates,
    titleDrafts
  } = usePromptDrafts({
    graph,
    refreshGraph,
    selectedCanvasId,
    selectedProject,
    setError,
    sharedCanvas: sharedCanvasCommands
  });

  const {
    activeResource,
    pinnedResource,
    transitionEpochByResource,
    onResourceHover,
    onResourcePin,
    clearPin: clearPinnedResource,
    setPinnedResource
  } = useSharedResourceHighlight(graph);

  const handleResourceOverflow = useCallback(
    (taskId: string) => {
      if (pinnedResource) {
        return;
      }
      const task = graph?.tasks.find((item) => item.taskId === taskId);
      const firstResource = task?.sharedResources[0];
      if (firstResource) {
        setPinnedResource(firstResource);
      }
    },
    [graph, pinnedResource, setPinnedResource]
  );

  const { handleTaskExecutorChange } = useTaskExecutorActions({
    refreshGraph,
    selectedCanvasId,
    selectedProject,
    setError,
    sharedCanvas: sharedCanvasCommands
  });
  const taskAgentEndpointSelection = useTaskAgentEndpointSelection({
    agentEndpoints: agentEndpointCatalog.endpoints,
    canvasId: selectedCanvasId,
    changeLogicalExecutor: handleTaskExecutorChange,
    preferences: settings.execution.agentEndpointPreferences,
    projectRoot: selectedProject?.rootPath ?? null,
    remoteCanvas: remoteWorkspace.binding,
    savePreference: agentEndpointCatalog.savePreference,
    setError
  });
  const {
    handleBindSourceRoot,
    handleCopyCanvasToNewProject,
    handleDeleteProject,
    handleDeleteTaskCanvas,
    handleDuplicateTaskCanvas,
    handleDropSourceRoot,
    handleProjectNewGraph,
    handleRenameProject,
    handleRevealPathInFinder,
    handleRevealPlanWorkspace,
    handleRevealProject,
    handleRevealSourceRoot,
    handleRevealTaskCanvas,
    handleRenameTaskCanvas,
    handleUnlinkSourceRoot
  } = useDesktopProjectActions({
    clearReviewTaskSelection,
    createTaskCanvas: createTaskCanvasInSession,
    createProjectFromTaskCanvas: createLocalProjectFromTaskCanvas,
    deleteTaskCanvas: deleteTaskCanvasInSession,
    duplicateTaskCanvas: duplicateTaskCanvasInSession,
    renameProject: async (project, name) => {
      if (!bridge) {
        return null;
      }
      const updated = await bridge.renameProject(project.projectId, name);
      if (updated.projectId !== project.projectId) {
        updateSettings((current) => ({
          pinnedProjectIds: Array.from(
            new Set(
              current.pinnedProjectIds.map((pinnedProjectId) =>
                pinnedProjectId === project.projectId ? updated.projectId : pinnedProjectId
              )
            )
          )
        }));
      }
      await refreshProjects({ selectProjectId: updated.projectId });
      return updated;
    },
    renameTaskCanvas: renameTaskCanvasInSession,
    refreshProjectSummary,
    removeProject,
    setActiveView,
    setError,
    t
  });

  const { handleRedoGraph, handleUndoGraph } = useGraphHistoryActions({
    openProjectInSession,
    refreshProjectDerivedState,
    selectedCanvasId,
    selectedProject,
    setError
  });

  const handleCopyAgentPrompt = useCallback(
    (taskId?: string | null) => {
      if (!selectedProject) {
        return;
      }
      const canvasId = selectedCanvasId ?? selectedProject.activeCanvasId ?? "default";
      const packageDir = canvasPackageDir(selectedProject, canvasId);
      if (!packageDir) {
        setError(unavailablePackageDirMessage(canvasId));
        return;
      }
      void writeAgentScopePromptToClipboard({
        project: selectedProject,
        canvasId,
        packageDir,
        taskId
      })
        .then(() => setSuccessMessage(t("agentPromptCopied")))
        .catch((caught: unknown) =>
          setError(caught instanceof Error ? caught.message : String(caught))
        );
    },
    [selectedCanvasId, selectedProject, setError, setSuccessMessage, t]
  );
  const handleRevealTaskInFinder = useCallback(
    (taskId: string) => {
      if (!bridge || !selectedProject) {
        return;
      }
      const canvasId = selectedCanvasId ?? selectedProject.activeCanvasId ?? "default";
      void bridge
        .revealTaskInFinder(desktopCanvasReference(selectedProject, canvasId), taskId)
        .catch((caught: unknown) =>
          setError(caught instanceof Error ? caught.message : String(caught))
        );
    },
    [selectedCanvasId, selectedProject, setError]
  );
  const handleRevealTaskNode = useCallback(
    (project: DesktopProjectSummary, canvas: TaskCanvasSummary, taskId: string) => {
      if (!bridge) {
        return;
      }
      void bridge
        .revealTaskInFinder(desktopCanvasReference(project, canvas.canvasId), taskId)
        .catch((caught: unknown) =>
          setError(caught instanceof Error ? caught.message : String(caught))
        );
    },
    [setError]
  );
  const handleCopyCanvasAgentPrompt = useCallback(
    (project: DesktopProjectSummary, canvas: TaskCanvasSummary) => {
      if (!canvas.packageDir) {
        setError(unavailablePackageDirMessage(canvas.canvasId));
        return;
      }
      void writeAgentScopePromptToClipboard({
        project,
        canvasId: canvas.canvasId,
        packageDir: canvas.packageDir
      })
        .then(() => setSuccessMessage(t("agentPromptCopied")))
        .catch((caught: unknown) =>
          setError(caught instanceof Error ? caught.message : String(caught))
        );
    },
    [setError, setSuccessMessage, t]
  );

  const resourceUi = useMemo(
    () => ({
      activeResource,
      transitionEpochByResource,
      onResourceHover,
      onResourcePin,
      onResourceOverflow: handleResourceOverflow
    }),
    [
      activeResource,
      transitionEpochByResource,
      onResourceHover,
      onResourcePin,
      handleResourceOverflow
    ]
  );
  const assigneeUi = useMemo(
    () =>
      selectedCanvasId
        ? {
            canvasId: selectedCanvasId,
            index: collaborationSurface.assigneeIndex
          }
        : null,
    [collaborationSurface.assigneeIndex, selectedCanvasId]
  );
  const commentUi = useMemo(
    () =>
      selectedCanvasId
        ? {
            canvasId: selectedCanvasId,
            countsByWorkItem: Object.fromEntries(
              Object.entries(collaborationSurface.snapshot.commentsByWorkItem).map(
                ([key, comments]) => [key, comments.filter((comment) => !comment.tombstoned).length]
              )
            ),
            t
          }
        : null,
    [collaborationSurface.snapshot.commentsByWorkItem, selectedCanvasId, t]
  );

  useGraphFlowModel({
    blockActions: {
      saveSelectedBlockPrompt,
      saveSelectedBlockTitle
    },
    drafts: {
      promptDrafts,
      saveStates,
      titleDrafts
    },
    flowState: {
      setEdges,
      setNodes,
      setSelectedBlock
    },
    source: {
      agentEndpointCatalogErrorCode: agentEndpointCatalog.errorCode,
      agentEndpoints: agentEndpointCatalog.endpoints,
      selectedAgentEndpointIdForTask: taskAgentEndpointSelection.selectedEndpointId,
      graph,
      layout,
      selectedBlock,
      t,
      resourceUi,
      assigneeUi,
      commentUi,
      runtimeAvailability: collaborationRuntime.availability
    },
    taskActions: {
      handleDeleteBlock,
      handleDeleteTaskNode,
      handleCopyAgentPrompt,
      handleRevealTaskInFinder,
      handleOpenBlockInspector,
      handleOpenBlockWorkspace: taskWorkspaceNavigation.openBlockWorkspace,
      handleOpenRunRecord,
      handleOpenTaskInspector,
      handleOpenTaskWorkspace: taskWorkspaceNavigation.openTaskWorkspace,
      handlePromptChange,
      handlePromptHistoryRedo: handleRedoGraph,
      handlePromptHistoryUndo: handleUndoGraph,
      handlePromptSave,
      handleTaskAgentEndpointChange: taskAgentEndpointSelection.changeEndpoint,
      handleTitleChange,
      handleTitleSave,
      startAutoRunWithScope: autoRunController.startAutoRunWithScope
    }
  });

  const {
    addPaletteComponent,
    handleConnect,
    handleEdgesDelete,
    handleReconnectEdge,
    handleGraphDragOver,
    handleGraphDrop,
    handleNodeDragStop,
    handlePaletteDragStart,
    resetLayout
  } = useGraphPaletteActions({
    flowInstance,
    getLayoutNodes: lerpedNodeDrag.commitDragTargets,
    graph,
    layout,
    loadProject: openProjectInSession,
    nodes,
    refreshProjectDerivedState,
    selectedCanvasId,
    selectedBlock,
    selectedProject,
    selectedTaskPanelId,
    setError,
    setLayout,
    selectTaskPanel: handleTaskPanelSelect,
    settings,
    t,
    sharedCanvas: sharedCanvasCommands
  });
  const fileSyncController = useFileSyncController({
    projectDiagnostics: visibleProjectDiagnostics,
    refreshProjectDerivedState,
    reloadCurrentCanvas,
    selectedCanvasId,
    selectedProject,
    setError,
    t
  });
  const notificationController = useNotificationController({
    applyLocalPromptConflicts,
    autoRunState,
    collaborationItems: collaborationSurface.collaborationNotificationDrafts,
    fileSyncDiagnostics: fileSyncController.fileSyncDiagnostics,
    graph,
    handleRevealPathInFinder,
    keepLocalPromptConflicts,
    lastFileChange: fileSyncController.lastFileChange,
    navigationContext:
      selectedProject && selectedCanvasId
        ? { projectRoot: selectedProject.rootPath, canvasId: selectedCanvasId }
        : null,
    openRunWorkspace: openNotificationRunWorkspace,
    openTaskWorkspace: (target) => openTaskWorkspaceFrom("notifications", target),
    pendingImportRecoveries,
    promptConflicts,
    reloadPromptConflicts,
    rollbackPendingImportRecovery,
    setError,
    setSuccessMessage,
    settings,
    t,
    updateSettings
  });
  const settingsRouteProps = buildAppSettingsRouteProps({
    graph,
    agents: agentDetections,
    agentDetectionRefreshing,
    globalPromptMarkdown,
    language,
    refreshAgentDetections,
    refreshRuntimeTools,
    runtimeTools,
    projects: orderedProjects,
    selectedCanvasId,
    selectedProject,
    loadProject: openProjectInSession,
    setActiveView,
    setError,
    settings,
    projectPromptMarkdown,
    projectPromptPolicy,
    t,
    updateProjectPrompt,
    updateProjectPromptPolicy,
    updateGlobalPrompt,
    updateSettingsAndWait,
    updateSettings
  });
  const workspaceShell = useMemo<WorkspaceTabsShellProps>(
    () => ({
      activeView,
      assigneeIndex: collaborationSurface.assigneeIndex,
      handleOpenProject,
      handleRevealPathInFinder,
      handleRevealTaskCanvas,
      handleRenameTaskCanvas,
      loadProject: openLocalProject,
      refreshProjects,
      projectLoading: workspaceProjectLoading,
      selectedCanvasId: activeCanvasId,
      selectedProject,
      selectedTaskPanelId,
      setActiveView,
      setError,
      setSuccessMessage,
      developerMode: settings.developerMode,
      collaborationScopeLayout: settings.layout.collaborationScope,
      updateCollaborationScopeLayout: (patch) =>
        updateLayoutSettings({ collaborationScope: patch }),
      t
    }),
    [
      activeView,
      collaborationSurface.assigneeIndex,
      handleOpenProject,
      handleRevealPathInFinder,
      handleRevealTaskCanvas,
      handleRenameTaskCanvas,
      openLocalProject,
      workspaceProjectLoading,
      refreshProjects,
      activeCanvasId,
      selectedProject,
      selectedTaskPanelId,
      setActiveView,
      setError,
      setSuccessMessage,
      settings.developerMode,
      settings.layout.collaborationScope,
      t,
      updateLayoutSettings
    ]
  );
  const graphWorkspaceController = useGraphWorkspaceController({
    edges,
    edgeTypes,
    executionPlan,
    graph,
    handleConnect,
    handleEdgesDelete,
    handleGraphDragOver,
    handleGraphDrop,
    handleOpenBlockInspector,
    handleOpenRunRecord,
    handleReconnectEdge,
    handleRedoGraph,
    handleUndoGraph,
    nodeTypes,
    nodes,
    onEdgesChange,
    onNodeDragStop: handleNodeDragStop,
    onNodesChange: lerpedNodeDrag.onNodesChange,
    searchQuery: searchController.searchQuery,
    handleTaskPanelSelect,
    selectedBlock,
    setSuccessMessage,
    setFlowInstance,
    t,
    pinnedResource,
    onResourceHover,
    onResourcePin,
    clearPinnedResource,
    presence: collaborationPresence,
    sharedCanvasOffline: sharedCanvasCommands.offline,
    sharedCanvasRevision: sharedCanvasCommands.projection?.revision ?? null,
    runtimeAvailability: collaborationRuntime.availability
  });
  const review = useMemo<WorkspaceTabsReviewProps>(
    () => ({
      addReviewStep,
      moveReviewStep,
      removeReviewStep,
      reviewDefaultCyclesDraft,
      reviewDraft,
      reviewPipeline,
      reviewTaskId,
      saveReviewPipeline,
      setReviewDefaultCyclesDraft,
      setReviewTaskId,
      updateReviewStep
    }),
    [
      addReviewStep,
      moveReviewStep,
      removeReviewStep,
      reviewDefaultCyclesDraft,
      reviewDraft,
      reviewPipeline,
      reviewTaskId,
      saveReviewPipeline,
      setReviewDefaultCyclesDraft,
      setReviewTaskId,
      updateReviewStep
    ]
  );
  const planning = useMemo<WorkspaceTabsPlanningProps>(
    () => ({
      assigneeIndex: collaborationSurface.assigneeIndex,
      statistics,
      todoGroups
    }),
    [collaborationSurface.assigneeIndex, statistics, todoGroups]
  );

  const autoRun = useMemo(() => {
    const { startAutoRunWithScope: _startAutoRunWithScope, ...props } = autoRunController;
    return props;
  }, [autoRunController]);
  const fileSync = useMemo(() => {
    const {
      fileSyncDiagnostics: _fileSyncDiagnostics,
      lastFileChange: _lastFileChange,
      ...props
    } = fileSyncController;
    return props;
  }, [fileSyncController]);
  const search = useMemo(() => {
    const { diagnostics: _searchDiagnostics, ...props } = searchController;
    return {
      ...props,
      assigneeIndex: collaborationSurface.assigneeIndex
    };
  }, [collaborationSurface.assigneeIndex, searchController]);

  const projectSidebar = useMemo(
    () => ({
      activeView,
      expandedProjectId,
      graph,
      handleBindSourceRoot,
      handleCopyCanvasToNewProject,
      handleOpenProject,
      handleProjectNewGraph,
      handleRefreshProjects: refreshProjects,
      handleCopyCanvasAgentPrompt,
      handleDeleteProject,
      handleDeleteTaskCanvas,
      handleDuplicateTaskCanvas,
      handleDeleteTaskNode,
      handleDropSourceRoot,
      handleRevealPlanWorkspace,
      handleRevealProject,
      handleRevealSourceRoot,
      handleRevealTaskCanvas,
      handleRevealTaskNode,
      handleRenameProject,
      handleRenameTaskCanvas,
      handleUnlinkSourceRoot,
      handleTaskPanelSelect,
      loadProject: openLocalProject,
      notificationItems: notificationController.notificationItems,
      onTogglePinnedProject: handleTogglePinnedProject,
      pinnedProjectIds,
      projectRefreshing,
      projects: orderedProjects,
      resetLayout,
      selectedProject,
      selectedCanvasId,
      selectedTaskPanelId,
      remoteCanvases: remoteWorkspace.authorizedCanvases,
      selectedRemoteCanvasId: remoteWorkspace.binding?.canvasId ?? null,
      onRemoteCanvasSelect: selectRemoteCanvas,
      setActiveView,
      t
    }),
    [
      activeView,
      expandedProjectId,
      graph,
      handleBindSourceRoot,
      handleCopyCanvasAgentPrompt,
      handleCopyCanvasToNewProject,
      handleDeleteProject,
      handleDeleteTaskCanvas,
      handleDeleteTaskNode,
      handleDropSourceRoot,
      handleDuplicateTaskCanvas,
      handleOpenProject,
      handleProjectNewGraph,
      handleRenameProject,
      handleRenameTaskCanvas,
      handleRevealPlanWorkspace,
      handleRevealProject,
      handleRevealSourceRoot,
      handleRevealTaskCanvas,
      handleRevealTaskNode,
      handleTaskPanelSelect,
      handleTogglePinnedProject,
      handleUnlinkSourceRoot,
      notificationController.notificationItems,
      openLocalProject,
      orderedProjects,
      pinnedProjectIds,
      projectRefreshing,
      remoteWorkspace.authorizedCanvases,
      remoteWorkspace.binding?.canvasId,
      refreshProjects,
      resetLayout,
      selectedCanvasId,
      selectedProject,
      selectedTaskPanelId,
      selectRemoteCanvas,
      setActiveView,
      t
    ]
  );

  const value = useMemo<ProjectWorkspaceValue>(
    () => ({
      autoRun,
      fileSync,
      graphWorkspace: graphWorkspaceController,
      notifications: notificationController,
      palette: {
        addPaletteComponent,
        handlePaletteDragStart
      },
      planning,
      projectSidebar,
      review,
      search,
      settingsRouteProps,
      shell: workspaceShell,
      taskWorkspace
    }),
    [
      addPaletteComponent,
      autoRun,
      fileSync,
      graphWorkspaceController,
      handlePaletteDragStart,
      notificationController,
      planning,
      projectSidebar,
      review,
      search,
      settingsRouteProps,
      taskWorkspace,
      workspaceShell
    ]
  );

  return (
    <ProjectWorkspaceContext.Provider value={value}>{children}</ProjectWorkspaceContext.Provider>
  );
}
