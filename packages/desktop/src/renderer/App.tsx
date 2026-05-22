import { useCallback, useEffect, useMemo, useState } from "react";
import { type Edge, type ReactFlowInstance, useEdgesState, useNodesState } from "@xyflow/react";
import type { DesktopPackageFileChangeEvent, DesktopProjectSummary } from "@planweave/runtime";
import { PanelLeftOpenIcon, PanelRightCloseIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { bridge } from "./bridge";
import { ComponentPalette } from "./palette/ComponentPalette";
import { WindowTitleBar } from "./components/WindowTitleBar";
import { BlockInspector } from "./inspector/BlockInspector";
import { nodeTypes, graphEdges, graphNodes } from "./graph/flowModel";
import { createTranslator } from "./i18n";
import { ProjectSidebar } from "./sidebar/ProjectSidebar";
import { buildNotificationItems } from "./notifications";
import { loadDesktopSettings } from "./settings";
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
import { useDraggablePanel } from "./hooks/useDraggablePanel";
import { usePromptDrafts } from "./hooks/usePromptDrafts";
import { useAppViewHistory } from "./hooks/useAppViewHistory";
import { useGraphDeleteActions } from "./hooks/useGraphDeleteActions";
import { useDesktopSettingsEffects } from "./hooks/useDesktopSettingsEffects";
import { useVisibleGraphTasks } from "./hooks/useVisibleGraphTasks";
import { SettingsView } from "./views/SettingsView";
import { HistoryNavigationButtons } from "./components/HistoryNavigationButtons";

export function App() {
  const [settings, setSettings] = useState<DesktopUiSettings>(() => loadDesktopSettings());
  const language = settings.language;
  const t = useMemo(() => createTranslator(language), [language]);
  const [activeView, setActiveView] = useAppViewHistory("graph");
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false);
  const [blockInspectorOpen, setBlockInspectorOpen] = useState(false);
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
  const {
    dragHandlers: blockInspectorDragHandlers,
    panelStyle: blockInspectorStyle,
    resizeHandlers: blockInspectorResizeHandlers
  } = useDraggablePanel(
    { left: 560, top: 116 },
    { width: 520, height: 620, maxHeight: 820, maxWidth: 760, minHeight: 420, minTop: 56, minWidth: 380, viewportHeightOffset: 44 }
  );

  const updateSettings = useCallback((patch: Partial<DesktopUiSettings>) => {
    setSettings((current) => ({
      ...current,
      ...patch,
      notifications: {
        ...current.notifications,
        ...patch.notifications
      },
      review: {
        ...current.review,
        ...patch.review
      },
      palette: {
        ...current.palette,
        ...patch.palette,
        visible: {
          ...current.palette.visible,
          ...patch.palette?.visible
        }
      },
      agents: {
        codex: {
          ...current.agents.codex,
          ...patch.agents?.codex
        },
        "claude-code": {
          ...current.agents["claude-code"],
          ...patch.agents?.["claude-code"]
        },
        opencode: {
          ...current.agents.opencode,
          ...patch.agents?.opencode
        }
      }
    }));
  }, []);

  useDesktopSettingsEffects(settings);

  const {
    expandedProjectId,
    graph,
    handleOpenProject,
    layout,
    loadProject,
    projects,
    refreshGraph,
    selectedProject,
    setLayout,
    statistics,
    todoGroups
  } = useDesktopProject({
    setError,
    setSelectedContextNodeId,
    setSelectedTaskPanelId,
    updateSettings
  });

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
    selectedRunRecord,
    setSelectedBlock,
    setSelectedRunRecord
  } = useSelectedBlock({
    refreshGraph,
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
  } = useAutoRunControl({ selectedBlock, selectedProject, selectedTaskPanelId, setError, t });

  useEffect(() => {
    setSelectedBlock(null);
    setSelectedRunRecord(null);
    setBlockInspectorOpen(false);
    clearSelectedBlockRecords();
  }, [clearSelectedBlockRecords, selectedProject?.projectId, setSelectedBlock, setSelectedRunRecord]);

  useEffect(() => {
    if (!bridge || !selectedProject) {
      setAutoRunState(null);
      return;
    }
    void bridge.getLatestAutoRunSummary(selectedProject.rootPath).then(setAutoRunState);
  }, [selectedProject, setAutoRunState]);

  const loadProjectWithSelectionReset = useCallback(
    async (project: Parameters<typeof loadProject>[0]) => {
      setSelectedBlock(null);
      setSelectedRunRecord(null);
      setBlockInspectorOpen(false);
      clearSelectedBlockRecords();
      await loadProject(project);
      if (bridge) {
        const summary = await bridge.getLatestAutoRunSummary(project.rootPath);
        setAutoRunState(summary);
      } else {
        setAutoRunState(null);
      }
    },
    [clearSelectedBlockRecords, loadProject, setAutoRunState, setSelectedBlock, setSelectedRunRecord]
  );

  const handleOpenBlockInspector = useCallback(
    async (ref: string) => {
      setBlockInspectorOpen(true);
      await handleBlockSelect(ref);
    },
    [handleBlockSelect]
  );

  const closeBlockInspector = useCallback(() => {
    setBlockInspectorOpen(false);
    setSelectedRunRecord(null);
  }, [setSelectedRunRecord]);

  const { handleDeleteBlock, handleDeleteTaskNode } = useGraphDeleteActions({
    clearSelectedBlockRecords,
    deleteBlockConfirm: t("deleteBlockConfirm"),
    deleteTaskConfirm: t("deleteTaskConfirm"),
    loadProject: loadProjectWithSelectionReset,
    refreshGraph,
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
  } = useTaskDraft({ loadProject: loadProjectWithSelectionReset, selectedProject, setActiveView, setError });

  const { handleSearchResultOpen, searchQuery, searchResults, setSearchQuery } = useDesktopSearch({
    handleBlockSelect: handleOpenBlockInspector,
    handleOpenRunRecord,
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
  } = useReviewPipeline({ graph, loadProject: loadProjectWithSelectionReset, selectedProject, setError, t });

  const {
    handlePromptChange,
    handlePromptSave,
    handleTitleChange,
    handleTitleSave,
    promptDrafts,
    saveStates,
    titleDrafts
  } = usePromptDrafts({ graph, refreshGraph, selectedProject, setError });

  const handleTaskExecutorChange = useCallback(
    async (taskId: string, executorName: string | null) => {
      if (!bridge || !selectedProject) {
        return;
      }
      try {
        const result = await bridge.updateTaskExecutor(selectedProject.rootPath, taskId, executorName);
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
        await refreshGraph();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [refreshGraph, selectedProject]
  );

  const handleTaskPanelSelect = useCallback((taskId: string | null) => {
    setSelectedTaskPanelId(taskId);
    setSelectedContextNodeId(null);
    setActiveView("graph");
  }, []);

  const handleProjectNewGraph = useCallback(
    async (project: DesktopProjectSummary) => {
      await loadProjectWithSelectionReset(project);
      setActiveView("new-task");
    },
    [loadProjectWithSelectionReset, setActiveView]
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
        titleDrafts,
        promptDrafts,
        saveStates,
        {
          blockStack: t("blockStack"),
          exception: t("exception"),
          exceptionOverlay: t("exceptionOverlay"),
          inherit: t("inherit"),
          more: t("more"),
          noBlockRecords: t("noBlockRecords"),
          openRecord: t("openRecord"),
          savePrompt: t("savePrompt"),
          selectedBlock: t("selectedBlock"),
          sourcePrompt: t("sourcePrompt"),
          taskException: t("taskException"),
          taskPrompt: t("taskPrompt"),
          title: t("title"),
          agent: t("agent"),
          effectiveExecutor: t("effectiveExecutor"),
          blockExecutionSummary: t("blockExecutionSummary"),
          latestRun: t("latestRun"),
          latestReviewAttempt: t("latestReviewAttempt"),
          feedbackMarker: t("feedbackMarker"),
          manualExecutor: t("manualExecutor"),
          deleteTask: t("deleteTask"),
          deleteBlock: t("deleteBlock"),
          deleteTaskConfirm: t("deleteTaskConfirm"),
          deleteBlockConfirm: t("deleteBlockConfirm")
        },
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
    loadProject: loadProjectWithSelectionReset,
    nodes,
    refreshGraph,
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
    loadProject: loadProjectWithSelectionReset,
    selectedProject,
    setDirtyPromptRefs,
    setError,
    setFileSyncDiagnostics,
    setLastFileChange
  });

  const { visibleTaskIds, visibleTasks } = useVisibleGraphTasks(graph, searchQuery, selectedTaskPanelId);
  const latestBlockRun = blockRunRecords[0];
  const latestReviewAttempt = blockReviewAttempts[0];
  const latestFeedbackRecord = blockFeedbackRecords[0];
  const notificationItems = buildNotificationItems({
    autoRunState,
    dirtyPromptRefs,
    fileSyncDiagnostics,
    graph,
    lastFileChange,
    settings,
    t
  });

  if (activeView === "settings") {
    return (
      <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground">
        <WindowTitleBar t={t} />
        <SettingsView
          graph={graph}
          language={language}
          setActiveView={setActiveView}
          settings={settings}
          t={t}
          updateSettings={updateSettings}
        />
      </div>
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
          handleRevealProject={handleRevealProject}
          handleTaskPanelSelect={handleTaskPanelSelect}
          loadProject={loadProjectWithSelectionReset}
          notificationItems={notificationItems}
          onToggleSidebar={() => setLeftSidebarCollapsed((current) => !current)}
          projects={projects}
          resetLayout={resetLayout}
          selectedProject={selectedProject}
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
        {rightSidebarCollapsed ? null : (
          <aside className="flex w-[300px] shrink-0 flex-col overflow-hidden border-l bg-background">
            <div className="app-drag-region flex h-11 shrink-0 items-center justify-end border-b px-2">
              <Button className="app-no-drag" size="icon-sm" variant="ghost" aria-label={t("collapseSidebar")} onClick={() => setRightSidebarCollapsed(true)}>
                <PanelRightCloseIcon data-icon="inline-start" />
              </Button>
            </div>
            <ComponentPalette addPaletteComponent={addPaletteComponent} handlePaletteDragStart={handlePaletteDragStart} settings={settings} t={t} />
          </aside>
        )}
        {blockInspectorOpen || selectedRunRecord ? (
          <BlockInspector
            blockFeedbackRecords={blockFeedbackRecords}
            blockReviewAttempts={blockReviewAttempts}
            blockRunRecords={blockRunRecords}
            dragHandlers={blockInspectorDragHandlers}
            error={null}
            graph={graph}
            handleOpenRunRecord={handleOpenRunRecord}
            onClose={closeBlockInspector}
            saveSelectedBlockExecutor={saveSelectedBlockExecutor}
            saveSelectedBlockPrompt={saveSelectedBlockPrompt}
            saveSelectedBlockTitle={saveSelectedBlockTitle}
            selectedBlock={selectedBlock}
            selectedRunRecord={selectedRunRecord}
            resizeHandlers={blockInspectorResizeHandlers}
            setSelectedBlock={setSelectedBlock}
            setSelectedRunRecord={setSelectedRunRecord}
            style={blockInspectorStyle}
            t={t}
          />
        ) : null}
      </main>
      {leftSidebarCollapsed ? (
        <div className="app-drag-region absolute left-0 top-0 z-20 flex h-11 w-[280px] items-center border-b bg-background px-3 pl-[124px]">
          <div className="app-no-drag flex items-center gap-1">
            <Button size="icon-sm" variant="ghost" aria-label={t("expandSidebar")} onClick={() => setLeftSidebarCollapsed(false)}>
              <PanelLeftOpenIcon data-icon="inline-start" />
            </Button>
            <HistoryNavigationButtons t={t} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
