import { useCallback, useEffect, useMemo, useState } from "react";
import { type Edge, type ReactFlowInstance, useEdgesState, useNodesState } from "@xyflow/react";
import type { DesktopPackageFileChangeEvent, DesktopPackageFileSyncResult, DesktopProjectSummary } from "@planweave-ai/runtime";
import { bridge } from "./bridge";
import { edgeTypes, nodeTypes } from "./graph/flowModel";
import { createTranslator } from "./i18n";
import { ProjectSidebar } from "./sidebar/ProjectSidebar";
import { orderProjectsByPinnedIds } from "./settings";
import type { AppFlowNode, AppView } from "./types";
import { WorkspaceTabs } from "./views/WorkspaceTabs";
import { useReviewPipeline } from "./hooks/useReviewPipeline";
import { useGraphPaletteActions } from "./hooks/useGraphPaletteActions";
import { useAutoRunControl } from "./hooks/useAutoRunControl";
import { usePackageFileSync } from "./hooks/usePackageFileSync";
import { useSelectedBlock } from "./hooks/useSelectedBlock";
import { useDesktopSearch } from "./hooks/useDesktopSearch";
import { useTaskDraft } from "./hooks/useTaskDraft";
import { useDesktopProject } from "./hooks/useDesktopProject";
import { useDesktopProjectSession } from "./hooks/useDesktopProjectSession";
import { usePromptDrafts } from "./hooks/usePromptDrafts";
import { useAppViewHistory } from "./hooks/useAppViewHistory";
import { useGraphDeleteActions } from "./hooks/useGraphDeleteActions";
import { useDesktopSettingsEffects } from "./hooks/useDesktopSettingsEffects";
import { useDesktopSettingsBridge } from "./hooks/useDesktopSettingsBridge";
import { useVisibleGraphTasks } from "./hooks/useVisibleGraphTasks";
import { useDetectedAgents } from "./hooks/useDetectedAgents";
import { useRuntimeTools } from "./hooks/useRuntimeTools";
import { useTaskNodeFocus } from "./hooks/useTaskNodeFocus";
import { useTaskExecutorActions } from "./hooks/useTaskExecutorActions";
import { useDesktopProjectActions } from "./hooks/useDesktopProjectActions";
import { useGraphFlowModel } from "./hooks/useGraphFlowModel";
import { useGraphHistoryActions } from "./hooks/useGraphHistoryActions";
import { useAppNotifications } from "./hooks/useAppNotifications";
import { useResizableSidebarLayout } from "./hooks/useResizableSidebarLayout";
import { useLerpedNodeDrag } from "./hooks/useLerpedNodeDrag";
import { CollapsedSidebarControls, RightPaletteSidebar } from "./AppSidebars";
import { AppSettingsRoute } from "./AppSettingsRoute";
import { buildAppSettingsRouteProps } from "./AppSettingsRouteProps";
import { AppOverlays } from "./components/AppOverlays";
import { writeAgentScopePromptToClipboard } from "./agentPrompt";

const emptyExecutorOptions: string[] = [];

