import { app, BrowserWindow } from "electron";
import { realpath, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  summarizeChromiumAccessibilityTree,
  type ChromiumAxTree
} from "./chromiumAccessibility.js";

export const packagedStartupSmokeEvent = "PLANWEAVE_DESKTOP_STARTUP_SMOKE_READY";

const packagedStartupSmokeResultSchema = z
  .object({
    event: z.literal(packagedStartupSmokeEvent),
    rendererLoaded: z.literal(true),
    runtimeBridgeAvailable: z.literal(true),
    isolatedProjectCount: z.literal(0),
    appUpdateBridgeAvailable: z.literal(true),
    appUpdateDelivery: z.enum(["in-app", "github-releases"]),
    appVersion: z.string().min(1),
    metadataVerified: z.literal(true)
  })
  .strict();

export type PackagedStartupSmokeResult = z.infer<typeof packagedStartupSmokeResultSchema>;

type PackagedStartupSmokeWindow = {
  webContents: {
    executeJavaScript(script: string): Promise<unknown>;
  };
};

export async function runPackagedStartupSmoke(
  window: PackagedStartupSmokeWindow
): Promise<PackagedStartupSmokeResult> {
  const rawResult = await window.webContents.executeJavaScript(`
    (async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      let rendererLoaded = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const root = document.getElementById("root");
        if (document.readyState === "complete" && root instanceof HTMLElement && root.childElementCount > 0) {
          rendererLoaded = true;
          break;
        }
        await wait(50);
      }
      if (!rendererLoaded) {
        throw new Error("Packaged renderer did not mount into the application window.");
      }

      const runtimeBridge = window.planweave;
      if (!runtimeBridge || typeof runtimeBridge.listProjects !== "function") {
        throw new Error("Packaged runtime bridge is unavailable.");
      }
      const projects = await runtimeBridge.listProjects();
      if (!Array.isArray(projects)) {
        throw new Error("Packaged runtime bridge returned an invalid project list.");
      }
      if (projects.length !== 0) {
        throw new Error("Packaged startup smoke did not use the isolated PLANWEAVE_HOME.");
      }

      const appUpdateBridge = window.planweaveAppUpdate;
      if (!appUpdateBridge || typeof appUpdateBridge.getAppUpdateState !== "function") {
        throw new Error("Packaged app-update bridge is unavailable.");
      }
      const appUpdateState = await appUpdateBridge.getAppUpdateState();
      if (!appUpdateState || typeof appUpdateState !== "object") {
        throw new Error("Packaged app-update bridge returned an invalid state.");
      }
      if (appUpdateState.status === "error" || appUpdateState.status === "unsupported") {
        throw new Error("Packaged build metadata verification failed: " + String(appUpdateState.error));
      }
      if (appUpdateState.delivery !== "in-app" && appUpdateState.delivery !== "github-releases") {
        throw new Error("Packaged app-update delivery is invalid.");
      }
      if (typeof appUpdateState.currentVersion !== "string" || appUpdateState.currentVersion.length === 0) {
        throw new Error("Packaged app-update metadata did not expose the current version.");
      }

      return {
        event: ${JSON.stringify(packagedStartupSmokeEvent)},
        rendererLoaded: true,
        runtimeBridgeAvailable: true,
        isolatedProjectCount: projects.length,
        appUpdateBridgeAvailable: true,
        appUpdateDelivery: appUpdateState.delivery,
        appVersion: appUpdateState.currentVersion,
        metadataVerified: true
      };
    })()
  `);
  return packagedStartupSmokeResultSchema.parse(rawResult);
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
  const resolvedProjectRoot = await realpath(projectRoot);
  return window.webContents.executeJavaScript(`
    (async () => {
      const api = window.planweave;
      const smokeSourceRoot = ${JSON.stringify(resolvedProjectRoot)};
      const project = (await api.listProjects()).find(
        (item) => item.rootPath === smokeSourceRoot || item.sourceRoot === smokeSourceRoot
      );
      if (!project) {
        throw new Error("Smoke project was not available from the desktop bridge.");
      }
      const projectRoot = project.rootPath;
      const canvasId = project.activeCanvasId ?? project.taskCanvases[0]?.canvasId ?? null;
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
      for (let attempt = 0; attempt < 100 && state.phase === "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        state = await api.getAutoRunState(run.runId);
      }
      if (!["manual", "paused", "completed", "blocked"].includes(state.phase)) {
        throw new Error("Desktop Auto Run did not reach an inspectable phase: " + state.phase);
      }
      if (state.currentExecutor !== "manual") {
        throw new Error("Desktop Auto Run did not expose the current executor.");
      }
      // Stop the API-started Auto Run so the reloaded renderer can inspect a terminal state
      // while preserving the created run records.
      if (state.runId && !["completed", "stopped", "failed"].includes(state.phase)) {
        state = await api.stopAutoRun(state.runId);
        for (let attempt = 0; attempt < 30 && !["completed", "stopped", "failed"].includes(state.phase); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          state = await api.getAutoRunState(state.runId);
        }
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
  const projectRoot = process.env.PLANWEAVE_DESKTOP_SMOKE_PROJECT_ROOT;
  if (!projectRoot) {
    throw new Error("PLANWEAVE_DESKTOP_SMOKE_PROJECT_ROOT is required for renderer desktop smoke.");
  }
  const resolvedProjectRoot = await realpath(projectRoot);
  return window.webContents.executeJavaScript(`
    (async () => {
      const smokeSourceRoot = ${JSON.stringify(resolvedProjectRoot)};
      const project = (await window.planweave.listProjects()).find(
        (item) => item.rootPath === smokeSourceRoot || item.sourceRoot === smokeSourceRoot
      );
      if (!project) {
        throw new Error("Smoke project was not available from the desktop bridge.");
      }
      const projectRoot = project.rootPath;
      const canvasId = project.activeCanvasId ?? project.taskCanvases[0]?.canvasId ?? null;
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
          target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", view: window }));
          target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, buttons: 0, pointerId: 1, pointerType: "mouse", view: window }));
        }
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, buttons: 1, view: window }));
        target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, buttons: 0, view: window }));
        target.click();
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
      const openContextMenuByTestId = async (testId) => {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const target = document.querySelector('[data-testid="' + testId + '"]');
          if (target && visible(target)) {
            target.scrollIntoView({ block: "center", inline: "center" });
            const bounds = target.getBoundingClientRect();
            target.dispatchEvent(new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              button: 2,
              buttons: 2,
              clientX: bounds.left + bounds.width / 2,
              clientY: bounds.top + bounds.height / 2,
              view: window
            }));
            await wait(120);
            return testId;
          }
          await wait(100);
        }
        throw new Error("Unable to open context menu for visible element with data-testid: " + testId);
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
      const waitForAnyText = async (texts) => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const body = document.body.textContent ?? "";
          if (texts.some((text) => body.includes(text))) {
            return;
          }
          await wait(100);
        }
        throw new Error("Timed out waiting for one of: " + texts.join(" | ") + " | body: " + textOf(document.body).slice(0, 240));
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
      const waitForAutoRunMiniStatus = async () => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const target = document.querySelector('[data-testid="auto-run-mini-status"]');
          if (target && visible(target)) {
            const phase = target.getAttribute("data-phase");
            if (phase && phase !== "idle") {
              return phase;
            }
          }
          await wait(100);
        }
        throw new Error("Timed out waiting for mini Auto Run status to reflect a runtime state.");
      };
      const waitForSmokeRevealPath = async (expectedPath) => {
        const smoke = window.planweaveSmoke;
        if (!smoke || typeof smoke.clearLastRevealPath !== "function" || typeof smoke.getLastRevealPath !== "function") {
          throw new Error("Smoke reveal path signal was not exposed.");
        }
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const revealedPath = smoke.getLastRevealPath();
          if (revealedPath === expectedPath) {
            return revealedPath;
          }
          await wait(100);
        }
        throw new Error("Mini Auto Run record action did not invoke revealPathInFinder with " + expectedPath + ". Last signal: " + smoke.getLastRevealPath());
      };
      const waitForWindowMaterialState = async () => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const rootHasMaterial = document.documentElement.dataset.windowMaterial === "true";
          const glassSurface = document.querySelector(".glass-surface");
          const backgroundColor = glassSurface instanceof HTMLElement ? window.getComputedStyle(glassSurface).backgroundColor : "";
          const glassSurfaceHasAlpha = /(?:rgba|rgb|oklch|color)\\([^)]*(?:,\\s*0\\.|\\/\\s*0\\.)/.test(backgroundColor);
          if (rootHasMaterial && glassSurfaceHasAlpha) {
            return backgroundColor;
          }
          await wait(100);
        }
        throw new Error("Window material did not apply a root state and an alpha glass surface.");
      };

      const covered = [];
      await waitForSelector("[data-graph-surface]", "graph surface");
      await waitForText("Smoke task");
      await clickByTestId("sidebar-statistics");
      await wait(250);
      covered.push("open-statistics");
      await clickByTestId("sidebar-search");
      await waitForSelector('[data-testid="search-query-input"]', "search input");
      const searchInput = document.querySelector('[data-testid="search-query-input"]');
      if (!(searchInput instanceof HTMLElement)) {
        throw new Error("Search input was not visible.");
      }
      dispatchTextInput(searchInput, "Smoke task");
      await waitForText("Smoke task");
      covered.push("search-smoke-task");
      await clickByTestId("sidebar-notifications");
      await waitForSelector('[data-testid="notifications-view"]', "notifications view");
      await waitForAnyText(["检测到外部文件变更", "External file changes detected"]);
      covered.push("open-notifications");
      covered.push("external-file-change-notification");
      await clickByTestId("sidebar-settings");
      await waitForSelector('[data-testid="settings-back-to-app"]', "settings back button");
      await waitForSelector('[data-testid="settings-section-general"]', "general settings section");
      const materialSwitch = document.querySelector('[role="switch"][aria-label="增强窗口材质"], [role="switch"][aria-label="Enhanced window material"]');
      if (!(materialSwitch instanceof HTMLElement)) {
        throw new Error("Enhanced window material switch was not visible.");
      }
      // The window material defaults on for macOS, so only toggle when it is off
      // to land in the enabled state instead of blindly flipping it back off.
      if (materialSwitch.getAttribute("aria-checked") !== "true") {
        await clickElement(materialSwitch);
      }
      await waitForWindowMaterialState();
      covered.push("enable-window-material");
      await clickByTestId("settings-nav-components");
      await waitForSelector('[data-testid="settings-section-components"]', "component settings section");
      covered.push("open-settings-with-component-settings");
      await clickByTestId("settings-nav-review");
      await waitForSelector('[data-testid="settings-section-review"]', "review settings section");
      covered.push("open-settings-sections");
      await clickByTestId("settings-back-to-app");
      await clickByTestId("sidebar-executors");
      await waitForSelector('[data-testid="executor-inventory"]', "executor inventory");
      await clickByTestId("executor-configure-codex");
      await waitForSelector('[data-testid="settings-section-agents"]', "local execution settings dialog");
      await clickByTestId("management-dialog-close");
      const backSelector = 'button[aria-label="后退"], button[aria-label="Back"]';
      await waitForSelector(backSelector, "history back button");
      await clickElement(document.querySelector(backSelector));
      covered.push("open-executor-settings-dialog");
      await waitForText("Smoke task");
      await waitForSelector("[data-graph-surface]", "graph surface");
      covered.push("return-graph");
      await waitForSelector("[data-auto-run-control]", "Floating Auto Run control");
      covered.push("auto-run-control-visible");
      await openContextMenuByTestId("auto-run-trigger");
      await clickByTestId("auto-run-open-panel");
      await waitForSelector('[data-testid="auto-run-mini-panel"]', "mini Auto Run panel");
      const autoRunPhase = await waitForAutoRunMiniStatus();
      const recordActionVisible = await waitForSelector('[data-testid="auto-run-open-record"]', "mini Auto Run record action", { required: false });
      if (!recordActionVisible) {
        const latest = await window.planweave.getLatestAutoRunSummary({ projectRoot, canvasId });
        throw new Error("Mini Auto Run panel did not expose the latest record action. Latest state: " + JSON.stringify(latest));
      }
      const status = document.querySelector('[data-testid="auto-run-mini-status"]');
      const statusRunId = status instanceof HTMLElement ? status.getAttribute("data-run-id") : null;
      const recordAction = document.querySelector('[data-testid="auto-run-open-record"]');
      if (!(recordAction instanceof HTMLElement)) {
        throw new Error("Mini Auto Run record action was not available after panel status loaded.");
      }
      const recordActionPath = recordAction.getAttribute("data-record-path");
      const recordRunId = recordAction.getAttribute("data-run-id");
      if (!recordActionPath || !recordActionPath.endsWith("metadata.json")) {
        throw new Error("Mini Auto Run record action did not target a metadata record path: " + recordActionPath);
      }
      if (!statusRunId || !recordRunId) {
        throw new Error("Mini Auto Run panel or record action did not expose a run id.");
      }
      if (recordRunId !== statusRunId) {
        const latestEffective = await window.planweave.getLatestAutoRunSummary({ projectRoot, canvasId });
        if (latestEffective?.runId !== recordRunId || latestEffective.latestRecordPath !== recordActionPath) {
          throw new Error("Mini Auto Run record action targeted run " + recordRunId + " instead of panel run " + statusRunId + " or latest effective run " + (latestEffective?.runId ?? "none"));
        }
      }
      window.planweaveSmoke.clearLastRevealPath();
      await clickByTestId("auto-run-open-record");
      const revealedRecordPath = await waitForSmokeRevealPath(recordActionPath);
      covered.push("open-mini-run-panel");
      covered.push("open-latest-auto-run-record");

      // Shared Task Workspace UI scenario (dev + packaged use this same path).
      const taskWorkspaceDiagnostics = () => {
        const shell = document.querySelector('[data-testid="task-workspace-shell"]');
        const selectedRun = document.querySelector(
          '[data-testid="task-workspace-run-summary"][aria-selected="true"]'
        );
        const detail =
          document.querySelector('[data-testid="task-workspace-cli-run"]') ??
          document.querySelector('[data-testid="task-workspace-acp-conversation"]');
        const alert = document.querySelector('[role="alert"]');
        let view = "other";
        if (shell) {
          view = "task-workspace";
        } else if (document.querySelector("[data-graph-surface]")) {
          view = "graph";
        }
        return {
          view,
          taskId: shell instanceof HTMLElement ? shell.getAttribute("data-task-id") : null,
          workspaceStatus:
            shell instanceof HTMLElement ? shell.getAttribute("data-workspace-status") : null,
          recordId:
            selectedRun instanceof HTMLElement
              ? selectedRun.getAttribute("data-record-id")
              : detail instanceof HTMLElement
                ? detail.getAttribute("data-record-id")
                : null,
          errorState:
            shell instanceof HTMLElement && shell.getAttribute("data-workspace-status") === "error"
              ? textOf(alert).slice(0, 240)
              : alert instanceof HTMLElement
                ? textOf(alert).slice(0, 240)
                : null
        };
      };
      const withTaskWorkspaceContext = (message) => {
        return message + " | diagnostics: " + JSON.stringify(taskWorkspaceDiagnostics());
      };
      const waitForTaskWorkspaceReady = async (taskId) => {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const shell = document.querySelector(
            '[data-testid="task-workspace-shell"][data-workspace-status="ready"][data-task-id="' +
              taskId +
              '"]'
          );
          if (shell && visible(shell)) {
            return shell;
          }
          const errorShell = document.querySelector(
            '[data-testid="task-workspace-shell"][data-workspace-status="error"]'
          );
          if (errorShell && visible(errorShell)) {
            throw new Error(
              withTaskWorkspaceContext("Task Workspace entered error state while waiting for ready")
            );
          }
          await wait(100);
        }
        throw new Error(
          withTaskWorkspaceContext("Timed out waiting for Task Workspace ready state for " + taskId)
        );
      };
      const waitForRunDetailReady = async () => {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const detail = document.querySelector(
            [
              '[data-testid="task-workspace-cli-run"][data-record-ready="true"]',
              '[data-testid="task-workspace-acp-conversation"][data-record-ready="true"]',
              '[data-testid="task-workspace-run-detail"][data-record-ready="true"]'
            ].join(", ")
          );
          if (detail && visible(detail)) {
            return detail;
          }
          const errorShell = document.querySelector(
            '[data-testid="task-workspace-shell"][data-workspace-status="error"]'
          );
          if (errorShell && visible(errorShell)) {
            throw new Error(
              withTaskWorkspaceContext("Task Workspace entered error state while waiting for run detail")
            );
          }
          await wait(100);
        }
        throw new Error(withTaskWorkspaceContext("Timed out waiting for Task Workspace run detail ready"));
      };

      const fixtureTaskId = "T-001";
      const fixtureBlockRef = "T-001#B-001";
      // Close mini Auto Run popover so it does not intercept graph pointer events.
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await wait(100);
      // Graph filtering reuses the Search view query. Clear it so fixture T-001 is visible again.
      await clickByTestId("sidebar-search");
      await waitForSelector('[data-testid="search-query-input"]', "search input before Task Workspace");
      const clearSearchInput = document.querySelector('[data-testid="search-query-input"]');
      if (!(clearSearchInput instanceof HTMLElement)) {
        throw new Error(withTaskWorkspaceContext("Search input was unavailable while clearing graph filter"));
      }
      dispatchTextInput(clearSearchInput, "");
      covered.push("clear-graph-search-filter");
      await clickByTestId("canvas-select-default");
      await waitForSelector("[data-graph-surface]", "graph surface before Task Workspace");
      const waitForFixtureBlock = async () => {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const card = document.querySelector(
            '[data-testid="task-node-card"][data-task-id="' + fixtureTaskId + '"]'
          );
          const block =
            card instanceof HTMLElement
              ? card.querySelector(
                  '[data-testid="task-node-block"][data-block-ref="' + fixtureBlockRef + '"]'
                )
              : null;
          if (block instanceof HTMLElement) {
            // ReactFlow nodes can sit outside the current viewport; scroll and click anyway.
            block.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
            return block;
          }
          await wait(100);
        }
        const availableTaskIds = [...document.querySelectorAll('[data-testid="task-node-card"]')]
          .map((element) => element.getAttribute("data-task-id"))
          .filter(Boolean)
          .join(", ");
        throw new Error(
          withTaskWorkspaceContext(
            "Fixture block button was not found for " +
              fixtureBlockRef +
              " | available task cards: " +
              (availableTaskIds || "(none)")
          )
        );
      };
      const blockButton = await waitForFixtureBlock();
      await clickElement(blockButton);
      covered.push("open-task-workspace-from-graph-block");
      await waitForTaskWorkspaceReady(fixtureTaskId);
      covered.push("task-workspace-ready");

      const titleBlock = document.querySelector('[data-testid="task-workspace-title-block"]');
      if (
        !(titleBlock instanceof HTMLElement) ||
        titleBlock.getAttribute("data-task-id") !== fixtureTaskId ||
        !titleBlock.getAttribute("data-task-title")
      ) {
        throw new Error(
          withTaskWorkspaceContext("Task Workspace title block did not expose stable task attributes")
        );
      }
      covered.push("task-workspace-title");

      const overviewEntry = document.querySelector('[data-testid="task-workspace-overview-entry"]');
      if (overviewEntry instanceof HTMLElement && visible(overviewEntry)) {
        await clickElement(overviewEntry);
      }
      const blockSummaries = document.querySelectorAll(
        '[data-testid="task-workspace-block-summary"][data-block-ref]'
      );
      if (blockSummaries.length === 0) {
        // Auto-selected run keeps overview collapsed; block identity is still on the opened graph block
        // and on timeline run summaries once runs are listed.
        const runWithBlock = document.querySelector(
          '[data-testid="task-workspace-run-summary"][data-block-ref="' + fixtureBlockRef + '"]'
        );
        if (!(runWithBlock instanceof HTMLElement)) {
          throw new Error(
            withTaskWorkspaceContext(
              "Task Workspace did not expose block summaries or run summaries for " + fixtureBlockRef
            )
          );
        }
      }
      covered.push("task-workspace-block-summaries");

      const runSummaries = document.querySelectorAll('[data-testid="task-workspace-run-summary"]');
      if (runSummaries.length === 0) {
        throw new Error(
          withTaskWorkspaceContext(
            "Task Workspace timeline did not expose any run summaries from Auto Run records"
          )
        );
      }
      const firstRun = runSummaries[0];
      if (!(firstRun instanceof HTMLElement)) {
        throw new Error(withTaskWorkspaceContext("First Task Workspace run summary was not an element"));
      }
      const selectedRecordId = firstRun.getAttribute("data-record-id");
      const selectedRunStatus = firstRun.getAttribute("data-status");
      if (!selectedRecordId || !selectedRunStatus) {
        throw new Error(
          withTaskWorkspaceContext("Run summary missing data-record-id or data-status attributes")
        );
      }
      await clickElement(firstRun);
      covered.push("select-task-workspace-run");
      const detail = await waitForRunDetailReady();
      const detailRecordId = detail.getAttribute("data-record-id");
      if (detailRecordId !== selectedRecordId) {
        throw new Error(
          withTaskWorkspaceContext(
            "Run detail record id " +
              detailRecordId +
              " did not match selected summary " +
              selectedRecordId
          )
        );
      }
      const selectedSummary = document.querySelector(
        '[data-testid="task-workspace-run-summary"][data-record-id="' +
          selectedRecordId +
          '"][aria-selected="true"]'
      );
      if (!(selectedSummary instanceof HTMLElement)) {
        throw new Error(
          withTaskWorkspaceContext("Selected run summary did not reflect aria-selected=true")
        );
      }
      covered.push("task-workspace-run-detail");

      await clickByTestId("task-workspace-back");
      await waitForSelector("[data-graph-surface]", "graph surface after Task Workspace return");
      await waitForSelector("[data-auto-run-control]", "Floating Auto Run control after Task Workspace return");
      await waitForFixtureBlock();
      await waitForSelector(
        '[data-testid="task-node-card"][data-task-id="' + fixtureTaskId + '"]',
        "fixture task card after Task Workspace return"
      );
      const returnedTaskCard = document.querySelector(
        '[data-testid="task-node-card"][data-task-id="' + fixtureTaskId + '"]'
      );
      if (!(returnedTaskCard instanceof HTMLElement) || !visible(returnedTaskCard)) {
        throw new Error(
          withTaskWorkspaceContext("Graph task card was unavailable after returning from Task Workspace")
        );
      }
      covered.push("return-graph-from-task-workspace");

      await clickByTestId("sidebar-todo");
      await waitForSelector('[data-testid="todo-view"]', "Todo view");
      covered.push("open-todo");
      return {
        covered,
        autoRunPhase,
        revealedRecordPath,
        taskWorkspace: {
          taskId: fixtureTaskId,
          blockRef: fixtureBlockRef,
          recordId: selectedRecordId,
          runStatus: selectedRunStatus,
          detailTestId: detail.getAttribute("data-testid")
        },
        smokeTaskVisible: (document.body.textContent ?? "").includes("Smoke task")
      };
    })()
  `) as Promise<Record<string, unknown>>;
}

async function runLiveCollaborationSmoke(window: BrowserWindow): Promise<Record<string, unknown>> {
  const serverBaseUrl = process.env.PLANWEAVE_DESKTOP_SMOKE_COLLABORATION_SERVER_URL;
  const projectId = process.env.PLANWEAVE_DESKTOP_SMOKE_COLLABORATION_PROJECT_ID;
  if (!serverBaseUrl || !projectId) {
    throw new Error("Live collaboration smoke fixture configuration is incomplete.");
  }

  // Exercise the real workspace navigation with a real Chromium keyboard event before
  // the page invokes the typed preload bridge methods.
  app.focus({ steal: true });
  window.show();
  window.focus();
  window.webContents.focus();
  await wait(50);
  await window.webContents.executeJavaScript(`
    (() => {
      const navigation = document.querySelector('[data-testid="sidebar-people"]');
      if (!(navigation instanceof HTMLElement)) {
        throw new Error("People navigation was not rendered.");
      }
      navigation.focus();
      return true;
    })()
  `);
  const keyboardFocusedTestId = (await window.webContents.executeJavaScript(`
    document.activeElement instanceof HTMLElement ? document.activeElement.dataset.testid ?? null : null
  `)) as string | null;
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "ENTER" });
  window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "ENTER" });
  const keyboardOpenedPeopleView = (await window.webContents.executeJavaScript(`
    (async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (document.querySelector('[data-testid="people-view"]')) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    })()
  `)) as boolean;
  if (!keyboardOpenedPeopleView) {
    throw new Error(
      `People keyboard action did not open the member page in Chromium (activeElement=${keyboardFocusedTestId ?? "none"}).`
    );
  }
  await window.webContents.executeJavaScript(`
    (() => {
      if (document.querySelector('[data-testid="people-view"]')) return true;
      const navigation = document.querySelector('[data-testid="sidebar-people"]');
      if (!(navigation instanceof HTMLElement)) {
        throw new Error("People navigation disappeared before opening the page.");
      }
      navigation.click();
      return true;
    })()
  `);

  const connection = (await window.webContents.executeJavaScript(`
    (async () => {
      const waitFor = async (predicate, label) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const value = predicate();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("Timed out waiting for " + label);
      };
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        return style.visibility !== "hidden" && style.display !== "none" && element.offsetParent !== null;
      };
      const click = async (testId) => {
        const target = await waitFor(() => {
          const element = document.querySelector('[data-testid="' + testId + '"]');
          return element && visible(element) ? element : null;
        }, testId);
        target.focus?.();
        target.click();
        await new Promise((resolve) => setTimeout(resolve, 50));
      };

      await waitFor(
        () => document.querySelector('[data-testid="collaboration-workspace-onboarding"]'),
        "collaboration workspace onboarding"
      );
      await click("collaboration-onboarding-create");
      await waitFor(
        () => document.querySelector('[data-testid="collaboration-onboarding-existing-server"]'),
        "existing Server onboarding choice"
      );
      await click("collaboration-onboarding-existing-server");
      await waitFor(
        () => document.querySelector('[data-testid="people-connect-form"]'),
        "existing Server connection form"
      );
      await waitFor(
        () => document.querySelector('[data-testid="people-connect-setup-details"]'),
        "complete setup handoff input"
      );
      await waitFor(
        () => document.querySelector('[data-testid="people-connect-submit"]'),
        "existing Server connection submit"
      );
      const collaborationApi = window.planweaveCollaboration;
      if (!collaborationApi) throw new Error("Typed collaboration bridge is unavailable.");
      const profileId = "desktop-smoke-owner";
      await collaborationApi.upsertCollaborationProfile({
        profileId,
        displayName: "Desktop smoke owner",
        serverBaseUrl: ${JSON.stringify(serverBaseUrl)},
        projectId: ${JSON.stringify(projectId)},
        allowInsecureTransport: true,
        endpoint: {
          topology: "loopback_http",
          serverOrigin: ${JSON.stringify(serverBaseUrl)},
          allowedClientOrigins: [${JSON.stringify(serverBaseUrl)}],
          tlsTrust: "not_applicable"
        }
      });
      await collaborationApi.bootstrapCollaborationOwner({
        profileId,
        request: { displayName: "Desktop smoke owner" }
      });
      await collaborationApi.connectCollaborationSession({ profileId });

      await click("people-section-members");
      const panel = await waitFor(
        () => {
          const element = document.querySelector('[data-testid="people-panel"]');
          return element instanceof HTMLElement && element.getAttribute("data-mode") === "ready"
            ? element
            : null;
        },
        "connected People panel"
      );
      const memberRows = [...document.querySelectorAll('[data-testid="people-member-row"]')];
      if (memberRows.length < 1) throw new Error("Connected People panel did not show the bootstrapped owner.");
      const status = await window.planweaveCollaboration?.getCollaborationStatus();
      if (!status || !["connected", "ready"].includes(status.session.phase)) {
        throw new Error("Typed collaboration bridge did not reach a connected session.");
      }
      return {
        panelMode: panel.getAttribute("data-mode"),
        memberCount: memberRows.length,
        sessionPhase: status.session.phase,
        keyboardOpenedPeopleView: ${JSON.stringify(keyboardOpenedPeopleView)}
      };
    })()
  `)) as Record<string, unknown>;

  const collaborationResult = (await window.webContents.executeJavaScript(`
    (async () => {
      const waitFor = async (predicate, label) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const value = predicate();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("Timed out waiting for " + label);
      };
      const workItem = { kind: "block", canvasId: "default", blockRef: "T-001#B-001" };
      const collaboration = window.planweaveCollaboration;
      if (!collaboration) throw new Error("Inspector collaboration bridge is unavailable.");
      let observerEventCount = 0;
      let firstObserverEventAt = null;
      const stopObserving = collaboration.onCollaborationObserverSignal((signal) => {
        if (signal.type === "human.observer.event") {
          observerEventCount += 1;
          firstObserverEventAt ??= performance.now();
        }
      });
      const burstStartedAt = performance.now();
      const bodies = Array.from({ length: 6 }, (_, index) =>
        "Desktop smoke live collaboration burst " + index
      );
      for (const body of bodies) {
        await collaboration.createCollaborationComment({ workItem, body });
      }
      await waitFor(
        () => observerEventCount > 0,
        "human observer event after comment burst"
      );
      const comments = await collaboration.listCollaborationComments({ workItem, limit: 50 });
      const activity = await collaboration.listCollaborationActivity({
        workItem,
        limit: 50
      });
      if (comments.items.length < bodies.length || activity.items.length < bodies.length) {
        throw new Error("Live collaboration bridge did not expose the comment/activity mutation.");
      }
      const observerRenderMs = firstObserverEventAt === null
        ? null
        : Math.round(performance.now() - firstObserverEventAt);
      stopObserving();
      return {
        commentCount: comments.items.length,
        activityCount: activity.items.length,
        observerEventCount,
        observerRenderMs,
        burstDurationMs: Math.round(performance.now() - burstStartedAt),
        commentsVisible: comments.items.length >= bodies.length,
        activityVisible: activity.items.length >= bodies.length
      };
    })()
  `)) as Record<string, unknown>;
  return {
    ...connection,
    ...collaborationResult,
    liveServer: true,
    typedBridge: true,
    rendererObserverSignal: true
  };
}

async function runLocalCollaborationSmoke(window: BrowserWindow): Promise<Record<string, unknown>> {
  const authorityProjectId = process.env.PLANWEAVE_DESKTOP_SMOKE_AUTHORITY_PROJECT_ID;
  if (!authorityProjectId) {
    throw new Error("Local collaboration smoke authority project id is required.");
  }
  return window.webContents.executeJavaScript(`
    (async () => {
      const runtime = window.planweave;
      const collaboration = window.planweaveCollaboration;
      if (!runtime || !collaboration) {
        throw new Error("Packaged local collaboration bridges are unavailable.");
      }
      const projects = await runtime.listProjects();
      const project = projects.find(
        (item) => typeof item.projectId === "string" && typeof item.activeCanvasId === "string"
      );
      if (!project || !project.activeCanvasId) {
        throw new Error("Packaged smoke project selection is unavailable.");
      }
      const selection = { projectId: project.projectId, canvasId: project.activeCanvasId };
      const scopeCatalog = await collaboration.setLocalCollaborationTrustedScopes({
        scopes: [selection]
      });
      if (scopeCatalog.selectedCount !== 1) {
        throw new Error("Local collaboration scope selection was not persisted.");
      }
      const activated = await collaboration.getLocalCollaborationServerStatus();
      if (activated.state !== "running") {
        throw new Error("Local collaboration server did not start automatically for the selected canvas.");
      }
      const registration = await collaboration.registerLocalCollaborationCurrentProject({
        selection
      });
      if (
        registration.projectId !== ${JSON.stringify(authorityProjectId)} ||
        registration.canvasId !== selection.canvasId
      ) {
        throw new Error("Local collaboration registration did not use the explicit canvas selection.");
      }
      const invitation = await collaboration.createCollaborationInvitation({
        idempotencyKey: crypto.randomUUID()
      });
      if (!/^pw_inv_[A-Za-z0-9_-]{43}$/.test(invitation.invitationToken)) {
        throw new Error("Local collaboration did not create a complete invitation token.");
      }
      const trustedScopes = await collaboration.listLocalCollaborationTrustedScopes();
      const matchingScopes = trustedScopes.filter(
        (scope) =>
          scope.projectId === ${JSON.stringify(authorityProjectId)} &&
          scope.canvasId === selection.canvasId
      );
      if (matchingScopes.length !== 1) {
        throw new Error("Local collaboration server did not expose exactly one selected trusted scope.");
      }
      if (!activated.profile) {
        throw new Error("Local collaboration server did not expose a profile after activation.");
      }
      let collaborationStatus = await collaboration.getCollaborationStatus();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activeProfile = collaborationStatus.profiles.find(
          (profile) => profile.profileId === collaborationStatus.activeProfileId
        );
        if (
          activeProfile?.serverBaseUrl === activated.profile.serverBaseUrl &&
          activeProfile?.projectId === ${JSON.stringify(authorityProjectId)} &&
          ["connected", "ready"].includes(collaborationStatus.session.phase)
        ) {
          break;
        }
        if (collaborationStatus.session.phase === "error") {
          throw new Error(
            "Local collaboration owner session failed: " +
              (collaborationStatus.session.lastErrorCode ?? "unknown_error")
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        collaborationStatus = await collaboration.getCollaborationStatus();
      }
      const activeProfile = collaborationStatus.profiles.find(
        (profile) => profile.profileId === collaborationStatus.activeProfileId
      );
      if (
        activeProfile?.serverBaseUrl !== activated.profile.serverBaseUrl ||
        activeProfile?.projectId !== ${JSON.stringify(authorityProjectId)} ||
        !["connected", "ready"].includes(collaborationStatus.session.phase)
      ) {
        throw new Error(
          "Local collaboration owner session was not restored automatically: " +
            JSON.stringify({
              activeProfileMatchesServer:
                activeProfile?.serverBaseUrl === activated.profile.serverBaseUrl,
              activeProfileMatchesProject:
                activeProfile?.projectId === ${JSON.stringify(authorityProjectId)},
              phase: collaborationStatus.session.phase,
              detail: collaborationStatus.session.detail,
              lastErrorCode: collaborationStatus.session.lastErrorCode
            })
        );
      }
      const members = await collaboration.listCollaborationMembers({ cursor: 0, limit: 20 });
      const owner = members.items.find((member) => member.role === "owner");
      if (!owner) {
        throw new Error("Local collaboration activation did not expose its owner membership.");
      }
      const result = {
        selectedProjectId: selection.projectId,
        authorityProjectId: ${JSON.stringify(authorityProjectId)},
        selectedCanvasId: selection.canvasId,
        statusAfterActivation: activated.state,
        sessionPhase: collaborationStatus.session.phase,
        completeInvitationCreated: true,
        trustedScope: {
          workspaceId: matchingScopes[0].workspaceId,
          projectId: matchingScopes[0].projectId,
          canvasId: matchingScopes[0].canvasId
        },
        ownerMembership: { role: owner.role }
      };
      const serialized = JSON.stringify(result);
      if (serialized.includes("projectRoot") || serialized.includes("pw_operator_")) {
        throw new Error("Local collaboration smoke result leaked a root path or operator token.");
      }
      return result;
    })()
  `) as Promise<Record<string, unknown>>;
}

async function waitForCollaborationInspectorWindow(
  mainWindow: BrowserWindow
): Promise<BrowserWindow> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const inspector = BrowserWindow.getAllWindows().find((candidate) => {
      if (candidate === mainWindow || candidate.isDestroyed()) return false;
      return candidate.webContents.getURL().includes("window=block-inspector");
    });
    if (inspector) return inspector;
    await wait(50);
  }
  throw new Error("Collaboration accessibility smoke did not open the block inspector window.");
}

async function readChromiumAccessibilityTree(window: BrowserWindow): Promise<ChromiumAxTree> {
  const debuggerSession = window.webContents.debugger;
  const attachedHere = !debuggerSession.isAttached();
  if (attachedHere) debuggerSession.attach("1.3");
  try {
    return (await debuggerSession.sendCommand("Accessibility.getFullAXTree")) as ChromiumAxTree;
  } finally {
    if (attachedHere && debuggerSession.isAttached()) debuggerSession.detach();
  }
}

async function runCollaborationAccessibilitySmoke(
  mainWindow: BrowserWindow,
  liveCollaboration: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (liveCollaboration.keyboardOpenedPeopleView !== true) {
    throw new Error("People keyboard action did not open the member page in Chromium.");
  }
  const waitForLocalizedPeopleLabel = async (prefix: string): Promise<string> =>
    (await mainWindow.webContents.executeJavaScript(`
      (async () => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const navigation = document.querySelector('[data-testid="sidebar-people"]');
          const label = navigation?.textContent?.trim() ?? "";
          if (label.startsWith(${JSON.stringify(prefix)})) return label;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("Timed out waiting for localized People accessible name: " + ${JSON.stringify(prefix)});
      })()
    `)) as string;
  await mainWindow.webContents.executeJavaScript(`
    window.planweaveDesktopSettings.saveDesktopSettings({ language: "en" })
  `);
  await reloadSmokeRenderer(mainWindow, { requireCollaborationShell: true });
  const enAccessibleName = await waitForLocalizedPeopleLabel("Workspace");
  await mainWindow.webContents.executeJavaScript(`
    window.planweaveDesktopSettings.saveDesktopSettings({ language: "zh-CN" })
  `);
  await reloadSmokeRenderer(mainWindow, { requireCollaborationShell: true });
  const zhAccessibleName = await waitForLocalizedPeopleLabel("工作空间");
  const localization = {
    stableTestId: "sidebar-people",
    enAccessibleName,
    zhAccessibleName,
    enVisible: true,
    zhVisible: true
  };

  const projectRoot = process.env.PLANWEAVE_DESKTOP_SMOKE_PROJECT_ROOT;
  if (!projectRoot)
    throw new Error("PLANWEAVE_DESKTOP_SMOKE_PROJECT_ROOT is required for AX smoke.");
  const resolvedProjectRoot = await realpath(projectRoot);
  await mainWindow.webContents.executeJavaScript(`
    window.planweave.openBlockInspectorWindow({
      blockRef: "T-001#B-001",
      canvas: { projectRoot: ${JSON.stringify(resolvedProjectRoot)}, canvasId: "default" },
      language: "zh-CN"
    })
  `);
  const inspector = await waitForCollaborationInspectorWindow(mainWindow);
  await inspector.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      let attempt = 0;
      const check = () => {
        const panel = document.querySelector('[data-testid="work-item-collaboration-panel"]');
        if (panel) {
          resolve(true);
          return;
        }
        attempt += 1;
        if (attempt >= 100) {
          reject(new Error("Inspector collaboration panel did not render."));
          return;
        }
        setTimeout(check, 50);
      };
      check();
    })
  `);

  const focusTabAndPressEnter = async (testId: string): Promise<boolean> => {
    app.focus({ steal: true });
    inspector.show();
    inspector.focus();
    inspector.webContents.focus();
    await wait(50);
    await inspector.webContents.executeJavaScript(`
      (() => {
        const tab = document.querySelector('[data-testid="${testId}"]');
        if (!(tab instanceof HTMLElement)) throw new Error("Missing collaboration tab: ${testId}");
        tab.focus();
        return true;
      })()
    `);
    inspector.webContents.sendInputEvent({ type: "keyDown", keyCode: "ENTER" });
    inspector.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    inspector.webContents.sendInputEvent({ type: "keyUp", keyCode: "ENTER" });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const selected = (await inspector.webContents.executeJavaScript(`
        document.querySelector('[data-testid="${testId}"]')?.getAttribute("aria-selected") === "true"
      `)) as boolean;
      if (selected) return true;
      await wait(25);
    }
    return false;
  };

  const commentsKeyboardAction = await focusTabAndPressEnter("collaboration-tab-comments");
  if (!commentsKeyboardAction) throw new Error("Comments tab keyboard action was not reflected.");
  const commentsAx = summarizeChromiumAccessibilityTree(
    await readChromiumAccessibilityTree(inspector),
    ["评论", "Comments"],
    { allowedRoles: ["group", "region"] }
  );

  const burst = (await inspector.webContents.executeJavaScript(`
    (async () => {
      const waitFor = async (predicate, label) => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const value = predicate();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("Timed out waiting for " + label);
      };
      const collaboration = window.planweaveCollaboration;
      if (!collaboration) throw new Error("Inspector collaboration bridge is unavailable.");
      const workItem = { kind: "block", canvasId: "default", blockRef: "T-001#B-001" };
      const burstSize = 12;
      const marker = "Desktop smoke bounded burst ";
      let observerEventCount = 0;
      let firstObserverEventAt = null;
      const stopObserving = collaboration.onCollaborationObserverSignal((signal) => {
        if (signal.type === "human.observer.event") {
          observerEventCount += 1;
          firstObserverEventAt ??= performance.now();
        }
      });
      const burstStartedAt = performance.now();
      await Promise.all(
        Array.from({ length: burstSize }, (_, index) =>
          collaboration.createCollaborationComment({
            workItem,
            body: marker + String(index)
          })
        )
      );
      await waitFor(() => observerEventCount >= burstSize, "observer burst events");
      await waitFor(
        () => [...document.querySelectorAll('[data-testid="comments-item-body"]')].some(
          (row) => (row.textContent ?? "").includes(marker)
        ),
        "authoritative comment refresh in renderer"
      );
      const observerToRenderMs =
        firstObserverEventAt === null ? null : Math.round(performance.now() - firstObserverEventAt);
      if (observerToRenderMs === null || observerToRenderMs > 5_000) {
        throw new Error("Observer to authoritative renderer refresh exceeded 5000ms.");
      }
      const readAllComments = async () => {
        const items = [];
        let cursor;
        for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
          const query = { workItem, limit: 50 };
          if (cursor) query.cursor = cursor;
          const page = await collaboration.listCollaborationComments(query);
          items.push(...page.items);
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
        return items;
      };
      const comments = await readAllComments();
      if (comments.length < burstSize) throw new Error("Authoritative comment count was below burst size.");
      const activity = await collaboration.listCollaborationActivity({ workItem, limit: 50 });
      const domRowCount = document.querySelectorAll('[data-testid="comments-item"]').length;
      if (domRowCount === 0 || domRowCount > 50) throw new Error("Comment DOM row bound was violated.");
      stopObserving();
      return {
        burstSize,
        authoritativeCommentCount: comments.length,
        authoritativeActivityCount: activity.items.length,
        observerEventCount,
        observerToRenderMs,
        domRowCount,
        burstDurationMs: Math.round(performance.now() - burstStartedAt),
        budgetMs: 5_000
      };
    })()
  `)) as Record<string, unknown>;

  const activityKeyboardAction = await focusTabAndPressEnter("collaboration-tab-activity");
  if (!activityKeyboardAction) throw new Error("Activity tab keyboard action was not reflected.");
  const activityAx = summarizeChromiumAccessibilityTree(
    await readChromiumAccessibilityTree(inspector),
    ["活动", "Activity"],
    { allowedRoles: ["group", "region"] }
  );
  app.focus({ steal: true });
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.focus();
  await wait(50);
  await mainWindow.webContents.executeJavaScript(`
    (async () => {
      const navigation = document.querySelector('[data-testid="sidebar-people"]');
      if (!(navigation instanceof HTMLElement)) throw new Error("Missing People navigation for AX smoke.");
      navigation.click();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const membersTab = document.querySelector('[data-testid="people-section-members"]');
        if (membersTab instanceof HTMLElement) {
          membersTab.focus();
          membersTab.click();
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (document.querySelector('[data-testid="people-panel"]')) return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Timed out opening People surface for AX smoke.");
    })()
  `);
  const peopleAx = summarizeChromiumAccessibilityTree(
    await readChromiumAccessibilityTree(mainWindow),
    ["成员", "Members"],
    { allowedRoles: ["dialog", "group", "region"] }
  );
  for (const [label, summary] of Object.entries({
    people: peopleAx,
    comments: commentsAx,
    activity: activityAx
  })) {
    if (!summary.namedRegion || !summary.liveRegion || summary.roleNamePairs === 0) {
      throw new Error(
        `Chromium accessibility tree did not expose a named live region for ${label}`
      );
    }
  }
  return {
    locale: localization,
    keyboard: {
      peopleAction: liveCollaboration.keyboardOpenedPeopleView === true,
      commentsAction: commentsKeyboardAction,
      activityAction: activityKeyboardAction
    },
    chromiumAxTree: {
      people: peopleAx,
      comments: commentsAx,
      activity: activityAx
    },
    boundedBurst: burst,
    osVoiceOverOrNvda: "not_run"
  };
}

