import { app, BrowserWindow } from "electron";
import { realpath, writeFile } from "node:fs/promises";
import { z } from "zod";

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
      await clickByTestId("settings-nav-agents");
      await waitForSelector('[data-testid="settings-section-agents"]', "agent settings section");
      covered.push("open-settings-sections");
      await clickByTestId("settings-back-to-app");
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
      await waitForText("ready");
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

async function writeExternalPromptSmokeChange(): Promise<void> {
  const promptPath = process.env.PLANWEAVE_DESKTOP_SMOKE_EXTERNAL_PROMPT_PATH;
  if (!promptPath) {
    throw new Error("PLANWEAVE_DESKTOP_SMOKE_EXTERNAL_PROMPT_PATH is required for desktop smoke.");
  }
  await writeFile(promptPath, "# Smoke external prompt change\n", "utf8");
}

async function reloadSmokeRenderer(window: BrowserWindow): Promise<void> {
  await new Promise<void>((resolve) => {
    window.webContents.once("did-finish-load", resolve);
    window.webContents.reload();
  });
  await window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      let attempt = 0;
      const checkReady = () => {
        const graph = document.querySelector('[data-graph-surface][data-project-loading="false"]');
        if (graph && document.querySelector('[data-auto-run-control]')) {
          resolve(true);
          return;
        }
        attempt += 1;
        if (attempt >= 100) {
          reject(new Error("Reloaded renderer did not finish loading the smoke project."));
          return;
        }
        setTimeout(checkReady, 100);
      };
      checkReady();
    })
  `);
}

export async function runSmokeCheck(window: BrowserWindow): Promise<void> {
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
        workflow = await runSmokeWorkflow(window);
        await reloadSmokeRenderer(window);
        await writeExternalPromptSmokeChange();
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
