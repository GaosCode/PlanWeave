import { useCallback, useEffect, useMemo, useState } from "react";
import { type Edge, type ReactFlowInstance, useEdgesState, useNodesState } from "@xyflow/react";
import type { DesktopPackageFileChangeEvent, DesktopProjectSummary } from "@planweave/runtime";
import { bridge, desktopCanvasReference } from "./bridge";
import { nodeTypes, graphEdges, graphNodes } from "./graph/flowModel";
import { taskNodeLabels } from "./graph/taskNodeLabels";
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
import { useTaskNodeFocus } from "./hooks/useTaskNodeFocus";
import { CollapsedSidebarControls, RightPaletteSidebar } from "./AppSidebars";
import { AppSettingsRoute } from "./AppSettingsRoute";

export function App() {
  const [settings, setSettings] = useState<DesktopUiSettings>(() => loadDesktopSettings());
  const language = settings.language;
  const t = useMemo(() => createTranslator(language), [language]);
  const [activeView, setActiveView] = useAppViewHistory("graph");
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false);
  const [, setBlockInspectorOpen] = useState(false);
  const { agentDetectionRefreshing, agentDetections, executorOptions, refreshAgentDetections } = useDetectedAgents();
  const [selectedTaskPanelId, setSelectedTaskPanelId] = useState<string | null>(null);
  const [selectedContextNodeId, setSelectedContextNodeId] = useState<string | null>(null);
  const [, setProjectPath] = useState(settings.runtimePath);
  const [lastFileChange, setLastFileChange] = useState<DesktopPackageFileChangeEvent | null>(null);
  const [fileSyncDiagnostics, setFileSyncDiagnostics] = useState<string[]>([]);
  const [dirtyPromptRefs, setDirtyPromptRefs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(bridge ? null : t("bridgeUnavailable"));
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<AppFlowNode, Edge> | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<AppFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const updateSettings = useCallback((patch: Partial<DesktopUiSettings>) => {
    setSettings((current) => mergeDesktopSettings(current, patch));
  }, []);

  useDesktopSettingsEffects(settings);

  const desktopProject = useDesktopProject({
    setError,
    setSelectedContextNodeId,
    setSelectedTaskPanelId,
    updateSettings
  });
  const {
    expandedProjectId,
    graph,
    handleOpenProject,
    layout,
    projects,
    refreshGraph,
    removeProject,
    selectedCanvasId,
    selectedProject,
    setLayout,
    statistics,
    todoGroups
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
    setError,
    setSelectedContextNodeId,
    setSelectedTaskPanelId
  });

  const {
    autoRunControlStyle,
    autoRunScopeMode,
    autoRunState,
    handleAutoRunClick,
    miniRunPanelOpen,
    moveAutoRunControl,
    setAutoRunScopeMode,
    setAutoRunState,
    setMiniRunPanelOpen,
    startAutoRunControlDrag,
    stopAutoRunClick,
    stopAutoRunControlDrag
  } = useAutoRunControl({ selectedCanvasId, selectedBlock, selectedProject, selectedTaskPanelId, setError, t });
  const { requestTaskFocus } = useTaskNodeFocus({
    activeView,
    flowInstance,
    nodes,
    selectedTaskPanelId
  });

  const {
    createTaskCanvas: createTaskCanvasInSession,
    deleteTaskCanvas: deleteTaskCanvasInSession,
    openProject: openProjectInSession
  } = useDesktopProjectSession({
    clearSelectedBlockRecords,
    projectState: desktopProject,
    setAutoRunState,
    setBlockInspectorOpen,
    setSelectedBlock,
    setSelectedRunRecord
  });

  const handleOpenBlockInspector = useCallback(
    async (ref: string, canvasIdOverride?: string | null) => {
      const canvasId = canvasIdOverride === undefined ? selectedCanvasId : canvasIdOverride;
      try {
        await handleBlockSelect(ref, canvasId);
        if (!bridge || !selectedProject) {
          return;
        }
        await bridge.openBlockInspectorWindow({
          blockRef: ref,
          canvas: desktopCanvasReference(selectedProject, canvasId),
          language,
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [handleBlockSelect, language, selectedCanvasId, selectedProject]
  );

  const { handleDeleteBlock, handleDeleteTaskNode } = useGraphDeleteActions({
    clearSelectedBlockRecords,
    deleteBlockConfirm: t("deleteBlockConfirm"),
    deleteTaskConfirm: t("deleteTaskConfirm"),
    loadProject: openProjectInSession,
    refreshGraph,
    selectedCanvasId,
    selectedBlock,
    selectedProject,
    selectedTaskPanelId,
    setBlockInspectorOpen,
    setError,
    setSelectedBlock,
    setSelectedRunRecord,
    setSelectedTaskPanelId
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
    taskDraft
  } = useTaskDraft({ loadProject: openProjectInSession, selectedCanvasId, selectedProject, setActiveView, setError });

  const { handleSearchResultOpen, searchQuery, searchResults, setSearchQuery } = useDesktopSearch({
    handleBlockSelect: handleOpenBlockInspector,
    handleOpenRunRecord,
    loadProject: openProjectInSession,
    selectedCanvasId,
    selectedProject,
    setActiveView,
    setError,
    setSelectedContextNodeId,
    setSelectedTaskPanelId
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
  } = useReviewPipeline({ graph, loadProject: openProjectInSession, selectedCanvasId, selectedProject, setError, t });

  const {
    handlePromptChange,
    handlePromptSave,
    handleTitleChange,
    handleTitleSave,
    promptDrafts,
    saveStates,
    titleDrafts
  } = usePromptDrafts({ graph, refreshGraph, selectedCanvasId, selectedProject, setError });

  const handleTaskExecutorChange = useCallback(
    async (taskId: string, executorName: string | null) => {
      if (!bridge || !selectedProject) {
        return;
      }
      try {
        const result = await bridge.updateTaskExecutor(desktopCanvasReference(selectedProject, selectedCanvasId), taskId, executorName);
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
        await refreshGraph();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [refreshGraph, selectedCanvasId, selectedProject]
  );

  const handleTaskPanelSelect = useCallback((taskId: string | null) => {
    setSelectedTaskPanelId(taskId);
    setSelectedContextNodeId(null);
    setActiveView("graph");
    requestTaskFocus(taskId);
  }, [requestTaskFocus]);

  const handleProjectNewGraph = useCallback(
    async (project: DesktopProjectSummary) => {
      if (!bridge) {
        setError(t("bridgeUnavailable"));
        return;
      }
      try {
        await createTaskCanvasInSession(project);
        setActiveView("new-task");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [createTaskCanvasInSession, setActiveView, t]
  );

  const handleRevealProject = useCallback(
    async (project: DesktopProjectSummary) => {
      if (!bridge) {
        setError(t("bridgeUnavailable"));
        return;
      }
      try {
        await bridge.revealProjectInFinder(project.rootPath);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [t]
  );

  const handleDeleteProject = useCallback(
    async (project: DesktopProjectSummary) => {
      if (!window.confirm(t("deleteProjectConfirm"))) {
        return;
      }
      try {
        await removeProject(project);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [removeProject, t]
  );

  const handleDeleteTaskCanvas = useCallback(
    async (project: DesktopProjectSummary, canvasId: string) => {
      if (!bridge) {
        return;
      }
      if (!window.confirm(t("deleteTaskCanvasConfirm"))) {
        return;
      }
      try {
        await deleteTaskCanvasInSession(project, canvasId);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [deleteTaskCanvasInSession, t]
  );


  useEffect(() => {
    if (!graph) {
      setNodes([]);
      setEdges([]);
      return;
    }
    setNodes(
      graphNodes(
        graph,
        layout,
        executorOptions,
        titleDrafts,
        promptDrafts,
        saveStates,
        taskNodeLabels(t),
        selectedBlock,
        blockRunRecords,
        blockReviewAttempts,
        blockFeedbackRecords,
        handleTitleChange,
        handleTitleSave,
        handleTaskExecutorChange,
        handlePromptChange,
        handlePromptSave,
        handleOpenBlockInspector,
        handleOpenBlockInspector,
        handleDeleteTaskNode,
        handleDeleteBlock,
        setSelectedBlock,
        saveSelectedBlockTitle,
        saveSelectedBlockExecutor,
        saveSelectedBlockPrompt,
        handleOpenRunRecord,
        selectedContextNodeId
      )
    );
    setEdges(graphEdges(graph));
  }, [
    graph,
    executorOptions,
    blockFeedbackRecords,
    blockReviewAttempts,
    blockRunRecords,
    handleDeleteBlock,
    handleDeleteTaskNode,
    handleOpenBlockInspector,
    handleOpenRunRecord,
    handlePromptChange,
    handlePromptSave,
    handleTaskExecutorChange,
    handleTitleChange,
    handleTitleSave,
    layout,
    promptDrafts,
    saveStates,
    setEdges,
    setNodes,
    saveSelectedBlockExecutor,
    saveSelectedBlockPrompt,
    saveSelectedBlockTitle,
    selectedBlock,
    selectedContextNodeId,
    t,
    titleDrafts
  ]);

  const {
    addPaletteComponent,
    handleConnect,
    handleEdgesDelete,
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
    refreshGraph,
    selectedCanvasId,
    selectedBlock,
    selectedProject,
    selectedTaskPanelId,
    setError,
    setLayout,
    setNewTaskTargetId,
    setSelectedTaskPanelId,
    settings,
    t
  });
  const { refreshPackageFiles } = usePackageFileSync({
    loadProject: openProjectInSession,
    selectedCanvasId,
    selectedProject,
    setDirtyPromptRefs,
    setError,
    setFileSyncDiagnostics,
    setLastFileChange
  });

  const { visibleTaskIds, visibleTasks } = useVisibleGraphTasks(graph, searchQuery);
  const notificationItems = buildNotificationItems({
    autoRunState,
    dirtyPromptRefs,
    fileSyncDiagnostics,
    graph,
    lastFileChange,
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

  if (activeView === "settings") {
    return (
      <AppSettingsRoute
        graph={graph}
        agents={agentDetections}
        agentDetectionRefreshing={agentDetectionRefreshing}
        language={language}
        refreshAgentDetections={refreshAgentDetections}
        setActiveView={setActiveView}
        settings={settings}
        t={t}
        updateSettings={updateSettings}
      />
    );
  }

  return (
    <div className="relative h-screen min-h-0 overflow-hidden bg-background text-foreground">
      <main className="relative flex h-full min-h-0 overflow-hidden">
        <ProjectSidebar
          activeView={activeView}
          collapsed={leftSidebarCollapsed}
          expandedProjectId={expandedProjectId}
          graph={graph}
          handleOpenProject={handleOpenProject}
          handleProjectNewGraph={handleProjectNewGraph}
          handleDeleteProject={handleDeleteProject}
          handleDeleteTaskCanvas={handleDeleteTaskCanvas}
          handleDeleteTaskNode={handleDeleteTaskNode}
          handleRevealProject={handleRevealProject}
          handleTaskPanelSelect={handleTaskPanelSelect}
          loadProject={openProjectInSession}
          notificationItems={notificationItems}
          onToggleSidebar={() => setLeftSidebarCollapsed((current) => !current)}
          onTogglePinnedProject={handleTogglePinnedProject}
          pinnedProjectIds={pinnedProjectIds}
          projects={orderedProjects}
          resetLayout={resetLayout}
          selectedProject={selectedProject}
          selectedCanvasId={selectedCanvasId}
          selectedTaskPanelId={selectedTaskPanelId}
          setActiveView={setActiveView}
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
          generateTaskDraft={generateTaskDraft}
          graph={graph}
          handleAutoRunClick={handleAutoRunClick}
          handleBlockSelect={handleBlockSelect}
          handleOpenBlockInspector={handleOpenBlockInspector}
          handleConnect={handleConnect}
          handleEdgesDelete={handleEdgesDelete}
          handleGraphDragOver={handleGraphDragOver}
          handleGraphDrop={handleGraphDrop}
          handleOpenProject={handleOpenProject}
          handleOpenRunRecord={handleOpenRunRecord}
          handleSearchResultOpen={handleSearchResultOpen}
          language={language}
          miniRunPanelOpen={miniRunPanelOpen}
          moveAutoRunControl={moveAutoRunControl}
          moveReviewStep={moveReviewStep}
          newTaskMode={newTaskMode}
          newTaskTargetId={newTaskTargetId}
          newTaskText={newTaskText}
          nodeTypes={nodeTypes}
          nodes={nodes}
          notificationItems={notificationItems}
          onMarkNotificationRead={handleMarkNotificationRead}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={handleNodeDragStop}
          onNodesChange={onNodesChange}
          refreshPackageFiles={refreshPackageFiles}
          removeReviewStep={removeReviewStep}
          reviewDefaultCyclesDraft={reviewDefaultCyclesDraft}
          reviewDraft={reviewDraft}
          reviewPipeline={reviewPipeline}
          reviewTaskId={reviewTaskId}
          saveReviewPipeline={saveReviewPipeline}
          searchQuery={searchQuery}
          searchResults={searchResults}
          selectedBlockPresent={Boolean(selectedBlock)}
          selectedProject={selectedProject}
          selectedTaskPanelId={selectedTaskPanelId}
          setActiveView={setActiveView}
          setAutoRunScopeMode={setAutoRunScopeMode}
          setFlowInstance={setFlowInstance}
          setMiniRunPanelOpen={setMiniRunPanelOpen}
          setNewTaskMode={setNewTaskMode}
          setNewTaskTargetId={setNewTaskTargetId}
          setNewTaskText={setNewTaskText}
          setProjectPath={setProjectPath}
          setReviewDefaultCyclesDraft={setReviewDefaultCyclesDraft}
          setReviewTaskId={setReviewTaskId}
          setSearchQuery={setSearchQuery}
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
        <RightPaletteSidebar
          addPaletteComponent={addPaletteComponent}
          handlePaletteDragStart={handlePaletteDragStart}
          rightSidebarCollapsed={rightSidebarCollapsed}
          setRightSidebarCollapsed={setRightSidebarCollapsed}
          settings={settings}
          t={t}
        />
      </main>
      <CollapsedSidebarControls
        leftSidebarCollapsed={leftSidebarCollapsed}
        rightSidebarCollapsed={rightSidebarCollapsed}
        setLeftSidebarCollapsed={setLeftSidebarCollapsed}
        setRightSidebarCollapsed={setRightSidebarCollapsed}
        t={t}
      />
    </div>
  );
}
