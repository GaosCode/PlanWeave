import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("desktop renderer workflow wiring", () => {
  it("keeps the Electron smoke on real renderer interactions without test-only IPC", async () => {
    const [mainSource, smokeSource] = await Promise.all([
      readFile(resolve(sourceDir, "main", "main.ts"), "utf8"),
      readFile(resolve(sourceDir, "main", "smoke.ts"), "utf8")
    ]);

    expect(smokeSource).toContain("async function runRendererManualSmoke");
    expect(smokeSource).toContain("const clickByTestId = async");
    expect(smokeSource).toContain('await clickByTestId("sidebar-new-task")');
    expect(smokeSource).toContain('await clickByTestId("new-task-generate-draft")');
    expect(smokeSource).toContain('await clickByTestId("new-task-confirm-write")');
    expect(smokeSource).toContain('await clickByTestId("sidebar-statistics")');
    expect(smokeSource).toContain('await clickByTestId("sidebar-search")');
    expect(smokeSource).toContain('await clickByTestId("sidebar-settings")');
    expect(smokeSource).toContain('await clickByTestId("settings-nav-components")');
    expect(smokeSource).toContain('await clickByTestId("settings-nav-review")');
    expect(smokeSource).toContain('await clickByTestId("settings-nav-agents")');
    expect(smokeSource).toContain('await clickByTestId("settings-back-to-app")');
    expect(smokeSource).toContain('await waitForSelector("[data-auto-run-control]", "Floating Auto Run control")');
    expect(smokeSource).toContain('await clickByLabel("Auto Run")');
    expect(smokeSource).toContain('await clickByTestId("sidebar-todo")');
    expect(smokeSource).toContain('await waitForSelector(\'[data-testid="settings-section-components"]\', "component settings section")');
    expect(smokeSource).toContain('await waitForSelector(\'[data-testid="settings-section-review"]\', "review settings section")');
    expect(smokeSource).toContain('await waitForSelector(\'[data-testid="settings-section-agents"]\', "agent settings section")');
    expect(smokeSource).not.toContain('await clickByText("新建任务画布")');
    expect(smokeSource).not.toContain('await clickByText("生成 Draft")');
    expect(smokeSource).not.toContain('await clickByText("确认写入")');
    expect(smokeSource).not.toContain('await clickByText("统计")');
    expect(smokeSource).not.toContain('await clickByText("搜索")');
    expect(smokeSource).not.toContain('await clickByText("设置")');
    expect(smokeSource).not.toContain('await clickByText("组件")');
    expect(smokeSource).not.toContain('await clickByText("审查")');
    expect(smokeSource).not.toContain('await clickByText("Agent")');
    expect(smokeSource).not.toContain('await clickByText("Todo")');
    expect(smokeSource).not.toContain("planweave:rendererSmoke");
    expect(mainSource).toContain('app.setPath("userData", process.env.PLANWEAVE_DESKTOP_SMOKE_USER_DATA_DIR)');
  });

  it("expands the selected project into a task canvas and task rows", async () => {
    const [sidebarSource, taskNodeSource] = await Promise.all([
      readFile(resolve(sourceDir, "renderer", "sidebar", "ProjectSidebar.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "graph", "TaskNodeCard.tsx"), "utf8")
    ]);

    expect(sidebarSource).toContain("graph.tasks.map((task)");
    expect(sidebarSource).toContain('t("taskCanvas")');
    expect(sidebarSource).toContain("WorkflowIcon");
    expect(sidebarSource).toContain("ChevronDownIcon");
    expect(sidebarSource).toContain("ChevronRightIcon");
    expect(sidebarSource).toContain("collapsedProjectIds");
    expect(sidebarSource).toContain("collapsedCanvasIds");
    expect(sidebarSource).toContain("expandProject(project.projectId)");
    expect(sidebarSource).toContain("expandCanvas(canvas.canvasId)");
    expect(sidebarSource).toContain('t("collapseProject")');
    expect(sidebarSource).toContain('t("collapseTaskCanvas")');
    expect(sidebarSource).toContain('className="flex min-w-0 flex-col gap-1"');
    expect(sidebarSource).toContain('className="group/project grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center gap-1"');
    expect(sidebarSource).toContain('className="relative z-10 size-7 shrink-0 border-0 bg-transparent text-muted-foreground shadow-none opacity-100 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"');
    expect(sidebarSource).toContain('className="group/canvas grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center gap-1"');
    expect(sidebarSource).toContain('className="relative z-10 h-8 w-7 shrink-0 border-0 bg-transparent text-muted-foreground shadow-none opacity-100 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"');
    expect(sidebarSource).not.toContain("border-2 border-border");
    expect(sidebarSource).not.toContain('aria-hidden="true"');
    expect(sidebarSource).toContain("selectedCanvasId === null && isSelectedProject && project.taskCanvases.length === 1");
    expect(sidebarSource).toContain("py-2 text-left");
    expect(sidebarSource).toContain("overflow-hidden px-2 text-xs");
    expect(sidebarSource).toContain("h-8 w-full min-w-0 justify-start");
    expect(sidebarSource).toContain("handleTaskPanelSelect(null)");
    expect(sidebarSource).toContain("handleTaskPanelSelect(task.taskId)");
    expect(sidebarSource).toContain("handleDeleteTaskCanvas(project, canvas.canvasId)");
    expect(sidebarSource).toContain("handleDeleteTaskNode(task.taskId)");
    expect(sidebarSource).toContain("handleDeleteProject(project)");
    expect(sidebarSource).not.toContain("task.blocks.map((block)");
    expect(sidebarSource).not.toContain("handleBlockSelect(block.ref)");
    expect(taskNodeSource).toContain("task.blocks.map((block)");
    expect(taskNodeSource).not.toContain("task.blockPreview.map((block)");
    expect(sidebarSource).not.toContain("window.planweave.getTaskPanels");
  });

  it("routes todo and search selections back to the graph canvas", async () => {
    const [searchHookSource, searchListSource, todoSource] = await Promise.all([
      readFile(resolve(sourceDir, "renderer", "hooks", "useDesktopSearch.ts"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "components", "SearchResultList.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "views", "TodoView.tsx"), "utf8")
    ]);

    expect(searchHookSource).toContain('setActiveView("graph")');
    expect(searchHookSource).toContain("setSelectedTaskPanelId(target.ref)");
    expect(searchListSource).toContain("function searchNavigationTarget");
    expect(searchHookSource).toContain('target.kind === "context"');
    expect(searchHookSource).toContain("setSelectedContextNodeId(target.ref)");
    expect(todoSource).toContain("onSelect={(item) => void handleBlockSelect(item.ref, item.canvasId)}");
    expect(todoSource).toContain('"implemented"].includes(status)');
    expect(todoSource).not.toContain('"completed"].includes(status)');
  });

  it("keeps task selection from filtering other canvas tasks out of the graph", async () => {
    const [visibleTasksHookSource, graphViewSource] = await Promise.all([
      readFile(resolve(sourceDir, "renderer", "hooks", "useVisibleGraphTasks.ts"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "views", "GraphView.tsx"), "utf8")
    ]);

    expect(visibleTasksHookSource).toContain("searchQuery.trim().toLowerCase()");
    expect(visibleTasksHookSource).not.toContain("task.taskId === selectedTaskPanelId");
    expect(visibleTasksHookSource).not.toContain("matchesPanel");
    expect(graphViewSource).toContain('node.type !== "task" || visibleTaskIds.has(node.id)');
    expect(graphViewSource).toContain("visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)");
    expect(graphViewSource).not.toContain("visibleTaskIds.has(edge.source) && visibleTaskIds.has(edge.target)");
  });

  it("keeps workspace navigation in the sidebar instead of the graph toolbar", async () => {
    const [workspaceSource, sidebarSource, projectHookSource, runControlSource] = await Promise.all([
      readFile(resolve(sourceDir, "renderer", "views", "WorkspaceTabs.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "sidebar", "ProjectSidebar.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "hooks", "useDesktopProject.ts"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "run", "FloatingAutoRunControl.tsx"), "utf8")
    ]);

    expect(workspaceSource).not.toContain("<header className=");
    expect(workspaceSource).not.toContain("<TabsList");
    expect(workspaceSource).not.toContain('<TabsTrigger value="graph">');
    expect(workspaceSource).not.toContain('<TabsTrigger value="review-pipeline">');
    expect(workspaceSource).not.toContain('<TabsTrigger value="todo">');
    expect(workspaceSource).not.toContain('<TabsTrigger value="statistics">');
    expect(workspaceSource).not.toContain('<TabsTrigger value="search">');
    expect(workspaceSource).not.toContain('placeholder={t("searchPlaceholder")}');
    expect(workspaceSource).toContain('case "search"');
    expect(workspaceSource).not.toContain('onClick={() => void refreshPackageFiles()}');
    expect(runControlSource).toContain('onClick={() => void refreshPackageFiles()}');
    expect(runControlSource).toContain('aria-label={t("syncFiles")}');
    expect(sidebarSource).toContain('variant={activeView === "todo" ? "secondary" : "ghost"}');
    expect(sidebarSource).toContain('variant={activeView === "settings" ? "secondary" : "ghost"}');
    expect(sidebarSource).toContain("void resetLayout()");
    expect(sidebarSource).toContain('t("chooseProjectFolder")');
    expect(projectHookSource).toContain("bridge.chooseProjectFolder()");
    expect(projectHookSource).toContain("if (!selectedPath)");
    expect(projectHookSource).toContain("bridge.initOrOpenProject(selectedPath)");
    expect(projectHookSource).not.toContain("projectPath.trim()");
    expect(sidebarSource).toContain("selectedTaskPanelId === task.taskId");
    expect(sidebarSource).toContain("void handleProjectNewGraph(project)");
    expect(sidebarSource).toContain("void handleRevealProject(project)");
    expect(sidebarSource).toContain("onTogglePinnedProject(project.projectId)");
    expect(sidebarSource).toContain('isPinnedProject ? t("unpinProject") : t("pinProject")');
    expect(sidebarSource).not.toContain('t("createPermanentWorktree")');
    expect(sidebarSource).not.toContain("DropdownMenuTrigger asChild");
    expect(sidebarSource).not.toContain('aria-label={t("projectMore")}');
    expect(sidebarSource).not.toContain("<Select");
    expect(sidebarSource).not.toContain("LanguagesIcon");
    expect(sidebarSource).not.toContain('aria-label={t("projectPath")}');
  });

  it("opens settings as a full-page surface with focused settings sections", async () => {
    const [appSource, settingsSource, workspaceSource, detectedAgentsHookSource, agentPanelSource] = await Promise.all([
      readFile(resolve(sourceDir, "renderer", "App.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "views", "SettingsView.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "views", "WorkspaceTabs.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "hooks", "useDetectedAgents.ts"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "components", "AgentSettingsPanel.tsx"), "utf8")
    ]);

    expect(appSource).toContain('if (activeView === "settings")');
    expect(settingsSource).toContain('type SettingsSection = "general" | "components" | "review" | "agents"');
    expect(settingsSource).toContain('t("backToApp")');
    expect(settingsSource).toContain('t("settingsGeneral")');
    expect(settingsSource).toContain('t("settingsComponents")');
    expect(settingsSource).toContain('t("settingsReview")');
    expect(settingsSource).toContain('t("settingsAgents")');
    expect(settingsSource).toContain("<Select");
    expect(settingsSource).toContain('aria-label={t("language")}');
    expect(settingsSource).toContain("<SettingsSwitchRow");
    expect(settingsSource).toContain("<AgentSettingsPanel");
    expect(appSource).toContain("useDetectedAgents()");
    expect(appSource).toContain("refreshAgentDetections={refreshAgentDetections}");
    expect(detectedAgentsHookSource).toContain("bridge.detectAgentTools()");
    expect(detectedAgentsHookSource).toContain("refreshAgentDetections");
    expect(detectedAgentsHookSource).toContain("agentDetectionRefreshing");
    expect(settingsSource).toContain("refreshAgentDetections={refreshAgentDetections}");
    expect(agentPanelSource).toContain("RefreshCwIcon");
    expect(agentPanelSource).toContain("onClick={() => void refreshAgentDetections()}");
    expect(settingsSource).not.toContain("<ReviewPipelineView");
    expect(workspaceSource).not.toContain("SettingsView");
  });

  it("keeps the mini run panel user-opened instead of a fixed log panel", async () => {
    const runControlSource = await readFile(resolve(sourceDir, "renderer", "run", "FloatingAutoRunControl.tsx"), "utf8");

    expect(runControlSource).toContain("miniRunPanelOpen");
    expect(runControlSource).toContain("setMiniRunPanelOpen(true)");
    expect(runControlSource).toContain("<PopoverContent align=\"end\" className=\"w-96\">");
    expect(runControlSource).toContain("formatElapsed(autoRunState.elapsedMs)");
    expect(runControlSource).toContain("autoRunState?.currentExecutor");
    expect(runControlSource).toContain('t("currentBlock")');
    expect(runControlSource).toContain('t("stepCount")');
  });

  it("keeps the Floating Auto Run control draggable in renderer state", async () => {
    const [runHookSource, runControlSource, graphViewSource] = await Promise.all([
      readFile(resolve(sourceDir, "renderer", "hooks", "useAutoRunControl.ts"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "run", "FloatingAutoRunControl.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "views", "GraphView.tsx"), "utf8")
    ]);

    expect(runHookSource).toContain("autoRunControlPosition");
    expect(runControlSource).toContain("data-auto-run-control");
    expect(graphViewSource).toContain("data-graph-surface");
    expect(runHookSource).toContain("setPointerCapture(event.pointerId)");
    expect(runControlSource).toContain("onPointerMove={moveAutoRunControl}");
    expect(runHookSource).not.toContain("planweave:saveAutoRunControl");
  });

  it("themes ReactFlow built-in controls for dark mode", async () => {
    const cssSource = await readFile(resolve(sourceDir, "renderer", "index.css"), "utf8");

    expect(cssSource).toContain(".dark .react-flow__controls");
    expect(cssSource).toContain(".dark .react-flow__controls-button");
    expect(cssSource).toContain(".dark .react-flow__controls-button svg");
    expect(cssSource).toContain(".dark .react-flow__minimap");
  });

  it("supports right-click or long-press Auto Run scope selection", async () => {
    const runControlSource = await readFile(resolve(sourceDir, "renderer", "run", "FloatingAutoRunControl.tsx"), "utf8");

    expect(runControlSource).toContain("ContextMenuTrigger asChild");
    expect(runControlSource).toContain("<ContextMenuRadioGroup value={autoRunScopeMode}");
    expect(runControlSource).toContain('<ContextMenuRadioItem value="project">');
    expect(runControlSource).toContain('<ContextMenuRadioItem disabled={!selectedTaskPanelId && !selectedBlockPresent} value="selectedTask">');
    expect(runControlSource).toContain('<ContextMenuRadioItem disabled={!selectedBlockPresent} value="selectedBlock">');
  });

  it("supports dragging palette components onto the graph without widening IPC", async () => {
    const [appSource, graphViewSource, paletteSource, paletteHookSource, settingsSource] = await Promise.all([
      readFile(resolve(sourceDir, "renderer", "App.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "views", "GraphView.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "palette", "ComponentPalette.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "hooks", "useGraphPaletteActions.ts"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "views", "SettingsView.tsx"), "utf8")
    ]);

    expect(paletteSource).toContain("handlePaletteDragStart");
    expect(paletteSource).toContain('t("nodeComponents")');
    expect(paletteSource).toContain('t("blockComponents")');
    expect(appSource).toContain("PanelRightCloseIcon");
    expect(appSource).not.toContain("PanelRightOpenIcon");
    expect(appSource).toContain("setRightSidebarCollapsed(true)");
    expect(appSource).toContain("setRightSidebarCollapsed(false)");
    expect(appSource).toContain("{rightSidebarCollapsed ? null : (");
    expect(appSource).toContain('className="app-drag-region absolute right-0 top-0 z-30 flex h-11 w-11 items-center justify-center border-b bg-background"');
    expect(appSource).not.toContain('className="flex w-11 shrink-0 flex-col overflow-hidden border-l bg-background"');
    expect(graphViewSource).toContain("onInit={setFlowInstance}");
    expect(settingsSource).toContain("<SettingsSwitchRow");
    expect(appSource).not.toContain('setActiveView("component-settings")');
    expect(appSource).not.toContain('value="component-settings"');
    expect(paletteHookSource).toContain('event.dataTransfer.setData("application/x-planweave-palette", type)');
    expect(graphViewSource).toContain("onDragOver={handleGraphDragOver}");
    expect(graphViewSource).toContain("onDrop={handleGraphDrop}");
    expect(paletteHookSource).toContain("screenToFlowPosition");
    expect(paletteHookSource).toContain("previousTaskIds");
    expect(paletteHookSource).toContain("previousContextIds");
    expect(paletteHookSource).toContain("nodeId: createdContext.nodeId");
    expect(paletteHookSource).toContain("bridge.saveDesktopLayout(selectedProject.rootPath, selectedCanvasId, nextLayout)");
    expect(paletteHookSource).toContain('void addPaletteComponent(type, type === "task" || type === "context" ? dropPosition : undefined)');
    expect(paletteHookSource).not.toContain("dragPaletteComponent(");
  });

  it("loads lightweight block execution records when a block is selected", async () => {
    const [blockHookSource, previewSource, inspectorSource, connectionsSource] = await Promise.all([
      readFile(resolve(sourceDir, "renderer", "hooks", "useSelectedBlock.ts"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "graph", "BlockPreviewButton.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "inspector", "BlockInspector.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "inspector", "BlockConnectionsCard.tsx"), "utf8")
    ]);

    expect(blockHookSource).toContain("bridge.listBlockRunRecords(selectedProject.rootPath, canvasId, ref)");
    expect(blockHookSource).toContain("bridge.getReviewAttempts(selectedProject.rootPath, canvasId, ref)");
    expect(blockHookSource).toContain("bridge.getFeedbackRecords(selectedProject.rootPath, canvasId, ref)");
    expect(previewSource).toContain("ContextMenuTrigger asChild");
    expect(previewSource).toContain("labels.deleteBlock");
    expect(connectionsSource).toContain("Block 连接");
    expect(connectionsSource).toContain("onBlockSelect(block.ref)");
    expect(inspectorSource).not.toContain("resizeHandlers");
    expect(inspectorSource).not.toContain("ZoomInIcon");
  });

  it("edits block details from a native block inspector window", async () => {
    const [previewSource, appSource, windowSource, mainWindowSource, deleteHookSource, taskNodeSource] = await Promise.all([
      readFile(resolve(sourceDir, "renderer", "graph", "BlockPreviewButton.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "App.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "BlockInspectorWindow.tsx"), "utf8"),
      readFile(resolve(sourceDir, "main", "blockInspectorWindow.ts"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "hooks", "useGraphDeleteActions.ts"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "graph", "TaskNodeCard.tsx"), "utf8")
    ]);

    expect(previewSource).toContain("function BlockPreviewButton");
    expect(previewSource).toContain("onSelect(block.ref)");
    expect(previewSource).not.toContain("<PopoverTrigger asChild>");
    expect(appSource).toContain("handleOpenBlockInspector");
    expect(appSource).toContain("bridge.openBlockInspectorWindow");
    expect(appSource).not.toContain("<BlockInspector");
    expect(windowSource).toContain("<BlockInspector");
    expect(mainWindowSource).toContain("new BrowserWindow");
    expect(mainWindowSource).toContain('window: "block-inspector"');
    expect(deleteHookSource).toContain("bridge.removeTaskNode");
    expect(deleteHookSource).toContain("bridge.removeBlock");
    expect(taskNodeSource).toContain("labels.deleteTask");
    expect(taskNodeSource).toContain("onTaskDelete(task.taskId)");
  });

  it("edits full task source prompts and autosaves dirty prompt drafts", async () => {
    const promptDraftSource = await readFile(resolve(sourceDir, "renderer", "hooks", "usePromptDrafts.ts"), "utf8");

    expect(promptDraftSource).toContain("[task.taskId, task.promptMarkdown]");
    expect(promptDraftSource).toContain("draft !== task.promptMarkdown");
    expect(promptDraftSource).toContain("window.setTimeout(() =>");
    expect(promptDraftSource).toContain("void handlePromptSave(taskId)");
    expect(promptDraftSource).not.toContain("[task.taskId, task.promptPreview]");
  });

  it("keeps desktop project loading and file watching inside the project hook", async () => {
    const [appSource, projectHookSource] = await Promise.all([
      readFile(resolve(sourceDir, "renderer", "App.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "hooks", "useDesktopProject.ts"), "utf8")
    ]);

    expect(appSource).toContain("useDesktopProject({");
    expect(projectHookSource).toContain(".listProjects()");
    expect(projectHookSource).toContain("bridge.getGraphViewModel(project.rootPath, canvasId)");
    expect(projectHookSource).toContain("bridge.getDesktopLayout(project.rootPath, canvasId)");
    expect(projectHookSource).toContain("bridge.getTodoGroups(project.rootPath)");
    expect(projectHookSource).toContain("bridge.getStatistics(project.rootPath)");
    expect(projectHookSource).toContain("bridge.watchPackageFiles(project.rootPath, canvasId)");
    expect(projectHookSource).toContain("bridge.unwatchPackageFiles(projectRoot, canvasId)");
  });
});
