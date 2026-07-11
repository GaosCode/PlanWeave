/**
 * ProjectWorkspaceProvider inventory (plan 018):
 *
 * Context (project-scoped) members — depend on the open project/canvas:
 * - desktopProject refresh family + graph/layout/selection/diagnostics/planning
 * - selected block + session (task panel, auto-run state, canvas CRUD)
 * - auto-run / file-sync / search / notification controllers
 * - review pipeline, new-task draft, prompt drafts, graph flow/palette/history
 * - WorkspaceTabs groups: shell, graphWorkspace, autoRun, fileSync, search,
 *   review, newTask, notifications, planning
 * - ProjectSidebar action handlers + ordered project list
 * - Right palette add/drag handlers
 * - settingsRouteProps derived from project + shell agents/tools
 *
 * Shell members (stay in App.tsx):
 * - settings bridge, language/translator, theme effects
 * - activeView routing, error/success overlays
 * - agent detection + runtime tools refresh
 * - resizable sidebar layout chrome (collapsed/width/resize)
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction
} from "react";
import { type Edge, type ReactFlowInstance, useEdgesState, useNodesState } from "@xyflow/react";
import type {
  DesktopAgentDetection,
  DesktopProjectSummary,
  DesktopRuntimeToolAvailability
} from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "./bridge";
import { edgeTypes, nodeTypes } from "./graph/flowModel";
import type { createTranslator } from "./i18n";
import { orderProjectsByPinnedIds } from "./settings";
import type {
  AppFlowNode,
  AppView,
  DesktopSettingsUpdate,
  DesktopUiSettings,
  FloatingControlPosition
} from "./types";
import { useReviewPipeline } from "./hooks/useReviewPipeline";
import { useGraphPaletteActions } from "./hooks/useGraphPaletteActions";
import { useSelectedBlock } from "./hooks/useSelectedBlock";
import { useTaskDraft } from "./hooks/useTaskDraft";
import { useDesktopProject } from "./hooks/useDesktopProject";
import { useDesktopProjectSession } from "./hooks/useDesktopProjectSession";
import { usePromptDrafts } from "./hooks/usePromptDrafts";
import { useGraphDeleteActions } from "./hooks/useGraphDeleteActions";
import { useTaskNodeFocus } from "./hooks/useTaskNodeFocus";
import { useTaskExecutorActions } from "./hooks/useTaskExecutorActions";
import { useDesktopProjectActions } from "./hooks/useDesktopProjectActions";
import { useGraphFlowModel } from "./hooks/useGraphFlowModel";
import { useGraphHistoryActions } from "./hooks/useGraphHistoryActions";
import { useLockHighlight } from "./hooks/useLockHighlight";
import { useLerpedNodeDrag } from "./hooks/useLerpedNodeDrag";
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
  WorkspaceTabsNewTaskProps,
  WorkspaceTabsNotificationsProps,
  WorkspaceTabsPlanningProps,
  WorkspaceTabsReviewProps,
  WorkspaceTabsSearchProps,
  WorkspaceTabsShellProps
} from "./views/WorkspaceTabs";
import type { ComponentProps } from "react";
import type { AppSettingsRoute } from "./AppSettingsRoute";
import type { ProjectSidebar } from "./sidebar/ProjectSidebar";

const emptyExecutorOptions: string[] = [];
type TaskCanvasSummary = DesktopProjectSummary["taskCanvases"][number];
type AppSettingsRouteProps = ComponentProps<typeof AppSettingsRoute>;
type ProjectSidebarProps = ComponentProps<typeof ProjectSidebar>;

function canvasPackageDir(project: DesktopProjectSummary, canvasId: string | null): string | null {
  return project.taskCanvases.find((canvas) => canvas.canvasId === canvasId)?.packageDir ?? null;
}

function unavailablePackageDirMessage(canvasId: string): string {
  return `Cannot copy agent prompt because packageDir is unavailable for canvas '${canvasId}'.`;
}

type LayoutSettingsPatch = {
  leftSidebar?: Partial<DesktopUiSettings["layout"]["leftSidebar"]>;
  rightSidebar?: Partial<DesktopUiSettings["layout"]["rightSidebar"]>;
  autoRunControl?: Partial<DesktopUiSettings["layout"]["autoRunControl"]> & {
    position?: FloatingControlPosition | null;
  };
};

export type ProjectWorkspaceShellInput = {
  activeView: AppView;
  agentDetectionRefreshing: boolean;
  agentDetections: DesktopAgentDetection[];
  language: DesktopUiSettings["language"];
  refreshAgentDetections: () => Promise<void>;
  refreshRuntimeTools: () => Promise<void>;
  runtimeTools: DesktopRuntimeToolAvailability;
  setActiveView: Dispatch<SetStateAction<AppView>>;
  setError: (message: string | null) => void;
  setSuccessMessage: Dispatch<SetStateAction<string | null>>;
  settings: DesktopUiSettings;
  t: ReturnType<typeof createTranslator>;
  updateLayoutSettings: (patch: LayoutSettingsPatch) => void;
  updateSettings: (update: DesktopSettingsUpdate) => void;
};

export type ProjectWorkspaceValue = {
  autoRun: WorkspaceTabsAutoRunProps;
  fileSync: WorkspaceTabsFileSyncProps;
  graphWorkspace: WorkspaceTabsGraphWorkspaceProps;
  newTask: WorkspaceTabsNewTaskProps;
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
    agentDetectionRefreshing,
    agentDetections,
    language,
    refreshAgentDetections,
    refreshRuntimeTools,
    runtimeTools,
    setActiveView,
    setError,
    setSuccessMessage,
    settings,
    t,
    updateLayoutSettings,
    updateSettings
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
    setError,
    t,
    updateSettings
  });
  const {
    expandedProjectId,
    executionPlan,
    graph,
    graphDiagnostics,
    handleOpenProject,
    layout,
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
    setLayout,
    statistics,
    todoGroups,
    updateProjectPrompt,
    updateProjectPromptPolicy
  } = desktopProject;

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
    blockFeedbackRecords,
    blockReviewAttempts,
    blockRunRecords,
    clearSelectedBlockRecords,
    handleBlockSelect,
    handleOpenRunRecord,
    saveSelectedBlockExecutor,
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
    setError
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

  const autoRunController = useAutoRunController({
    autoRunState,
    onAutoRunDerivedStateRefresh: refreshGraph,
    selectedCanvasId,
    selectedBlock,
    selectedProject,
    selectedTaskPanelId,
    handleOpenRunRecord,
    setAutoRunState,
    setError,
    t,
    tmuxMonitoringEnabled: settings.execution.tmuxMonitoring && runtimeTools.tmux.available,
    position: settings.layout.autoRunControl.position,
    onPositionCommit: (position) => updateLayoutSettings({ autoRunControl: { position } })
  });
  useTaskNodeFocus({
    activeView,
    flowInstance,
    nodes,
    selectedTaskPanelId,
    taskFocusRequest
  });

  const {
    confirmTaskDraft,
    generateTaskDraft,
    newTaskMode,
    newTaskTargetId,
    newTaskText,
    setNewTaskMode,
    setNewTaskTargetId,
    setNewTaskText,
    setTaskDraft,
    taskDraft
  } = useTaskDraft({
    loadProject: openProjectInSession,
    selectedCanvasId,
    selectedProject,
    setActiveView,
    setError
  });

  const searchController = useSearchController({
    handleBlockSelect: handleOpenBlockInspector,
    handleOpenRunRecord,
    loadProject: openProjectInSession,
    openTaskInspector: handleOpenTaskInspector,
    selectedCanvasId,
    selectedProject,
    setError
  });
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
    reloadCurrentCanvas,
    selectedCanvasId,
    selectedProject,
    setError,
    t
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
    setSelectedRunRecord
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
  } = usePromptDrafts({ graph, refreshGraph, selectedCanvasId, selectedProject, setError });

  const {
    activeLock,
    pinnedLock,
    releaseEpochByLock,
    onLockHover,
    onLockPin,
    clearPin: clearPinnedLock,
    setPinnedLock
  } = useLockHighlight(graph);

  const handleJumpToTask = useCallback(
    (taskId: string) => {
      handleTaskPanelSelect(taskId);
      if (flowInstance) {
        void flowInstance.fitView({
          nodes: [{ id: taskId }],
          maxZoom: 1.2,
          duration: 200
        });
      }
    },
    [flowInstance, handleTaskPanelSelect]
  );

  const handleLockOverflow = useCallback(
    (_taskId: string) => {
      // Overflow opens the resource panel for the first shared-resource hint (or active pin).
      if (pinnedLock) {
        return;
      }
      const task = graph?.tasks.find((item) => item.taskId === _taskId);
      const firstLock = task?.sharedResources?.[0];
      if (firstLock) {
        setPinnedLock(firstLock);
      }
    },
    [graph, pinnedLock, setPinnedLock]
  );

  const { handleTaskExecutorChange } = useTaskExecutorActions({
    refreshGraph,
    selectedCanvasId,
    selectedProject,
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
    createProjectFromTaskCanvas: createProjectFromTaskCanvasInSession,
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

  const lockUi = useMemo(
    () => ({
      activeLock,
      releaseEpochByLock,
      onLockHover,
      onLockPin,
      onLockOverflow: handleLockOverflow,
      onJumpToTask: handleJumpToTask
    }),
    [activeLock, releaseEpochByLock, onLockHover, onLockPin, handleLockOverflow, handleJumpToTask]
  );

  useGraphFlowModel({
    blockActions: {
      saveSelectedBlockExecutor,
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
    records: {
      blockFeedbackRecords,
      blockReviewAttempts,
      blockRunRecords
    },
    source: {
      agentDetections,
      executorOptions: graph?.executorOptions ?? emptyExecutorOptions,
      graph,
      layout,
      selectedBlock,
      t,
      lockUi
    },
    taskActions: {
      handleDeleteBlock,
      handleDeleteTaskNode,
      handleCopyAgentPrompt,
      handleRevealTaskInFinder,
      handleOpenBlockInspector,
      handleOpenRunRecord,
      handleOpenTaskInspector,
      handlePromptChange,
      handlePromptHistoryRedo: handleRedoGraph,
      handlePromptHistoryUndo: handleUndoGraph,
      handlePromptSave,
      handleTaskExecutorChange,
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
    setNewTaskTargetId,
    selectTaskPanel: handleTaskPanelSelect,
    settings,
    t
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
    fileSyncDiagnostics: fileSyncController.fileSyncDiagnostics,
    graph,
    handleRevealPathInFinder,
    keepLocalPromptConflicts,
    lastFileChange: fileSyncController.lastFileChange,
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
    updateSettings
  });
  const workspaceShell = useMemo<WorkspaceTabsShellProps>(
    () => ({
      activeView,
      handleOpenProject,
      handleRevealPathInFinder,
      handleRevealTaskCanvas,
      handleRenameTaskCanvas,
      loadProject: openProjectInSession,
      projectLoading,
      selectedCanvasId,
      selectedProject,
      selectedTaskPanelId,
      setActiveView,
      setError,
      t
    }),
    [
      activeView,
      handleOpenProject,
      handleRevealPathInFinder,
      handleRevealTaskCanvas,
      handleRenameTaskCanvas,
      openProjectInSession,
      projectLoading,
      selectedCanvasId,
      selectedProject,
      selectedTaskPanelId,
      setActiveView,
      setError,
      t
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
    pinnedLock,
    onLockHover,
    onLockPin,
    clearPinnedLock,
    refreshGraphLocks: refreshGraph
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
  const newTask = useMemo<WorkspaceTabsNewTaskProps>(
    () => ({
      confirmTaskDraft,
      generateTaskDraft,
      newTaskMode,
      newTaskTargetId,
      newTaskText,
      setNewTaskMode,
      setNewTaskTargetId,
      setNewTaskText,
      setTaskDraft,
      taskDraft
    }),
    [
      confirmTaskDraft,
      generateTaskDraft,
      newTaskMode,
      newTaskTargetId,
      newTaskText,
      setNewTaskMode,
      setNewTaskTargetId,
      setNewTaskText,
      setTaskDraft,
      taskDraft
    ]
  );
  const planning = useMemo<WorkspaceTabsPlanningProps>(
    () => ({
      statistics,
      todoGroups
    }),
    [statistics, todoGroups]
  );

  const { startAutoRunWithScope: _startAutoRunWithScope, ...autoRun } = autoRunController;
  const {
    fileSyncDiagnostics: _fileSyncDiagnostics,
    lastFileChange: _lastFileChange,
    ...fileSync
  } = fileSyncController;
  const { diagnostics: _searchDiagnostics, ...search } = searchController;

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
      loadProject: openProjectInSession,
      notificationItems: notificationController.notificationItems,
      onTogglePinnedProject: handleTogglePinnedProject,
      pinnedProjectIds,
      projectRefreshing,
      projects: orderedProjects,
      resetLayout,
      selectedProject,
      selectedCanvasId,
      selectedTaskPanelId,
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
      openProjectInSession,
      orderedProjects,
      pinnedProjectIds,
      projectRefreshing,
      refreshProjects,
      resetLayout,
      selectedCanvasId,
      selectedProject,
      selectedTaskPanelId,
      setActiveView,
      t
    ]
  );

  const value = useMemo<ProjectWorkspaceValue>(
    () => ({
      autoRun,
      fileSync,
      graphWorkspace: graphWorkspaceController,
      newTask,
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
      shell: workspaceShell
    }),
    [
      addPaletteComponent,
      autoRun,
      fileSync,
      graphWorkspaceController,
      handlePaletteDragStart,
      newTask,
      notificationController,
      planning,
      projectSidebar,
      review,
      search,
      settingsRouteProps,
      workspaceShell
    ]
  );

  return (
    <ProjectWorkspaceContext.Provider value={value}>{children}</ProjectWorkspaceContext.Provider>
  );
}
