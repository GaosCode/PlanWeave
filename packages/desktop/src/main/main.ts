import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { existsSync, watch, type FSWatcher } from "node:fs";
import type { Event as ElectronEvent, WebContents, WebContentsConsoleMessageEventParams } from "electron";
import {
  addBlock,
  addContextNode,
  addDependencyEdge,
  addTaskNode,
  createDesktopPackageFileSnapshot,
  createTaskDraft,
  detectDesktopPackageFileChanges,
  getBlockDetail,
  getDesktopLayout,
  getDirtyPromptRefs,
  getFeedbackRecords,
  getGraphViewModel,
  getProjectOverview,
  getReviewAttempts,
  getReviewPipeline,
  getRunRecord,
  getStatistics,
  getTaskDetail,
  getTaskExecutionOrder,
  getTodoGroups,
  getAutoRunState,
  getLatestAutoRunSummary,
  initOrOpenProject,
  listProjects,
  listBlockRunRecords,
  openProject,
  pauseAutoRun,
  refreshChangedDesktopPackagePrompts,
  refreshPackageFileChanges,
  removeBlock,
  removeDependencyEdge,
  removeTaskNode,
  resumeAutoRun,
  resetDesktopLayout,
  resolveProjectWorkspace,
  saveDesktopLayout,
  searchProject,
  startAutoRun,
  stopAutoRun,
  updateBlockExecutor,
  updateBlockPrompt,
  updateBlockTitle,
  updateTaskExecutor,
  updateTaskPrompt,
  updateTaskTitle,
  updateReviewPipeline,
  validateGraphEdit
} from "@planweave/runtime";
import type { DesktopGraphEditResult, DesktopLayout, GraphEditResult } from "@planweave/runtime";
import type { DesktopAutoRunScope } from "@planweave/runtime";
import type { DesktopPackageFileChangeEvent } from "@planweave/runtime";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = process.env.PLANWEAVE_DESKTOP_DEV_SERVER_URL !== undefined;
const isSmoke = process.env.PLANWEAVE_DESKTOP_SMOKE === "1";
const packageFileChangedChannel = "planweave:packageFileChanged";

if (isSmoke && process.env.PLANWEAVE_DESKTOP_SMOKE_USER_DATA_DIR) {
  app.setPath("userData", process.env.PLANWEAVE_DESKTOP_SMOKE_USER_DATA_DIR);
}

type PackageWatch = {
  watchers: FSWatcher[];
  subscribers: Map<number, WebContents>;
  changedPaths: Set<string>;
  timer: NodeJS.Timeout | null;
};

const packageWatches = new Map<string, PackageWatch>();

function cloneableGraphEditResult(result: GraphEditResult): DesktopGraphEditResult {
  const { graph: _graph, ...cloneable } = result;
  return cloneable;
}

async function invokeGraphEdit(promise: Promise<GraphEditResult>): Promise<DesktopGraphEditResult> {
  return cloneableGraphEditResult(await promise);
}

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

function shouldNotifyPackagePath(path: string): boolean {
  return (
    path === "package/manifest.json" ||
    path === "policy/project-prompt.md" ||
    /^package\/nodes\/.+\.md$/.test(path)
  );
}

function watchRoot(projectRoot: string, rootPath: string, recordChange: (path: string) => void): FSWatcher | null {
  if (!existsSync(rootPath)) {
    return null;
  }
  const onChange = (_eventType: string, filename: string | Buffer | null) => {
    if (!filename) {
      recordChange(toPosixPath(relative(projectRoot, rootPath)));
      return;
    }
    recordChange(toPosixPath(relative(projectRoot, join(rootPath, filename.toString()))));
  };
  try {
    return watch(rootPath, { recursive: true }, onChange);
  } catch {
    return watch(rootPath, onChange);
  }
}

function flushPackageFileChange(projectRoot: string): void {
  const activeWatch = packageWatches.get(projectRoot);
  if (!activeWatch) {
    return;
  }
  activeWatch.timer = null;
  const paths = [...activeWatch.changedPaths].filter(shouldNotifyPackagePath);
  activeWatch.changedPaths.clear();
  if (paths.length === 0) {
    return;
  }
  const payload: DesktopPackageFileChangeEvent = {
    projectRoot,
    paths,
    triggeredAt: new Date().toISOString()
  };
  for (const webContents of activeWatch.subscribers.values()) {
    if (!webContents.isDestroyed()) {
      webContents.send(packageFileChangedChannel, payload);
    }
  }
}

