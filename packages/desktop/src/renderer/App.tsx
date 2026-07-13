import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { type Edge, type ReactFlowInstance, useEdgesState, useNodesState } from "@xyflow/react";
import type { DesktopProjectSummary } from "@planweave-ai/runtime";
import { bridge } from "./bridge";
import { edgeTypes, nodeTypes } from "./graph/flowModel";
import { createTranslator } from "./i18n";
import { ProjectSidebar } from "./sidebar/ProjectSidebar";
import { orderProjectsByPinnedIds } from "./settings";
import type { AppFlowNode, AppView } from "./types";
import { WorkspaceTabs } from "./views/WorkspaceTabs";
import { useReviewPipeline } from "./hooks/useReviewPipeline";
import { useGraphPaletteActions } from "./hooks/useGraphPaletteActions";
import { useSelectedBlock } from "./hooks/useSelectedBlock";
import { useTaskDraft } from "./hooks/useTaskDraft";
import { useDesktopProject } from "./hooks/useDesktopProject";
import { useDesktopProjectSession } from "./hooks/useDesktopProjectSession";
import { usePromptDrafts } from "./hooks/usePromptDrafts";
import { useAppViewHistory } from "./hooks/useAppViewHistory";
import { useGraphDeleteActions } from "./hooks/useGraphDeleteActions";
import { useDesktopSettingsEffects } from "./hooks/useDesktopSettingsEffects";
import { useDesktopSettingsBridge } from "./hooks/useDesktopSettingsBridge";
import { useDetectedAgents } from "./hooks/useDetectedAgents";
import { useRuntimeTools } from "./hooks/useRuntimeTools";
import { useTaskNodeFocus } from "./hooks/useTaskNodeFocus";
import { useTaskExecutorActions } from "./hooks/useTaskExecutorActions";
import { useDesktopProjectActions } from "./hooks/useDesktopProjectActions";
import { useGraphFlowModel } from "./hooks/useGraphFlowModel";
import { useGraphHistoryActions } from "./hooks/useGraphHistoryActions";
import { useResizableSidebarLayout } from "./hooks/useResizableSidebarLayout";
import { useLerpedNodeDrag } from "./hooks/useLerpedNodeDrag";
import { CollapsedSidebarControls, RightPaletteSidebar } from "./AppSidebars";
import { AppSettingsRoute } from "./AppSettingsRoute";
import { buildAppSettingsRouteProps } from "./AppSettingsRouteProps";
import { AppOverlays } from "./components/AppOverlays";
import { useAutoRunController, useFileSyncController } from "./controllers/AutoRunController";
import { useGraphWorkspaceController } from "./controllers/GraphWorkspaceController";
import { useNotificationController } from "./controllers/NotificationController";
import { useSearchController } from "./controllers/SearchController";
import { writeAgentScopePromptToClipboard } from "./agentPrompt";
import { uniqueDesktopDiagnostics } from "./diagnostics";
import { TeamModeShell } from "./team/TeamModeShell";
import type { SettingsSection } from "./settings/SettingsNav";

const emptyExecutorOptions: string[] = [];
type TaskCanvasSummary = DesktopProjectSummary["taskCanvases"][number];

function canvasPackageDir(project: DesktopProjectSummary, canvasId: string | null): string | null {
  return project.taskCanvases.find((canvas) => canvas.canvasId === canvasId)?.packageDir ?? null;
}

function unavailablePackageDirMessage(canvasId: string): string {
  return `Cannot copy agent prompt because packageDir is unavailable for canvas '${canvasId}'.`;
}

