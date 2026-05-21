import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("desktop renderer workflow wiring", () => {
  it("keeps the Electron smoke on real renderer interactions without test-only IPC", async () => {
    const mainSource = await readFile(resolve(sourceDir, "main", "main.ts"), "utf8");

    expect(mainSource).toContain("async function runRendererManualSmoke");
    expect(mainSource).toContain('await clickByText("新任务")');
    expect(mainSource).toContain('await clickByText("生成 Draft")');
    expect(mainSource).toContain('await clickByText("确认写入")');
    expect(mainSource).toContain('await clickByText("统计")');
    expect(mainSource).toContain('await clickByText("搜索")');
    expect(mainSource).toContain('await clickByLabel("设置")');
    expect(mainSource).toContain('await clickByText("UI Smoke Task")');
    expect(mainSource).toContain('await waitForSelector("[data-auto-run-control]", "Floating Auto Run control")');
    expect(mainSource).toContain('await clickByLabel("Auto Run")');
    expect(mainSource).toContain('await clickByText("Todo")');
    expect(mainSource).toContain('await clickByText("添加 Review Step")');
    expect(mainSource).toContain('await clickByText("保存 Review Pipeline")');
    expect(mainSource).toContain('await waitForText("组件设置")');
    expect(mainSource).not.toContain("planweave:rendererSmoke");
    expect(mainSource).toContain('app.setPath("userData", process.env.PLANWEAVE_DESKTOP_SMOKE_USER_DATA_DIR)');
  });

  it("expands the selected project into task panels without adding bridge APIs", async () => {
    const appSource = await readFile(resolve(sourceDir, "renderer", "App.tsx"), "utf8");

    expect(appSource).toContain("setExpandedProjectId(project.projectId)");
    expect(appSource).toContain("graph.tasks.map((task)");
    expect(appSource).toContain("handleTaskPanelSelect(task.taskId)");
    expect(appSource).not.toContain("window.planweave.getTaskPanels");
  });

  it("routes todo and search selections back to the graph canvas", async () => {
    const appSource = await readFile(resolve(sourceDir, "renderer", "App.tsx"), "utf8");

    expect(appSource).toContain('setActiveView("graph")');
    expect(appSource).toContain("setSelectedTaskPanelId(block.taskId)");
    expect(appSource).toContain("setSelectedTaskPanelId(target.ref)");
    expect(appSource).toContain("function searchNavigationTarget");
    expect(appSource).toContain('target.kind === "context"');
    expect(appSource).toContain("setSelectedContextNodeId(target.ref)");
    expect(appSource).toContain("onSelect={(ref) => void handleBlockSelect(ref)}");
    expect(appSource).toContain('"implemented"].includes(status)');
    expect(appSource).not.toContain('"completed"].includes(status)');
  });

  it("keeps the graph toolbar compact without duplicate search or project header", async () => {
    const appSource = await readFile(resolve(sourceDir, "renderer", "App.tsx"), "utf8");

    expect(appSource).not.toContain("<header className=");
    expect(appSource).not.toContain('<TabsTrigger value="search">');
    expect(appSource).not.toContain('placeholder={t("searchPlaceholder")}');
    expect(appSource).toContain('value="search"');
    expect(appSource).toContain('onClick={() => void refreshPackageFiles()}');
    expect(appSource).toContain("onClick={resetLayout}");
  });

  it("keeps the mini run panel user-opened instead of a fixed log panel", async () => {
    const appSource = await readFile(resolve(sourceDir, "renderer", "App.tsx"), "utf8");

    expect(appSource).toContain("miniRunPanelOpen");
    expect(appSource).toContain("setMiniRunPanelOpen(true)");
    expect(appSource).toContain("<PopoverContent align=\"end\" className=\"w-96\">");
    expect(appSource).toContain("formatElapsed(autoRunState.elapsedMs)");
    expect(appSource).toContain("autoRunState?.currentExecutor");
    expect(appSource).toContain('t("currentBlock")');
    expect(appSource).toContain('t("stepCount")');
  });

  it("keeps the Floating Auto Run control draggable in renderer state", async () => {
    const appSource = await readFile(resolve(sourceDir, "renderer", "App.tsx"), "utf8");

    expect(appSource).toContain("autoRunControlPosition");
    expect(appSource).toContain("data-auto-run-control");
    expect(appSource).toContain("data-graph-surface");
    expect(appSource).toContain("setPointerCapture(event.pointerId)");
    expect(appSource).toContain("onPointerMove={moveAutoRunControl}");
    expect(appSource).not.toContain("planweave:saveAutoRunControl");
  });

  it("supports right-click or long-press Auto Run scope selection", async () => {
    const appSource = await readFile(resolve(sourceDir, "renderer", "App.tsx"), "utf8");

    expect(appSource).toContain("ContextMenuTrigger asChild");
    expect(appSource).toContain("<ContextMenuRadioGroup value={autoRunScopeMode}");
    expect(appSource).toContain('<ContextMenuRadioItem value="project">');
    expect(appSource).toContain('<ContextMenuRadioItem disabled={!selectedTaskPanelId && !selectedBlock} value="selectedTask">');
    expect(appSource).toContain('<ContextMenuRadioItem disabled={!selectedBlock} value="selectedBlock">');
  });

  it("supports dragging palette components onto the graph without widening IPC", async () => {
    const appSource = await readFile(resolve(sourceDir, "renderer", "App.tsx"), "utf8");

    expect(appSource).toContain("handlePaletteDragStart");
    expect(appSource).toContain("<PaletteSettingsPanel");
    expect(appSource).toContain('value="settings"');
    expect(appSource).not.toContain('setActiveView("component-settings")');
    expect(appSource).not.toContain('value="component-settings"');
    expect(appSource).toContain('event.dataTransfer.setData("application/x-planweave-palette", type)');
    expect(appSource).toContain("onDragOver={handleGraphDragOver}");
    expect(appSource).toContain("onDrop={handleGraphDrop}");
    expect(appSource).toContain("screenToFlowPosition");
    expect(appSource).toContain("onInit={setFlowInstance}");
    expect(appSource).toContain("previousTaskIds");
    expect(appSource).toContain("previousContextIds");
    expect(appSource).toContain("nodeId: createdContext.nodeId");
    expect(appSource).toContain("bridge.saveDesktopLayout(selectedProject.rootPath, nextLayout)");
    expect(appSource).toContain('void addPaletteComponent(type, type === "task" || type === "context" ? dropPosition : undefined)');
    expect(appSource).not.toContain("dragPaletteComponent(");
  });

  it("loads lightweight block execution records when a block is selected", async () => {
    const appSource = await readFile(resolve(sourceDir, "renderer", "App.tsx"), "utf8");

    expect(appSource).toContain("bridge.listBlockRunRecords(selectedProject.rootPath, ref)");
    expect(appSource).toContain("bridge.getReviewAttempts(selectedProject.rootPath, ref)");
    expect(appSource).toContain("bridge.getFeedbackRecords(selectedProject.rootPath, ref)");
    expect(appSource).toContain("blockExecutionSummary");
    expect(appSource).toContain("latestFeedbackRecord");
  });

  it("edits block details from a cursor-near block preview popover", async () => {
    const appSource = await readFile(resolve(sourceDir, "renderer", "App.tsx"), "utf8");

    expect(appSource).toContain("function BlockPreviewButton");
    expect(appSource).toContain("<PopoverTrigger asChild>");
    expect(appSource).toContain('<PopoverContent align="start" className="w-[420px]">');
    expect(appSource).toContain("onBlockTitleSave");
    expect(appSource).toContain("onBlockExecutorChange");
    expect(appSource).toContain("onBlockPromptSave");
  });

  it("edits full task source prompts and autosaves dirty prompt drafts", async () => {
    const appSource = await readFile(resolve(sourceDir, "renderer", "App.tsx"), "utf8");

    expect(appSource).toContain("[task.taskId, task.promptMarkdown]");
    expect(appSource).toContain("draft !== task.promptMarkdown");
    expect(appSource).toContain("window.setTimeout(() =>");
    expect(appSource).toContain("void handlePromptSave(taskId)");
    expect(appSource).not.toContain("[task.taskId, task.promptPreview]");
  });
});
