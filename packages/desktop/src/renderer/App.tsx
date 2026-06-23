import { useCallback, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { type Edge, type ReactFlowInstance, useEdgesState, useNodesState } from "@xyflow/react";
import type { DesktopPackageFileChangeEvent, DesktopPackageFileSyncResult } from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "./bridge";
import { nodeTypes } from "./graph/flowModel";
import { createTranslator } from "./i18n";
import { ProjectSidebar } from "./sidebar/ProjectSidebar";
import { buildNotificationItems } from "./notifications";
import { loadDesktopSettings, mergeDesktopSettings, orderProjectsByPinnedIds } from "./settings";
import type { AppFlowNode, AppView, DesktopUiSettings } from "./types";
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
import { useVisibleGraphTasks } from "./hooks/useVisibleGraphTasks";
import { useDetectedAgents } from "./hooks/useDetectedAgents";
import { useRuntimeTools } from "./hooks/useRuntimeTools";
import { useTaskNodeFocus } from "./hooks/useTaskNodeFocus";
import { useTaskExecutorActions } from "./hooks/useTaskExecutorActions";
import { useDesktopProjectActions } from "./hooks/useDesktopProjectActions";
import { useGraphFlowModel } from "./hooks/useGraphFlowModel";
import { CollapsedSidebarControls, RightPaletteSidebar } from "./AppSidebars";
import { AppSettingsRoute } from "./AppSettingsRoute";
import { AppOverlays } from "./components/AppOverlays";

const leftSidebarWidthBounds = { min: 220, max: 520, defaultValue: 280 };
const rightSidebarWidthBounds = { min: 240, max: 520, defaultValue: 300 };

function clampSidebarWidth(width: number, bounds: { min: number; max: number }): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));
}