export function App() {
  const [error, setError] = useState<string | null>(null);
  const { settings, updateLayoutSettings, updateSettings } = useDesktopSettingsBridge({ setError });
  const language = settings.language;
  const t = useMemo(() => createTranslator(language), [language]);
  const [activeView, setActiveView] = useAppViewHistory("graph");
  const [, setBlockInspectorOpen] = useState(false);
  const { agentDetectionRefreshing, agentDetections, refreshAgentDetections } = useDetectedAgents();
  const { refreshRuntimeTools, runtimeTools } = useRuntimeTools();
  const [lastFileChange, setLastFileChange] = useState<DesktopPackageFileChangeEvent | null>(null);
  const [fileSyncDiagnostics, setFileSyncDiagnostics] = useState<string[]>([]);
  const [fileSyncResult, setFileSyncResult] = useState<DesktopPackageFileSyncResult | null>(null);
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
    handleOpenProject,
    layout,
    projects,
    projectLoading,
    projectPromptMarkdown,
    projectPromptPolicy,
    refreshProjectSummary,
    refreshGraph,
    refreshProjectDerivedState,
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
    autoRunState,
    clearTaskPanelSelection,
    createTaskCanvas: createTaskCanvasInSession,
    deleteTaskCanvas: deleteTaskCanvasInSession,
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

  const {
    autoRunControlRef,
    autoRunControlStyle,
    autoRunNextAction,
    autoRunRetrospective,
    autoRunScopeMode,
    handleAutoRunClick,
    handleAutoRunNextAction,
    miniRunPanelOpen,
    moveAutoRunControl,
    resetRuntimeStateClick,
    setAutoRunScopeMode,
    setMiniRunPanelOpen,
    startAutoRunWithScope,
    startAutoRunControlDrag,
    stopAutoRunClick,
    stopAutoRunControlDrag
  } = useAutoRunControl({
    autoRunState,
    onAutoRunDerivedStateRefresh: refreshProjectDerivedState,
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

  const { handleDeleteBlock, handleDeleteTaskNode } = useGraphDeleteActions({
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

  const {
    desktopSearchResultKinds: searchResultKinds,
    handleSearchResultOpen,
    searchCanvasScope,
    searchQuery,
    searchResults,
    selectedSearchResultKinds,
    setSearchCanvasScope,
    setSearchQuery,
    setSearchResultKindEnabled
  } = useDesktopSearch({
    handleBlockSelect: handleOpenBlockInspector,
    handleOpenRunRecord,
    loadProject: openProjectInSession,
    openTaskInspector: handleOpenTaskInspector,
    selectedCanvasId,
    selectedProject,
    setError
  });

  const {
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
  } = useReviewPipeline({ graph, reloadCurrentCanvas, selectedCanvasId, selectedProject, setError, t });

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
    handleDeleteProject,
    handleDeleteTaskCanvas,
    handleDropSourceRoot,
    handleProjectNewGraph,
    handleRevealPathInFinder,
    handleRevealPlanWorkspace,
    handleRevealProject,
    handleRevealSourceRoot,
    handleRenameTaskCanvas,
    handleUnlinkSourceRoot
  } = useDesktopProjectActions({
    createTaskCanvas: createTaskCanvasInSession,
    deleteTaskCanvas: deleteTaskCanvasInSession,
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
      void writeAgentScopePromptToClipboard({
        project: selectedProject,
        canvasId: selectedCanvasId ?? selectedProject.activeCanvasId ?? "default",
        taskId
      })
        .then(() => setSuccessMessage(t("agentPromptCopied")))
        .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
    },
    [selectedCanvasId, selectedProject, setError, t]
  );
  const handleCopyCanvasAgentPrompt = useCallback(
    (project: DesktopProjectSummary, canvasId: string) => {
      void writeAgentScopePromptToClipboard({
        project,
        canvasId
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
      startAutoRunWithScope
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
  const { refreshPackageFiles } = usePackageFileSync({
    refreshProjectDerivedState,
    reloadCurrentCanvas,
    selectedCanvasId,
    selectedProject,
    setError,
    setFileSyncDiagnostics,
    setFileSyncResult,
    setLastFileChange
  });

  const { visibleTaskIds, visibleTasks } = useVisibleGraphTasks(graph, searchQuery);
  const { handleMarkNotificationRead, notificationItems } = useAppNotifications({
    autoRunState,
    fileSyncDiagnostics,
    graph,
    lastFileChange,
    promptConflicts,
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

  if (activeView === "settings") {
    return (
      <div className="glass-surface relative h-screen min-h-0 overflow-hidden text-foreground">
        <AppSettingsRoute {...settingsRouteProps} />
        <AppOverlays error={error} successMessage={successMessage} setError={setError} setSuccessMessage={setSuccessMessage} t={t} />
      </div>
    );
  }

  return (
    <div className="glass-surface relative h-screen min-h-0 overflow-hidden text-foreground">
      <main className="relative flex h-full min-h-0 overflow-hidden">
        <ProjectSidebar
          activeView={activeView}
          collapsed={leftSidebarCollapsed}
          expandedProjectId={expandedProjectId}
          graph={graph}
          handleBindSourceRoot={handleBindSourceRoot}
          handleOpenProject={handleOpenProject}
          handleProjectNewGraph={handleProjectNewGraph}
          handleCopyCanvasAgentPrompt={handleCopyCanvasAgentPrompt}
          handleDeleteProject={handleDeleteProject}
          handleDeleteTaskCanvas={handleDeleteTaskCanvas}
          handleDeleteTaskNode={handleDeleteTaskNode}
          handleDropSourceRoot={handleDropSourceRoot}
          handleRevealPlanWorkspace={handleRevealPlanWorkspace}
          handleRevealProject={handleRevealProject}
          handleRevealSourceRoot={handleRevealSourceRoot}
          handleRenameTaskCanvas={handleRenameTaskCanvas}
          handleUnlinkSourceRoot={handleUnlinkSourceRoot}
          handleTaskPanelSelect={handleTaskPanelSelect}
          loadProject={openProjectInSession}
          notificationItems={notificationItems}
          onResizeStart={(event) => startSidebarResize(event, "left")}
          onToggleSidebar={() => setLeftSidebarCollapsedPreference((current) => !current)}
          onTogglePinnedProject={handleTogglePinnedProject}
          pinnedProjectIds={pinnedProjectIds}
          projects={orderedProjects}
          resetLayout={resetLayout}
          selectedProject={selectedProject}
          selectedCanvasId={selectedCanvasId}
          selectedTaskPanelId={selectedTaskPanelId}
          setActiveView={setActiveView}
          width={leftSidebarWidth}
          t={t}
        />
        <WorkspaceTabs
          activeView={activeView}
          addReviewStep={addReviewStep}
          autoRunControlRef={autoRunControlRef}
          autoRunControlStyle={autoRunControlStyle}
          autoRunNextAction={autoRunNextAction}
          autoRunRetrospective={autoRunRetrospective}
          autoRunScopeMode={autoRunScopeMode}
          autoRunState={autoRunState}
          confirmTaskDraft={confirmTaskDraft}
          edges={edges}
          edgeTypes={edgeTypes}
          executionPlan={executionPlan}
          fileSyncResult={fileSyncResult}
          generateTaskDraft={generateTaskDraft}
          graph={graph}
          handleAutoRunClick={handleAutoRunClick}
          handleAutoRunNextAction={handleAutoRunNextAction}
          handleOpenBlockInspector={handleOpenBlockInspector}
          handleConnect={handleConnect}
          handleEdgesDelete={handleEdgesDelete}
          handleReconnectEdge={handleReconnectEdge}
          handleGraphDragOver={handleGraphDragOver}
          handleGraphDrop={handleGraphDrop}
          handleOpenProject={handleOpenProject}
          handleOpenRunRecord={handleOpenRunRecord}
          handleRedoGraph={handleRedoGraph}
          handleRevealPathInFinder={handleRevealPathInFinder}
          handleSearchResultOpen={handleSearchResultOpen}
          handleUndoGraph={handleUndoGraph}
          language={language}
          loadProject={openProjectInSession}
          miniRunPanelOpen={miniRunPanelOpen}
          moveAutoRunControl={moveAutoRunControl}
          moveReviewStep={moveReviewStep}
          newTaskMode={newTaskMode}
          newTaskTargetId={newTaskTargetId}
          newTaskText={newTaskText}
          nodeTypes={nodeTypes}
          nodes={nodes}
          notificationItems={notificationItems}
          onApplyLocalPromptConflicts={applyLocalPromptConflicts}
          onKeepLocalPromptConflicts={keepLocalPromptConflicts}
          projectLoading={projectLoading}
          onMarkNotificationRead={handleMarkNotificationRead}
          onReloadPromptConflicts={reloadPromptConflicts}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={handleNodeDragStop}
          onNodesChange={lerpedNodeDrag.onNodesChange}
          onTaskPanelSelect={handleTaskPanelSelect}
          refreshPackageFiles={refreshPackageFiles}
          resetRuntimeStateClick={resetRuntimeStateClick}
          removeReviewStep={removeReviewStep}
          reviewDefaultCyclesDraft={reviewDefaultCyclesDraft}
          reviewDraft={reviewDraft}
          reviewPipeline={reviewPipeline}
          reviewTaskId={reviewTaskId}
          saveReviewPipeline={saveReviewPipeline}
          searchCanvasScope={searchCanvasScope}
          searchQuery={searchQuery}
          searchResultKinds={searchResultKinds}
          searchResults={searchResults}
          selectedBlockPresent={Boolean(selectedBlock)}
          selectedCanvasId={selectedCanvasId}
          selectedProject={selectedProject}
          selectedSearchResultKinds={selectedSearchResultKinds}
          selectedTaskPanelId={selectedTaskPanelId}
          setActiveView={setActiveView}
          setError={setError}
          onAgentPromptCopied={() => setSuccessMessage(t("agentPromptCopied"))}
          setAutoRunScopeMode={setAutoRunScopeMode}
          setSearchCanvasScope={setSearchCanvasScope}
          setFlowInstance={setFlowInstance}
          setMiniRunPanelOpen={setMiniRunPanelOpen}
          setNewTaskMode={setNewTaskMode}
          setNewTaskTargetId={setNewTaskTargetId}
          setNewTaskText={setNewTaskText}
          setTaskDraft={setTaskDraft}
          setReviewDefaultCyclesDraft={setReviewDefaultCyclesDraft}
          setReviewTaskId={setReviewTaskId}
          setSearchQuery={setSearchQuery}
          setSearchResultKindEnabled={setSearchResultKindEnabled}
          settings={settings}
          startAutoRunControlDrag={startAutoRunControlDrag}
          statistics={statistics}
          stopAutoRunClick={stopAutoRunClick}
          stopAutoRunControlDrag={stopAutoRunControlDrag}
          t={t}
          taskDraft={taskDraft}
          todoGroups={todoGroups}
          updateReviewStep={updateReviewStep}
          updateSettings={updateSettings}
          visibleTaskIds={visibleTaskIds}
          visibleTasks={visibleTasks}
        />
        {activeView === "canvas-map" ? null : (
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
        )}
      </main>
      <CollapsedSidebarControls
        leftSidebarCollapsed={leftSidebarCollapsed}
        rightSidebarCollapsed={activeView === "canvas-map" ? false : rightSidebarCollapsed}
        setLeftSidebarCollapsed={setLeftSidebarCollapsedPreference}
        setRightSidebarCollapsed={setRightSidebarCollapsedPreference}
        t={t}
      />
      <AppOverlays error={error} successMessage={successMessage} setError={setError} setSuccessMessage={setSuccessMessage} t={t} />
    </div>
  );
}