async function startPackageWatch(projectRoot: string, webContents: WebContents): Promise<void> {
  let activeWatch = packageWatches.get(projectRoot);
  if (!activeWatch) {
    const workspace = await resolveProjectWorkspace(projectRoot);
    const recordChange = (path: string) => {
      const currentWatch = packageWatches.get(projectRoot);
      if (!currentWatch) {
        return;
      }
      currentWatch.changedPaths.add(path);
      if (currentWatch.timer) {
        clearTimeout(currentWatch.timer);
      }
      currentWatch.timer = setTimeout(() => flushPackageFileChange(projectRoot), 150);
    };
    const watchers = [
      watchRoot(workspace.workspaceRoot, workspace.packageDir, recordChange),
      watchRoot(workspace.workspaceRoot, dirname(workspace.projectPromptFile), recordChange),
      watchRoot(workspace.workspaceRoot, join(workspace.packageDir, "nodes"), recordChange)
    ].filter((item): item is FSWatcher => item !== null);
    if (watchers.length === 0) {
      throw new Error(`No package file watch roots exist under '${workspace.workspaceRoot}'.`);
    }
    activeWatch = {
      watchers,
      subscribers: new Map(),
      changedPaths: new Set(),
      timer: null
    };
    packageWatches.set(projectRoot, activeWatch);
  }
  activeWatch.subscribers.set(webContents.id, webContents);
  webContents.once("destroyed", () => stopPackageWatch(projectRoot, webContents));
}

function stopPackageWatch(projectRoot: string, webContents: WebContents): void {
  const activeWatch = packageWatches.get(projectRoot);
  if (!activeWatch) {
    return;
  }
  activeWatch.subscribers.delete(webContents.id);
  if (activeWatch.subscribers.size > 0) {
    return;
  }
  for (const watcher of activeWatch.watchers) {
    watcher.close();
  }
  if (activeWatch.timer) {
    clearTimeout(activeWatch.timer);
  }
  packageWatches.delete(projectRoot);
}