async function writeExternalPromptSmokeChange(): Promise<void> {
  const promptPath = process.env.PLANWEAVE_DESKTOP_SMOKE_EXTERNAL_PROMPT_PATH;
  if (!promptPath) {
    throw new Error("PLANWEAVE_DESKTOP_SMOKE_EXTERNAL_PROMPT_PATH is required for desktop smoke.");
  }
  await writeFile(promptPath, "# Smoke external prompt change\n", "utf8");
}

async function reloadSmokeRenderer(
  window: BrowserWindow,
  options: { requireCollaborationShell?: boolean } = {}
): Promise<void> {
  await new Promise<void>((resolve) => {
    window.webContents.once("did-finish-load", resolve);
    window.webContents.reload();
  });
  await window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      let attempt = 0;
      const checkReady = () => {
        const graph = document.querySelector('[data-graph-surface][data-project-loading="false"]');
        const graphReady = graph && document.querySelector('[data-auto-run-control]');
        const collaborationShellReady =
          ${JSON.stringify(options.requireCollaborationShell === true)} &&
          document.querySelector('[data-testid="sidebar-people"]');
        if (graphReady || collaborationShellReady) {
          resolve(true);
          return;
        }
        attempt += 1;
        if (attempt >= 100) {
          reject(
            new Error(
              "Reloaded renderer did not finish loading the smoke project: " +
                JSON.stringify({
                  rootMounted: Boolean(document.querySelector("#root")?.childElementCount),
                  graphReady: Boolean(graphReady),
                  collaborationShellReady: Boolean(collaborationShellReady),
                  autoRunControl: Boolean(document.querySelector("[data-auto-run-control]")),
                  peopleNavigation: Boolean(document.querySelector('[data-testid="sidebar-people"]'))
                })
            )
          );
          return;
        }
        setTimeout(checkReady, 100);
      };
      checkReady();
    })
  `);
}

export async function runSmokeCheck(window: BrowserWindow): Promise<void> {
  const localCollaborationOnly = process.env.PLANWEAVE_DESKTOP_SMOKE_LOCAL_COLLABORATION === "1";
  const requiredText = ["Implement a tiny example change", "Task Node"];
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = await readSmokeState(window);
    const missingText = requiredText.filter((text) => !state.pageText.includes(text));
    if (
      missingText.length === 0 &&
      state.autoRunControlAvailable &&
      state.bridgeAvailable &&
      !state.nodeRequireAvailable
    ) {
      let workflow: Record<string, unknown>;
      let rendererManual: Record<string, unknown>;
      try {
        if (localCollaborationOnly) {
          workflow = { localCollaboration: await runLocalCollaborationSmoke(window) };
          rendererManual = {};
          console.log(
            JSON.stringify({
              event: "PLANWEAVE_DESKTOP_SMOKE_READY",
              bridgeAvailable: state.bridgeAvailable,
              nodeRequireAvailable: state.nodeRequireAvailable,
              autoRunControlAvailable: state.autoRunControlAvailable,
              workflow,
              rendererManual
            })
          );
          app.exit(0);
          return;
        }
        workflow = await runSmokeWorkflow(window);
        await reloadSmokeRenderer(window);
        await writeExternalPromptSmokeChange();
        rendererManual = await runRendererManualSmoke(window);
        const liveCollaboration =
          process.env.PLANWEAVE_DESKTOP_SMOKE_COLLABORATION_SERVER_URL &&
          process.env.PLANWEAVE_DESKTOP_SMOKE_COLLABORATION_PROJECT_ID
            ? await runLiveCollaborationSmoke(window)
            : null;
        const collaborationAccessibility = liveCollaboration
          ? await runCollaborationAccessibilitySmoke(window, liveCollaboration)
          : null;
        workflow = { ...workflow, liveCollaboration, collaborationAccessibility };
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "PLANWEAVE_DESKTOP_SMOKE_WORKFLOW_FAILED",
            message: error instanceof Error ? error.message : String(error),
            ...(localCollaborationOnly
              ? {}
              : { projectRoot: process.env.PLANWEAVE_DESKTOP_SMOKE_PROJECT_ROOT })
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
      ...(localCollaborationOnly
        ? {}
        : { projectRoot: process.env.PLANWEAVE_DESKTOP_SMOKE_PROJECT_ROOT })
    })
  );
  app.exit(1);
}