export function App() {
  const [settings, setSettings] = useState<DesktopUiSettings>(() => loadDesktopSettings());
  const language = settings.language;
  const t = useMemo(() => createTranslator(language), [language]);
  const [activeView, setActiveView] = useAppViewHistory("graph");
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false);
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(leftSidebarWidthBounds.defaultValue);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(rightSidebarWidthBounds.defaultValue);
  const [, setBlockInspectorOpen] = useState(false);
  const { agentDetectionRefreshing, agentDetections, executorOptions, refreshAgentDetections } = useDetectedAgents();
  const { refreshRuntimeTools, runtimeTools } = useRuntimeTools();
  const [lastFileChange, setLastFileChange] = useState<DesktopPackageFileChangeEvent | null>(null);
  const [fileSyncDiagnostics, setFileSyncDiagnostics] = useState<string[]>([]);
  const [fileSyncResult, setFileSyncResult] = useState<DesktopPackageFileSyncResult | null>(null);
  const [dirtyPromptRefs, setDirtyPromptRefs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(bridge ? null : t("bridgeUnavailable"));
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<AppFlowNode, Edge> | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<AppFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const updateSettings = useCallback((patch: Partial<DesktopUiSettings>) => {
    setSettings((current) => mergeDesktopSettings(current, patch));
  }, []);

  useDesktopSettingsEffects(settings);

  const startSidebarResize = useCallback(
    (event: ReactPointerEvent, side: "left" | "right") => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = side === "left" ? leftSidebarWidth : rightSidebarWidth;
      const bounds = side === "left" ? leftSidebarWidthBounds : rightSidebarWidthBounds;
      const updateWidth = side === "left" ? setLeftSidebarWidth : setRightSidebarWidth;
      const previousCursor = window.document.body.style.cursor;
      const previousUserSelect = window.document.body.style.userSelect;

      window.document.body.style.cursor = "col-resize";
      window.document.body.style.userSelect = "none";

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - startX;
        updateWidth(clampSidebarWidth(side === "left" ? startWidth + delta : startWidth - delta, bounds));
      };
      const stopResize = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", stopResize);
        window.removeEventListener("pointercancel", stopResize);
        window.document.body.style.cursor = previousCursor;
        window.document.body.style.userSelect = previousUserSelect;
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopResize);
      window.addEventListener("pointercancel", stopResize);
    },
    [leftSidebarWidth, rightSidebarWidth]
  );

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
      updateSettings({
        pinnedProjectIds: pinnedProjectIds.has(projectId)
          ? settings.pinnedProjectIds.filter((pinnedProjectId) => pinnedProjectId !== projectId)
          : [...settings.pinnedProjectIds, projectId]
      });
    },
    [pinnedProjectIds, settings.pinnedProjectIds, updateSettings]
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
    autoRunControlStyle,
    autoRunScopeMode,
    handleAutoRunClick,
    miniRunPanelOpen,
    moveAutoRunControl,
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
    setAutoRunState,
    setError,
    t,
    tmuxMonitoringEnabled: settings.execution.tmuxMonitoring && runtimeTools.tmux.available
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
    selectedCanvasId,
    selectedProject,
    setError,
    selectTaskPanel: handleTaskPanelSelect
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
    handleUnlinkSourceRoot
  } = useDesktopProjectActions({
    createTaskCanvas: createTaskCanvasInSession,
    deleteTaskCanvas: deleteTaskCanvasInSession,
    refreshProjectSummary,
    removeProject,
    setActiveView,
    setError,
    t
  });

  const handleUndoGraph = useCallback(async () => {
    if (!bridge || !selectedProject) {
      return;
    }
    try {
      const result = await bridge.undoPlanGraphCommand(desktopCanvasReference(selectedProject, selectedCanvasId));
      if (!result.ok) {
        setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
        return;
      }
      const overview = await bridge.getProjectOverview(selectedProject.rootPath);
      if ((overview.activeCanvasId ?? null) !== selectedCanvasId) {
        await openProjectInSession(overview, overview.activeCanvasId, { recordCanvasSelection: false });
        return;
      }
      await refreshProjectDerivedState({ includeLayout: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [openProjectInSession, refreshProjectDerivedState, selectedCanvasId, selectedProject, setError]);
  const handleRedoGraph = useCallback(async () => {
    if (!bridge || !selectedProject) {
      return;
    }
    try {
      const result = await bridge.redoPlanGraphCommand(desktopCanvasReference(selectedProject, selectedCanvasId));
      if (!result.ok) {
        setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
        return;
      }
      const overview = await bridge.getProjectOverview(selectedProject.rootPath);
      if ((overview.activeCanvasId ?? null) !== selectedCanvasId) {
        await openProjectInSession(overview, overview.activeCanvasId, { recordCanvasSelection: false });
        return;
      }
      await refreshProjectDerivedState({ includeLayout: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [openProjectInSession, refreshProjectDerivedState, selectedCanvasId, selectedProject, setError]);

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
      executorOptions,
      graph,
      layout,
      selectedBlock,
      t
    },
    taskActions: {
      handleDeleteBlock,
      handleDeleteTaskNode,
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
    setDirtyPromptRefs,
    setError,
    setFileSyncDiagnostics,
    setFileSyncResult,
    setLastFileChange
  });

  const { visibleTaskIds, visibleTasks } = useVisibleGraphTasks(graph, searchQuery);
  const notificationItems = buildNotificationItems({
    autoRunState,
    dirtyPromptRefs,
    fileSyncDiagnostics,
    graph,
    lastFileChange,
    promptConflicts,
    settings,
    t
  });
  const handleMarkNotificationRead = useCallback(
    (notificationId: string) => {
      if (settings.readNotificationIds.includes(notificationId)) {
        return;
      }
      updateSettings({ readNotificationIds: [...settings.readNotificationIds, notificationId] });
    },
    [settings.readNotificationIds, updateSettings]
  );
  const settingsRouteProps = {
    graph,
    agents: agentDetections,
    agentDetectionRefreshing,
    language,
    refreshAgentDetections,
    refreshRuntimeTools,
    runtimeTools,
    projects: orderedProjects,
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
  };

  if (activeView === "settings") {
    return (
      <div className="glass-surface relative h-screen min-h-0 overflow-hidden text-foreground">
        <AppSettingsRoute {...settingsRouteProps} />
        <AppOverlays error={error} setError={setError} t={t} />
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
          handleDeleteProject={handleDeleteProject}
          handleDeleteTaskCanvas={handleDeleteTaskCanvas}
          handleDeleteTaskNode={handleDeleteTaskNode}
          handleDropSourceRoot={handleDropSourceRoot}
          handleRevealPlanWorkspace={handleRevealPlanWorkspace}
          handleRevealProject={handleRevealProject}
          handleRevealSourceRoot={handleRevealSourceRoot}
          handleUnlinkSourceRoot={handleUnlinkSourceRoot}
          handleTaskPanelSelect={handleTaskPanelSelect}
          loadProject={openProjectInSession}
          notificationItems={notificationItems}
          onResizeStart={(event) => startSidebarResize(event, "left")}
          onToggleSidebar={() => setLeftSidebarCollapsed((current) => !current)}
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
          autoRunControlStyle={autoRunControlStyle}
          autoRunScopeMode={autoRunScopeMode}
          autoRunState={autoRunState}
          confirmTaskDraft={confirmTaskDraft}
          dirtyPromptRefs={dirtyPromptRefs}
          edges={edges}
          executionPlan={executionPlan}
          fileSyncResult={fileSyncResult}
          generateTaskDraft={generateTaskDraft}
          graph={graph}
          handleAutoRunClick={handleAutoRunClick}
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
          onNodesChange={onNodesChange}
          onTaskPanelSelect={handleTaskPanelSelect}
          refreshPackageFiles={refreshPackageFiles}
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
            setRightSidebarCollapsed={setRightSidebarCollapsed}
            settings={settings}
            width={rightSidebarWidth}
            t={t}
          />
        )}
      </main>
      <CollapsedSidebarControls
        leftSidebarCollapsed={leftSidebarCollapsed}
        rightSidebarCollapsed={activeView === "canvas-map" ? false : rightSidebarCollapsed}
        setLeftSidebarCollapsed={setLeftSidebarCollapsed}
        setRightSidebarCollapsed={setRightSidebarCollapsed}
        t={t}
      />
      <AppOverlays error={error} setError={setError} t={t} />
    </div>
  );
}
