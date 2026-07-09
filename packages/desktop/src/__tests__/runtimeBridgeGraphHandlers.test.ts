import {
  getRuntimeBridgeMocks,
  resetRuntimeBridgeMocks,
  restoreRuntimeBridgeEnv
} from "./support/runtimeBridgeTestHarness.js";
import {
  autoRunChangedChannel,
  desktopBridgeInvokeChannels
} from "../shared/ipcChannels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { electronMock, runtimeMock } = getRuntimeBridgeMocks();

describe("runtime bridge handlers: graph and project", () => {
  beforeEach(async () => {
    await resetRuntimeBridgeMocks();
  });

  afterEach(async () => {
    await restoreRuntimeBridgeEnv();
  });

  it("resolves desktop canvas references through runtime task canvas workspace API", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    const handler = electronMock.handlers.get(desktopBridgeInvokeChannels.getGraphViewModel);
    expect(handler).toBeDefined();

    await handler?.(null, { projectRoot: "/tmp/project", canvasId: "canvas-a" });

    expect(runtimeMock.resolveTaskCanvasWorkspace).toHaveBeenCalledWith("/tmp/project", "canvas-a");
    expect(runtimeMock.resolveProjectCanvasWorkspace).not.toHaveBeenCalled();
    expect(runtimeMock.getGraphViewModel).toHaveBeenCalledWith({
      projectRoot: "/tmp/project",
      canvasId: "canvas-a",
      source: "task"
    });
  });

  it("passes desktop project snapshot requests to runtime without pre-resolving the canvas", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    const handler = electronMock.handlers.get(desktopBridgeInvokeChannels.getDesktopProjectSnapshot);
    expect(handler).toBeDefined();

    const ref = { projectRoot: "/tmp/project", canvasId: "canvas-a" };
    await handler?.(null, ref);

    expect(runtimeMock.resolveTaskCanvasWorkspace).not.toHaveBeenCalled();
    expect(runtimeMock.getDesktopProjectSnapshot).toHaveBeenCalledWith(ref);
  });

  it("passes lightweight runtime refresh requests to runtime without pre-resolving the canvas", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    const handler = electronMock.handlers.get(desktopBridgeInvokeChannels.getDesktopRuntimeRefresh);
    expect(handler).toBeDefined();

    const ref = { projectRoot: "/tmp/project", canvasId: "canvas-a" };
    await handler?.(null, ref);

    expect(runtimeMock.resolveTaskCanvasWorkspace).not.toHaveBeenCalled();
    expect(runtimeMock.getDesktopRuntimeRefresh).toHaveBeenCalledWith(ref);
  });

  it("updates canvas execution policy through the resolved task canvas workspace", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    const ref = { projectRoot: "/tmp/project", canvasId: "canvas-a" };
    const input = { parallelEnabled: true, maxConcurrent: 3 };
    await expect(electronMock.handlers.get(desktopBridgeInvokeChannels.updateCanvasExecutionPolicy)?.(null, ref, input)).resolves.toEqual({
      ok: true,
      affectedTasks: ["T-001"],
      diagnostics: []
    });

    expect(runtimeMock.resolveTaskCanvasWorkspace).toHaveBeenCalledWith("/tmp/project", "canvas-a");
    expect(runtimeMock.updateCanvasExecutionPolicy).toHaveBeenCalledWith(
      {
        projectRoot: "/tmp/project",
        canvasId: "canvas-a",
        source: "task"
      },
      input
    );
  });

  it("resolves desktop canvas references before loading graph diagnostics", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    const handler = electronMock.handlers.get(desktopBridgeInvokeChannels.getDesktopGraphDiagnostics);
    expect(handler).toBeDefined();

    await handler?.(null, { projectRoot: "/tmp/project", canvasId: "canvas-a" });

    expect(runtimeMock.resolveTaskCanvasWorkspace).toHaveBeenCalledWith("/tmp/project", "canvas-a");
    expect(runtimeMock.getDesktopGraphDiagnostics).toHaveBeenCalledWith({
      projectRoot: "/tmp/project",
      canvasId: "canvas-a",
      source: "task"
    });
  });

  it("resolves desktop canvas references before applying canvas lane layout", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    const handler = electronMock.handlers.get(desktopBridgeInvokeChannels.applyCanvasLaneLayout);
    expect(handler).toBeDefined();

    await handler?.(null, { projectRoot: "/tmp/project", canvasId: "canvas-a" });

    expect(runtimeMock.resolveTaskCanvasWorkspace).toHaveBeenCalledWith("/tmp/project", "canvas-a");
    expect(runtimeMock.applyCanvasLaneLayout).toHaveBeenCalledWith({
      projectRoot: "/tmp/project",
      canvasId: "canvas-a",
      source: "task"
    });
  });

  it("passes runtime reset requests to the runtime desktop API without pre-resolving the canvas", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    const handler = electronMock.handlers.get(desktopBridgeInvokeChannels.resetRuntimeState);
    expect(handler).toBeDefined();

    const ref = { projectRoot: "/tmp/project", canvasId: "canvas-a" };
    const options = { force: true, reason: "test reset" };
    await handler?.(null, ref, options);

    expect(runtimeMock.resolveTaskCanvasWorkspace).not.toHaveBeenCalled();
    expect(runtimeMock.resetDesktopRuntimeState).toHaveBeenCalledWith("/tmp/project", "canvas-a", options);
  });

  it("resolves canvas references before testing executor profiles", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    const handler = electronMock.handlers.get(desktopBridgeInvokeChannels.testExecutorProfile);
    expect(handler).toBeDefined();

    await handler?.(null, { projectRoot: "/tmp/project", canvasId: "canvas-a" }, "codex");

    expect(runtimeMock.resolveTaskCanvasWorkspace).toHaveBeenCalledWith("/tmp/project", "canvas-a");
    expect(runtimeMock.testExecutorProfile).toHaveBeenCalledWith({
      projectRoot: {
        projectRoot: "/tmp/project",
        canvasId: "canvas-a",
        source: "task"
      },
      executorName: "codex"
    });
  });

  it("registers handlers for every desktop bridge invoke channel", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    const { registerPackageWatchHandlers } = await import("../main/packageWatch");
    const { registerRuntimeStateWatchHandlers } = await import("../main/runtimeStateWatch");

    registerRuntimeBridgeHandlers();
    registerPackageWatchHandlers();
    registerRuntimeStateWatchHandlers();

    expect(new Set(electronMock.handlers.keys())).toEqual(new Set(Object.values(desktopBridgeInvokeChannels)));
    expect(electronMock.handlers.has(desktopBridgeInvokeChannels.watchPackageFiles)).toBe(true);
    expect(electronMock.handlers.has(desktopBridgeInvokeChannels.unwatchPackageFiles)).toBe(true);
    expect(electronMock.handlers.has(desktopBridgeInvokeChannels.watchRuntimeState)).toBe(true);
    expect(electronMock.handlers.has(desktopBridgeInvokeChannels.unwatchRuntimeState)).toBe(true);
  });

  it("broadcasts auto-run runtime events to every active window once", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    const activeSend = vi.fn();
    const destroyedSend = vi.fn();
    electronMock.windows.push(
      { webContents: { isDestroyed: () => false, send: activeSend } },
      { webContents: { isDestroyed: () => true, send: destroyedSend } }
    );

    registerRuntimeBridgeHandlers();
    registerRuntimeBridgeHandlers();

    expect(runtimeMock.subscribeAutoRunEvents).toHaveBeenCalledTimes(1);
    const event = {
      projectRoot: "/tmp/project",
      canvasId: "canvas-a",
      runId: "RUN-001",
      phase: "running",
      eventType: "step_started"
    };
    for (const listener of runtimeMock.autoRunEventListeners) {
      listener(event);
    }

    expect(activeSend).toHaveBeenCalledWith(autoRunChangedChannel, event);
    expect(destroyedSend).not.toHaveBeenCalled();
  });

  it("does not open Finder from reveal handlers while desktop smoke is running", async () => {
    process.env.PLANWEAVE_DESKTOP_SMOKE = "1";
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await electronMock.handlers.get(desktopBridgeInvokeChannels.revealProjectInFinder)?.(null, "/tmp/project");
    await electronMock.handlers.get(desktopBridgeInvokeChannels.revealPathInFinder)?.(null, "/tmp/project/.planweave/runs/RUN-001/metadata.json");
    await electronMock.handlers.get(desktopBridgeInvokeChannels.revealTaskCanvasInFinder)?.(null, "/tmp/project", "canvas-a");

    expect(electronMock.shell.openPath).not.toHaveBeenCalled();
    expect(electronMock.shell.showItemInFolder).not.toHaveBeenCalled();
    expect(runtimeMock.resolveTaskCanvasWorkspace).not.toHaveBeenCalled();
  });

  it("opens resolved task canvas workspace directories in Finder", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    runtimeMock.resolveTaskCanvasWorkspace.mockResolvedValueOnce({
      projectRoot: "/tmp/project",
      canvasId: "canvas-a",
      source: "task",
      workspaceRoot: "/tmp/project/canvases/canvas-a"
    });
    registerRuntimeBridgeHandlers();

    await electronMock.handlers.get(desktopBridgeInvokeChannels.revealTaskCanvasInFinder)?.(null, "/tmp/project", "canvas-a");

    expect(runtimeMock.resolveTaskCanvasWorkspace).toHaveBeenCalledWith("/tmp/project", "canvas-a");
    expect(electronMock.shell.openPath).toHaveBeenCalledWith("/tmp/project/canvases/canvas-a");
    expect(electronMock.shell.showItemInFolder).not.toHaveBeenCalled();
  });
});
