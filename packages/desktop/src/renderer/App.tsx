import { useCallback, useEffect, useMemo, useState } from "react";
import type * as React from "react";
import { type Edge, type ReactFlowInstance, useEdgesState, useNodesState } from "@xyflow/react";
import type { DesktopPackageFileChangeEvent } from "@planweave/runtime";
import { bridge } from "./bridge";
import { ComponentPalette } from "./palette/ComponentPalette";
import { BlockInspector } from "./inspector/BlockInspector";
import { nodeTypes, graphEdges, graphNodes } from "./graph/flowModel";
import { createTranslator } from "./i18n";
import { ProjectSidebar } from "./sidebar/ProjectSidebar";
import { buildNotificationItems } from "./notifications";
import { desktopSettingsKey, loadDesktopSettings } from "./settings";
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
import { usePromptDrafts } from "./hooks/usePromptDrafts";

export function App() {
  const [settings, setSettings] = useState<DesktopUiSettings>(() => loadDesktopSettings());
  const language = settings.language;
  const t = useMemo(() => createTranslator(language), [language]);
  const [activeView, setActiveView] = useState<AppView>("graph");
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
    setSettings((current) => ({
      ...current,
      ...patch,
      notifications: {
        ...current.notifications,
        ...patch.notifications
      },
      palette: {
        ...current.palette,
        ...patch.palette,
        visible: {
          ...current.palette.visible,
          ...patch.palette?.visible
        }
      }
    }));
  }, []);

  useEffect(() => {
    window.localStorage.setItem(desktopSettingsKey, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("dark");
    const prefersDark =
      settings.appearance === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (settings.appearance === "dark" || prefersDark) {
      root.classList.add("dark");
    }
  }, [settings.appearance]);

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
    handleBlockSelect,
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
          manualExecutor: t("manualExecutor")
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
        handleBlockSelect,
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
    handleBlockSelect,
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

  const visibleTasks = graph?.tasks.filter((task) => {
    const query = searchQuery.trim().toLowerCase();
    const matchesQuery = !query || task.title.toLowerCase().includes(query) || task.taskId.toLowerCase().includes(query);
    const matchesPanel = !selectedTaskPanelId || task.taskId === selectedTaskPanelId;
    return matchesQuery && matchesPanel;
  });
  const visibleTaskIds = new Set(visibleTasks?.map((task) => task.taskId) ?? []);
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

  return (
    <main className="flex h-screen min-h-0 bg-background text-foreground">
      <ProjectSidebar
        activeView={activeView}
        expandedProjectId={expandedProjectId}
        graph={graph}
        handleOpenProject={handleOpenProject}
        handleTaskPanelSelect={handleTaskPanelSelect}
        language={language}
        loadProject={loadProjectWithSelectionReset}
        notificationItems={notificationItems}
        projectPath={projectPath}
        projects={projects}
        selectedProject={selectedProject}
        selectedTaskPanelId={selectedTaskPanelId}
        setActiveView={setActiveView}
        setProjectPath={setProjectPath}
        t={t}
        updateSettings={updateSettings}
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
        resetLayout={resetLayout}
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
      <aside className="flex w-[300px] shrink-0 flex-col border-l bg-background">
        <ComponentPalette addPaletteComponent={addPaletteComponent} handlePaletteDragStart={handlePaletteDragStart} settings={settings} t={t} />
        <BlockInspector
          blockFeedbackRecords={blockFeedbackRecords}
          blockReviewAttempts={blockReviewAttempts}
          blockRunRecords={blockRunRecords}
          error={error}
          graph={graph}
          handleOpenRunRecord={handleOpenRunRecord}
          saveSelectedBlockExecutor={saveSelectedBlockExecutor}
          saveSelectedBlockPrompt={saveSelectedBlockPrompt}
          saveSelectedBlockTitle={saveSelectedBlockTitle}
          selectedBlock={selectedBlock}
          selectedRunRecord={selectedRunRecord}
          setSelectedBlock={setSelectedBlock}
          setSelectedRunRecord={setSelectedRunRecord}
          t={t}
        />
      </aside>
    </main>
  );
}
