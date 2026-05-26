import { app, BrowserWindow } from "electron";

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
      const canvasId = null;
      const canvas = { projectRoot, canvasId };
      const added = await api.addTaskNode(canvas, {
        title: "Smoke task",
        promptMarkdown: "# Smoke task\\n",
        acceptance: ["Smoke task source prompt is editable."],
        blockTypes: ["implementation", "review"],
        executor: "manual"
      });
      if (!added.ok) {
        throw new Error("addTaskNode failed: " + added.diagnostics.map((item) => item.message).join("; "));
      }
      const graph = await api.getGraphViewModel(canvas);
      const task = graph.tasks.find((item) => item.title === "Smoke task");
      if (!task || !task.promptMarkdown.includes("# Smoke task")) {
        throw new Error("Smoke task full prompt was not exposed in the graph view model.");
      }
      await api.updateTaskPrompt(canvas, task.taskId, "# Smoke task\\n\\nUpdated from smoke.");
      await api.addDependencyEdge(canvas, task.taskId, "T-001");
      const savedLayout = await api.saveDesktopLayout(canvas, {
        version: "desktop-layout/v1",
        projectId: "ignored",
        nodes: [{ nodeId: task.taskId, x: 111, y: 222 }],
        updatedAt: new Date(0).toISOString()
      });
      if (!savedLayout.nodes.some((node) => node.nodeId === task.taskId && node.x === 111 && node.y === 222)) {
        throw new Error("Desktop layout did not persist the smoke task position.");
      }
      await api.resetDesktopLayout(canvas);
      const filteredSearch = await api.searchProject(projectRoot, "Updated from smoke", { kinds: ["prompt"] });
      if (!filteredSearch.some((item) => item.kind === "prompt" && item.ref === task.taskId)) {
        throw new Error("Filtered prompt search did not find the updated smoke task prompt.");
      }
      const pipeline = await api.getReviewPipeline(canvas, "T-001");
      if (!pipeline.steps.some((step) => step.blockId === "R-001")) {
        throw new Error("Review Pipeline did not expose the fixture review step.");
      }
      const run = await api.startAutoRun(canvas, { kind: "block", blockRef: "T-001#B-001" }, 1);
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
      const clickByTestId = async (testId) => {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const target = document.querySelector('[data-testid="' + testId + '"]');
          if (target && visible(target)) {
            await clickElement(target);
            return testId;
          }
          await wait(100);
        }
        throw new Error("Unable to click visible element with data-testid: " + testId);
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
      await clickByTestId("sidebar-new-task");
      covered.push("open-new-task-view");
      await waitForText("需求 / 计划 / 任务说明");
      const taskInput = document.querySelector('[data-testid="new-task-input"]');
      if (!taskInput) {
        throw new Error("New Task textarea was not visible.");
      }
      dispatchTextInput(taskInput, "# UI Smoke Task\\n\\nCreate a task through renderer controls.");
      covered.push("enter-task-brief");
      await clickByTestId("new-task-generate-draft");
      await waitForText("UI Smoke Task");
      covered.push("generate-draft");
      await clickByTestId("new-task-confirm-write");
      await waitForText("UI Smoke Task");
      covered.push("confirm-write-plan-package");
      await clickByTestId("sidebar-statistics");
      await waitForText("Implemented Ratio");
      covered.push("open-statistics");
      await clickByTestId("sidebar-search");
      const searchInput = document.querySelector('[data-testid="search-query-input"]');
      if (!searchInput) {
        throw new Error("Search input was not visible.");
      }
      dispatchTextInput(searchInput, "UI Smoke Task");
      await waitForText("UI Smoke Task");
      covered.push("search-created-task");
      await clickByTestId("sidebar-notifications");
      await waitForText("通知");
      covered.push("open-notifications");
      await clickByTestId("sidebar-settings");
      await waitForSelector('[data-testid="settings-back-to-app"]', "settings back button");
      await waitForSelector('[data-testid="settings-section-general"]', "general settings section");
      await clickByTestId("settings-nav-components");
      await waitForSelector('[data-testid="settings-section-components"]', "component settings section");
      covered.push("open-settings-with-component-settings");
      await clickByTestId("settings-nav-review");
      await waitForSelector('[data-testid="settings-section-review"]', "review settings section");
      await clickByTestId("settings-nav-agents");
      await waitForSelector('[data-testid="settings-section-agents"]', "agent settings section");
      covered.push("open-settings-sections");
      await clickByTestId("settings-back-to-app");
      await waitForText("UI Smoke Task");
      await waitForSelector("[data-graph-surface]", "graph surface");
      covered.push("return-graph");
      await waitForSelector("[data-auto-run-control]", "Floating Auto Run control");
      covered.push("auto-run-control-visible");
      await clickByLabel("Auto Run");
      await waitForText("运行面板");
      await waitForText("当前 Block");
      covered.push("open-mini-run-panel");
      await clickByTestId("sidebar-todo");
      await waitForText("ready");
      covered.push("open-todo");
      return {
        covered,
        uiSmokeTaskVisible: (document.body.textContent ?? "").includes("UI Smoke Task")
      };
    })()
  `) as Promise<Record<string, unknown>>;
}

export async function runSmokeCheck(window: BrowserWindow): Promise<void> {
  const requiredText = ["PlanWeave", "Implement a tiny example change", "Task Node", "Review Block"];
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