function rendererEntry(): string {
  return join(__dirname, "..", "renderer", "index.html");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readSmokeState(window: BrowserWindow): Promise<{
  pageText: string;
  bridgeAvailable: boolean;
  nodeRequireAvailable: boolean;
  autoRunControlAvailable: boolean;
}> {
  return window.webContents.executeJavaScript(`
    (() => ({
      pageText: document.body.textContent ?? "",
      bridgeAvailable: typeof window.planweave === "object" && window.planweave !== null,
      nodeRequireAvailable: typeof window.require === "function",
      autoRunControlAvailable: document.querySelector("[data-auto-run-control]") !== null
    }))()
  `) as Promise<{
    pageText: string;
    bridgeAvailable: boolean;
    nodeRequireAvailable: boolean;
    autoRunControlAvailable: boolean;
  }>;
}

async function runSmokeWorkflow(window: BrowserWindow): Promise<Record<string, unknown>> {
  const projectRoot = process.env.PLANWEAVE_DESKTOP_SMOKE_PROJECT_ROOT;
  if (!projectRoot) {
    throw new Error("PLANWEAVE_DESKTOP_SMOKE_PROJECT_ROOT is required for desktop smoke.");
  }
  return window.webContents.executeJavaScript(`
    (async () => {
      const api = window.planweave;
      const projectRoot = ${JSON.stringify(projectRoot)};
      const added = await api.addTaskNode(projectRoot, {
        title: "Smoke task",
        promptMarkdown: "# Smoke task\\n",
        acceptance: ["Smoke task source prompt is editable."],
        blockTypes: ["implementation", "check", "review"],
        executor: "manual"
      });
      if (!added.ok) {
        throw new Error("addTaskNode failed: " + added.diagnostics.map((item) => item.message).join("; "));
      }
      const graph = await api.getGraphViewModel(projectRoot);
      const task = graph.tasks.find((item) => item.title === "Smoke task");
      if (!task || !task.promptMarkdown.includes("# Smoke task")) {
        throw new Error("Smoke task full prompt was not exposed in the graph view model.");
      }
      await api.updateTaskPrompt(projectRoot, task.taskId, "# Smoke task\\n\\nUpdated from smoke.");
      await api.addDependencyEdge(projectRoot, task.taskId, "T-001");
      const savedLayout = await api.saveDesktopLayout(projectRoot, {
        version: "desktop-layout/v1",
        projectId: "ignored",
        nodes: [{ nodeId: task.taskId, x: 111, y: 222 }],
        updatedAt: new Date(0).toISOString()
      });
      if (!savedLayout.nodes.some((node) => node.nodeId === task.taskId && node.x === 111 && node.y === 222)) {
        throw new Error("Desktop layout did not persist the smoke task position.");
      }
      await api.resetDesktopLayout(projectRoot);
      const filteredSearch = await api.searchProject(projectRoot, "Updated from smoke", { kinds: ["prompt"] });
      if (!filteredSearch.some((item) => item.kind === "prompt" && item.ref === task.taskId)) {
        throw new Error("Filtered prompt search did not find the updated smoke task prompt.");
      }
      const pipeline = await api.getReviewPipeline(projectRoot, "T-001");
      if (!pipeline.steps.some((step) => step.blockId === "R-001")) {
        throw new Error("Review Pipeline did not expose the fixture review step.");
      }
      const run = await api.startAutoRun(projectRoot, { kind: "block", blockRef: "T-001#B-001" }, 1);
      let state = run;
      for (let attempt = 0; attempt < 20 && state.phase === "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        state = await api.getAutoRunState(run.runId);
      }
      if (!["manual", "paused", "completed", "blocked"].includes(state.phase)) {
        throw new Error("Desktop Auto Run did not reach an inspectable phase: " + state.phase);
      }
      if (state.currentExecutor !== "manual") {
        throw new Error("Desktop Auto Run did not expose the current executor.");
      }
      return {
        taskId: task.taskId,
        filteredSearchCount: filteredSearch.length,
        autoRunPhase: state.phase,
        currentExecutor: state.currentExecutor,
        elapsedMs: state.elapsedMs
      };
    })()
  `) as Promise<Record<string, unknown>>;
}

async function runRendererManualSmoke(window: BrowserWindow): Promise<Record<string, unknown>> {
  return window.webContents.executeJavaScript(`
    (async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const textOf = (element) => (element.textContent ?? "").replace(/\\s+/g, " ").trim();
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }
        const style = window.getComputedStyle(element);
        return style.visibility !== "hidden" && style.display !== "none" && element.offsetParent !== null;
      };
      const dispatchTextInput = (element, value) => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
        setter?.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const clickElement = async (target) => {
        target.scrollIntoView({ block: "center", inline: "center" });
        target.focus?.();
        if (typeof PointerEvent === "function") {
          target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse" }));
          target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, buttons: 0, pointerId: 1, pointerType: "mouse" }));
        }
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, buttons: 1 }));
        target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, buttons: 0 }));
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
        await wait(120);
      };
      const clickByText = async (text) => {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const target = [...document.querySelectorAll("button")]
            .filter(visible)
            .find((element) => textOf(element).includes(text));
          if (target) {
            await clickElement(target);
            return textOf(target);
          }
          await wait(100);
        }
        throw new Error("Unable to click visible button containing: " + text);
      };
      const clickByLabel = async (label) => {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const target = [...document.querySelectorAll("button")]
            .filter(visible)
            .find((element) => element.getAttribute("aria-label") === label);
          if (target) {
            await clickElement(target);
            return label;
          }
          await wait(100);
        }
        throw new Error("Unable to click visible button with aria-label: " + label);
      };
      const waitForText = async (text) => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if ((document.body.textContent ?? "").includes(text)) {
            return;
          }
          await wait(100);
        }
        const visibleButtons = [...document.querySelectorAll("button")]
          .filter(visible)
          .map(textOf)
          .filter(Boolean)
          .slice(0, 24)
          .join(" | ");
        throw new Error(
          "Timed out waiting for text: " +
            text +
            " | visible buttons: " +
            visibleButtons +
            " | body: " +
            textOf(document.body).slice(0, 240)
        );
      };
      const waitForSelector = async (selector, label, options = {}) => {
        const { required = true } = options;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const target = document.querySelector(selector);
          if (target && visible(target)) {
            return true;
          }
          await wait(100);
        }
        if (!required) {
          return false;
        }
        throw new Error("Timed out waiting for visible " + label + ": " + selector);
      };

      const covered = [];
      await clickByText("新任务");
      covered.push("open-new-task-view");
      await waitForText("需求 / 计划 / 任务说明");
      const taskInput = [...document.querySelectorAll("textarea")].find(visible);
      if (!taskInput) {
        throw new Error("New Task textarea was not visible.");
      }
      dispatchTextInput(taskInput, "# UI Smoke Task\\n\\nCreate a task through renderer controls.");
      covered.push("enter-task-brief");
      await clickByText("生成 Draft");
      await waitForText("UI Smoke Task");
      covered.push("generate-draft");
      await clickByText("确认写入");
      await waitForText("UI Smoke Task");
      covered.push("confirm-write-plan-package");
      await clickByText("统计");
      await waitForText("Implemented Ratio");
      covered.push("open-statistics");
      await clickByText("搜索");
      const searchInputs = [...document.querySelectorAll("input")].filter(visible);
      const searchInput = searchInputs.at(-1);
      if (!searchInput) {
        throw new Error("Search input was not visible.");
      }
      dispatchTextInput(searchInput, "UI Smoke Task");
      await waitForText("UI Smoke Task");
      covered.push("search-created-task");
      await clickByText("通知");
      await waitForText("通知");
      covered.push("open-notifications");
      await clickByLabel("设置");
      await waitForText("Runtime 路径");
      await waitForText("组件设置");
      covered.push("open-settings-with-component-settings");
      await clickByText("图谱");
      await waitForText("UI Smoke Task");
      if (!(await waitForSelector("[data-graph-surface]", "graph surface", { required: false }))) {
        await clickByText("UI Smoke Task");
      }
      await waitForSelector("[data-graph-surface]", "graph surface");
      covered.push("return-graph");
      await waitForSelector("[data-auto-run-control]", "Floating Auto Run control");
      covered.push("auto-run-control-visible");
      await clickByLabel("Auto Run");
      await waitForText("运行面板");
      await waitForText("当前 Block");
      covered.push("open-mini-run-panel");
      await clickByText("Todo");
      await waitForText("ready");
      covered.push("open-todo");
      await clickByText("Review Pipeline");
      await waitForText("保存 Review Pipeline");
      await clickByText("添加 Review Step");
      await waitForText("新 Review Step");
      await clickByText("保存 Review Pipeline");
      covered.push("edit-review-pipeline");
      return {
        covered,
        uiSmokeTaskVisible: (document.body.textContent ?? "").includes("UI Smoke Task")
      };
    })()
  `) as Promise<Record<string, unknown>>;
}

async function runSmokeCheck(window: BrowserWindow): Promise<void> {
  const requiredText = [
    "PlanWeave",
    "Implement a tiny example change",
    "Task Node",
    "Review Block"
  ];
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = await readSmokeState(window);
    const missingText = requiredText.filter((text) => !state.pageText.includes(text));
    if (missingText.length === 0 && state.autoRunControlAvailable && state.bridgeAvailable && !state.nodeRequireAvailable) {
      let workflow: Record<string, unknown>;
      let rendererManual: Record<string, unknown>;
      try {
        workflow = await runSmokeWorkflow(window);
        rendererManual = await runRendererManualSmoke(window);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "PLANWEAVE_DESKTOP_SMOKE_WORKFLOW_FAILED",
            message: error instanceof Error ? error.message : String(error),
            projectRoot: process.env.PLANWEAVE_DESKTOP_SMOKE_PROJECT_ROOT
          })
        );
        app.exit(1);
        return;
      }
      console.log(
        JSON.stringify({
          event: "PLANWEAVE_DESKTOP_SMOKE_READY",
          bridgeAvailable: state.bridgeAvailable,
          nodeRequireAvailable: state.nodeRequireAvailable,
          autoRunControlAvailable: state.autoRunControlAvailable,
          workflow,
          rendererManual,
          projectRoot: process.env.PLANWEAVE_DESKTOP_SMOKE_PROJECT_ROOT
        })
      );
      app.exit(0);
      return;
    }
    await wait(100);
  }
  const state = await readSmokeState(window);
  console.error(
    JSON.stringify({
      event: "PLANWEAVE_DESKTOP_SMOKE_FAILED",
      bodyPreview: state.pageText.slice(0, 200),
      bridgeAvailable: state.bridgeAvailable,
      nodeRequireAvailable: state.nodeRequireAvailable,
      autoRunControlAvailable: state.autoRunControlAvailable,
      missingText: requiredText.filter((text) => !state.pageText.includes(text)),
      projectRoot: process.env.PLANWEAVE_DESKTOP_SMOKE_PROJECT_ROOT
    })
  );
  app.exit(1);
}