export function App() {
  const [mode, setMode] = useState<"personal" | "team">("personal");
  const [teamView, setTeamView] = useState("planning");
  const [teamConnectionRole, setTeamConnectionRole] = useState<"server" | "member" | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [error, setError] = useState<string | null>(null);
  const { settings, updateLayoutSettings, updateSettings } = useDesktopSettingsBridge({ setError });
  const language = settings.language;
  const t = useMemo(() => createTranslator(language), [language]);
  const [activeView, setActiveView] = useAppViewHistory("graph");
  const setMainView = useCallback<Dispatch<SetStateAction<AppView>>>((nextView) => {
    setMode("personal");
    setActiveView(nextView);
  }, [setActiveView]);
  const [, setBlockInspectorOpen] = useState(false);
  const { agentDetectionRefreshing, agentDetections, refreshAgentDetections } = useDetectedAgents();
  const { refreshRuntimeTools, runtimeTools } = useRuntimeTools();
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<AppFlowNode, Edge> | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<AppFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const lerpedNodeDrag = useLerpedNodeDrag({
    nodes,
    setNodes,
    onNodesChange,
    enabled: !settings.reducedMotion
  });

  useEffect(() => {
    if (!bridge) {
      setError(t("bridgeUnavailable"));
    }
  }, [t]);

  useDesktopSettingsEffects(settings);

  const {
    isResizingLeft,
    isResizingRight,
    leftSidebarCollapsed,
    leftSidebarWidth,
    rightSidebarCollapsed,
    rightSidebarWidth,
    setLeftSidebarCollapsedPreference,
    setRightSidebarCollapsedPreference,
    startSidebarResize
  } = useResizableSidebarLayout({
    initialLayout: settings.layout,
    onLayoutPatch: updateLayoutSettings
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

  const pinnedProjectIds = useMemo(() => new Set(settings.pinnedProjectIds), [settings.pinnedProjectIds]);
  const orderedProjects = useMemo(() => orderProjectsByPinnedIds(projects, settings.pinnedProjectIds), [projects, settings.pinnedProjectIds]);
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
  } = useTaskDraft({ loadProject: openProjectInSession, selectedCanvasId, selectedProject, setActiveView, setError });

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
    () => uniqueDesktopDiagnostics([...projectDiagnostics, ...graphDiagnostics, ...runtimeDiagnostics, ...searchController.diagnostics, ...autoRunDiagnostics]),
    [autoRunDiagnostics, graphDiagnostics, projectDiagnostics, runtimeDiagnostics, searchController.diagnostics]
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
  } = useReviewPipeline({ graph, reloadCurrentCanvas, selectedCanvasId, selectedProject, setError, t });

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
            new Set(current.pinnedProjectIds.map((pinnedProjectId) => (pinnedProjectId === project.projectId ? updated.projectId : pinnedProjectId)))
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
        .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
    },
    [selectedCanvasId, selectedProject, setError, t]
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
        .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
    },
    [setError, t]
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
      t
    },
    taskActions: {
      handleDeleteBlock,
      handleDeleteTaskNode,
      handleCopyAgentPrompt,
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
    section: settingsSection,
    setSection: setSettingsSection,
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
  const workspaceShell = {
    activeView,
    handleOpenProject,
    handleRevealPathInFinder,
    loadProject: openProjectInSession,
    projectLoading,
    selectedCanvasId,
    selectedProject,
    selectedTaskPanelId,
    setActiveView,
    setError,
    t
  };
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
    t
  });
  const review = {
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
  };
  const newTask = {
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
  };
  const planning = {
    statistics,
    todoGroups
  };

  return (
    <>
    <div className="relative flex h-screen min-h-0 overflow-hidden text-foreground">
      <div className="app-left-sidebar-shell flex" style={{
        overflow: "hidden",
        width: leftSidebarCollapsed ? 0 : leftSidebarWidth,
        transition: isResizingLeft ? "none" : "width var(--motion-duration-panel) var(--motion-ease-emphasized)",
        willChange: isResizingLeft ? "width" : undefined,
      }}>
        <ProjectSidebar
            activeView={activeView}
            expandedProjectId={expandedProjectId}
            graph={graph}
            handleBindSourceRoot={handleBindSourceRoot}
            handleCopyCanvasToNewProject={handleCopyCanvasToNewProject}
            handleOpenProject={handleOpenProject}
            handleProjectNewGraph={handleProjectNewGraph}
            handleRefreshProjects={refreshProjects}
            handleCopyCanvasAgentPrompt={handleCopyCanvasAgentPrompt}
            handleDeleteProject={handleDeleteProject}
            handleDeleteTaskCanvas={handleDeleteTaskCanvas}
            handleDuplicateTaskCanvas={handleDuplicateTaskCanvas}
            handleDeleteTaskNode={handleDeleteTaskNode}
            handleDropSourceRoot={handleDropSourceRoot}
            handleRevealPlanWorkspace={handleRevealPlanWorkspace}
            handleRevealProject={handleRevealProject}
            handleRevealSourceRoot={handleRevealSourceRoot}
            handleRevealTaskCanvas={handleRevealTaskCanvas}
            handleRenameProject={handleRenameProject}
            handleRenameTaskCanvas={handleRenameTaskCanvas}
            handleUnlinkSourceRoot={handleUnlinkSourceRoot}
            handleTaskPanelSelect={handleTaskPanelSelect}
            isResizing={isResizingLeft}
            loadProject={openProjectInSession}
            notificationItems={notificationController.notificationItems}
            mode={mode}
            teamConnectionRole={teamConnectionRole}
            teamView={teamView}
            onModeChange={setMode}
            onTeamViewChange={setTeamView}
            onResizeStart={(event) => startSidebarResize(event, "left")}
            onTogglePinnedProject={handleTogglePinnedProject}
            pinnedProjectIds={pinnedProjectIds}
            projectRefreshing={projectRefreshing}
            projects={orderedProjects}
            resetLayout={resetLayout}
            selectedProject={selectedProject}
            selectedCanvasId={selectedCanvasId}
            selectedTaskPanelId={selectedTaskPanelId}
            settingsSection={settingsSection}
            setSettingsSection={setSettingsSection}
            setActiveView={setMainView}
            width={leftSidebarWidth}
            t={t}
        />
      </div>
      <CollapsedSidebarControls
        leftSidebarCollapsed={leftSidebarCollapsed}
        setLeftSidebarCollapsed={setLeftSidebarCollapsedPreference}
        t={t}
        width={leftSidebarWidth}
      />
      <div className="app-main-shell glass-surface relative flex-1 min-w-0 overflow-visible">
        <div className="app-drag-region absolute left-0 top-0 z-10 h-5 w-full" />
        <main className="relative flex h-full min-h-0 overflow-hidden" data-testid="app-main-view" data-active-view={activeView} data-mode={mode}>
        {activeView === "settings" ? <AppSettingsRoute {...settingsRouteProps} /> : mode === "team" ? <TeamModeShell embedded teamView={teamView} onConnectionRoleChange={setTeamConnectionRole} onExit={() => setMode("personal")} /> : <WorkspaceTabs
          shell={workspaceShell}
          graphWorkspace={graphWorkspaceController}
          autoRun={autoRunController}
          fileSync={fileSyncController}
          search={searchController}
          review={review}
          newTask={newTask}
          notifications={notificationController}
          planning={planning}
        />}
        {mode !== "team" && activeView === "canvas-map" ? (
          <RightPaletteSidebar
            addPaletteComponent={addPaletteComponent}
            handlePaletteDragStart={handlePaletteDragStart}
            onResizeStart={(event) => startSidebarResize(event, "right")}
            rightSidebarCollapsed={rightSidebarCollapsed}
            setRightSidebarCollapsed={setRightSidebarCollapsedPreference}
            settings={settings}
            width={rightSidebarWidth}
            t={t}
          />
        ) : null}
      </main>
      </div>
    </div>
    <AppOverlays error={error} successMessage={successMessage} setError={setError} setSuccessMessage={setSuccessMessage} t={t} />
  </>
  );
}