async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 720,
    show: !isSmoke,
    title: "planweave",
    backgroundColor: "#f7f8fa",
    webPreferences: {
      preload: join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (isSmoke) {
    window.webContents.on("console-message", (details: ElectronEvent<WebContentsConsoleMessageEventParams>) => {
      console.log(JSON.stringify({ event: "PLANWEAVE_DESKTOP_RENDERER_CONSOLE", message: details.message }));
    });
    window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
      console.error(JSON.stringify({ event: "PLANWEAVE_DESKTOP_LOAD_FAILED", errorCode, errorDescription }));
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      console.error(JSON.stringify({ event: "PLANWEAVE_DESKTOP_RENDERER_GONE", details }));
    });
  }

  if (isDev) {
    await window.loadURL(process.env.PLANWEAVE_DESKTOP_DEV_SERVER_URL as string);
  } else {
    await window.loadFile(rendererEntry());
  }
  if (isSmoke) {
    await runSmokeCheck(window);
  }
  return window;
}

ipcMain.handle("planweave:listProjects", () => listProjects());
ipcMain.handle("planweave:openProject", (_event, input: { projectId?: string; rootPath?: string }) => openProject(input));
ipcMain.handle("planweave:initOrOpenProject", (_event, rootPath: string) => initOrOpenProject(rootPath));
ipcMain.handle("planweave:getProjectOverview", (_event, projectRoot: string) => getProjectOverview(projectRoot));
ipcMain.handle("planweave:getGraphViewModel", (_event, projectRoot: string) => getGraphViewModel(projectRoot));
ipcMain.handle("planweave:getTaskDetail", (_event, projectRoot: string, taskId: string) => getTaskDetail(projectRoot, taskId));
ipcMain.handle("planweave:getBlockDetail", (_event, projectRoot: string, blockRef: string) => getBlockDetail(projectRoot, blockRef));
ipcMain.handle("planweave:getTaskExecutionOrder", (_event, projectRoot: string, taskId: string) =>
  getTaskExecutionOrder(projectRoot, taskId)
);
ipcMain.handle("planweave:getTodoGroups", (_event, projectRoot: string) => getTodoGroups(projectRoot));
ipcMain.handle("planweave:listBlockRunRecords", (_event, projectRoot: string, blockRef: string) =>
  listBlockRunRecords(projectRoot, blockRef)
);
ipcMain.handle("planweave:getRunRecord", (_event, projectRoot: string, recordId: string) => getRunRecord(projectRoot, recordId));
ipcMain.handle("planweave:getReviewAttempts", (_event, projectRoot: string, blockRef: string) => getReviewAttempts(projectRoot, blockRef));
ipcMain.handle("planweave:getFeedbackRecords", (_event, projectRoot: string, blockRef: string) => getFeedbackRecords(projectRoot, blockRef));
ipcMain.handle("planweave:getReviewPipeline", (_event, projectRoot: string, taskId: string) => getReviewPipeline(projectRoot, taskId));
ipcMain.handle("planweave:updateReviewPipeline", (_event, projectRoot: string, taskId: string, input: Parameters<typeof updateReviewPipeline>[2]) =>
  invokeGraphEdit(updateReviewPipeline(projectRoot, taskId, input))
);
ipcMain.handle("planweave:getStatistics", (_event, projectRoot: string) => getStatistics(projectRoot));
ipcMain.handle("planweave:searchProject", (_event, projectRoot: string, query: string, filters?: Parameters<typeof searchProject>[2]) =>
  searchProject(projectRoot, query, filters)
);
ipcMain.handle("planweave:createTaskDraft", (_event, projectRoot: string, input: Parameters<typeof createTaskDraft>[1]) =>
  createTaskDraft(projectRoot, input)
);
ipcMain.handle("planweave:addTaskNode", (_event, projectRoot: string, input: Parameters<typeof addTaskNode>[1]) =>
  invokeGraphEdit(addTaskNode(projectRoot, input))
);
ipcMain.handle("planweave:addBlock", (_event, projectRoot: string, input: Parameters<typeof addBlock>[1]) =>
  invokeGraphEdit(addBlock(projectRoot, input))
);
ipcMain.handle("planweave:addContextNode", (_event, projectRoot: string, input: Parameters<typeof addContextNode>[1]) =>
  invokeGraphEdit(addContextNode(projectRoot, input))
);
ipcMain.handle("planweave:removeTaskNode", (_event, projectRoot: string, taskId: string) =>
  invokeGraphEdit(removeTaskNode(projectRoot, taskId))
);
ipcMain.handle("planweave:removeBlock", (_event, projectRoot: string, blockRef: string) => invokeGraphEdit(removeBlock(projectRoot, blockRef)));
ipcMain.handle("planweave:validateGraphEdit", (_event, projectRoot: string, input: Parameters<typeof validateGraphEdit>[1]) =>
  invokeGraphEdit(validateGraphEdit(projectRoot, input))
);
ipcMain.handle("planweave:updateTaskTitle", (_event, projectRoot: string, taskId: string, title: string) =>
  invokeGraphEdit(updateTaskTitle(projectRoot, taskId, title))
);
ipcMain.handle("planweave:updateTaskPrompt", (_event, projectRoot: string, taskId: string, markdown: string) =>
  invokeGraphEdit(updateTaskPrompt(projectRoot, taskId, markdown))
);
ipcMain.handle("planweave:updateBlockTitle", (_event, projectRoot: string, blockRef: string, title: string) =>
  invokeGraphEdit(updateBlockTitle(projectRoot, blockRef, title))
);
ipcMain.handle("planweave:updateBlockPrompt", (_event, projectRoot: string, blockRef: string, markdown: string) =>
  invokeGraphEdit(updateBlockPrompt(projectRoot, blockRef, markdown))
);
ipcMain.handle("planweave:updateTaskExecutor", (_event, projectRoot: string, taskId: string, executorName: string | null) =>
  invokeGraphEdit(updateTaskExecutor(projectRoot, taskId, executorName))
);
ipcMain.handle("planweave:updateBlockExecutor", (_event, projectRoot: string, blockRef: string, executorName: string | null) =>
  invokeGraphEdit(updateBlockExecutor(projectRoot, blockRef, executorName))
);
ipcMain.handle("planweave:addDependencyEdge", (_event, projectRoot: string, fromTaskId: string, toTaskId: string) =>
  invokeGraphEdit(addDependencyEdge(projectRoot, fromTaskId, toTaskId))
);
ipcMain.handle("planweave:removeDependencyEdge", (_event, projectRoot: string, fromTaskId: string, toTaskId: string) =>
  invokeGraphEdit(removeDependencyEdge(projectRoot, fromTaskId, toTaskId))
);
ipcMain.handle("planweave:getDesktopLayout", (_event, projectRoot: string) => getDesktopLayout(projectRoot));
ipcMain.handle("planweave:saveDesktopLayout", (_event, projectRoot: string, layout: DesktopLayout) => saveDesktopLayout(projectRoot, layout));
ipcMain.handle("planweave:resetDesktopLayout", (_event, projectRoot: string) => resetDesktopLayout(projectRoot));
ipcMain.handle("planweave:createPackageFileSnapshot", (_event, projectRoot: string) => createDesktopPackageFileSnapshot(projectRoot));
ipcMain.handle("planweave:detectPackageFileChanges", (_event, projectRoot: string, snapshotId?: string | null) =>
  detectDesktopPackageFileChanges(projectRoot, snapshotId)
);
ipcMain.handle("planweave:refreshChangedPackagePrompts", (_event, projectRoot: string, snapshotId?: string | null) =>
  refreshChangedDesktopPackagePrompts(projectRoot, snapshotId)
);
ipcMain.handle("planweave:refreshPackageFileChanges", (_event, projectRoot: string) => refreshPackageFileChanges(projectRoot));
ipcMain.handle("planweave:getDirtyPromptRefs", (_event, projectRoot: string) => getDirtyPromptRefs(projectRoot));
ipcMain.handle("planweave:watchPackageFiles", (event, projectRoot: string) => startPackageWatch(projectRoot, event.sender));
ipcMain.handle("planweave:unwatchPackageFiles", (event, projectRoot: string) => stopPackageWatch(projectRoot, event.sender));
ipcMain.handle("planweave:startAutoRun", (_event, projectRoot: string, scope: DesktopAutoRunScope, stepLimit?: number) =>
  startAutoRun(projectRoot, scope, stepLimit)
);
ipcMain.handle("planweave:pauseAutoRun", (_event, runId: string) => pauseAutoRun(runId));
ipcMain.handle("planweave:resumeAutoRun", (_event, runId: string) => resumeAutoRun(runId));
ipcMain.handle("planweave:stopAutoRun", (_event, runId: string) => stopAutoRun(runId));
ipcMain.handle("planweave:getAutoRunState", (_event, runId: string) => getAutoRunState(runId));
ipcMain.handle("planweave:getLatestAutoRunSummary", (_event, projectRoot: string) => getLatestAutoRunSummary(projectRoot));

app.whenReady().then(() => {
  void createWindow().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    app.exit(1);
  });
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
