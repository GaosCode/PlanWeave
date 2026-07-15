import { writeFile } from "node:fs/promises";
import {
  getRuntimeBridgeMocks,
  resetRuntimeBridgeMocks,
  restoreRuntimeBridgeEnv
} from "./support/runtimeBridgeTestHarness.js";
import {
  autoRunChangedChannel,
  desktopBridgeInvokeChannels,
  runnerRecordSubscribeChannel,
  runnerRecordUnsubscribeChannel
} from "../shared/ipcChannels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fileAccessMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, access: fileAccessMock };
});

const { childProcessMock, electronMock, runtimeMock } = getRuntimeBridgeMocks();
let platformSpy: ReturnType<typeof vi.spyOn>;

describe("runtime bridge handlers: graph and project", () => {
  beforeEach(async () => {
    await resetRuntimeBridgeMocks();
    fileAccessMock.mockClear();
    platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  });

  afterEach(async () => {
    platformSpy.mockRestore();
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

    const handler = electronMock.handlers.get(
      desktopBridgeInvokeChannels.getDesktopProjectSnapshot
    );
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
    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.updateCanvasExecutionPolicy)?.(
        null,
        ref,
        input
      )
    ).resolves.toEqual({
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

    const handler = electronMock.handlers.get(
      desktopBridgeInvokeChannels.getDesktopGraphDiagnostics
    );
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
    expect(runtimeMock.resetDesktopRuntimeState).toHaveBeenCalledWith(
      "/tmp/project",
      "canvas-a",
      options
    );
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

  it("probes canonical agent capabilities without resolving a canvas or manifest", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    const handler = electronMock.handlers.get(
      desktopBridgeInvokeChannels.probeDesktopAgentCapabilities
    );
    expect(handler).toBeDefined();
    const input = { agentKind: "codex", projectRoot: "/tmp/project" };

    await handler?.(null, input);

    expect(runtimeMock.resolveTaskCanvasWorkspace).not.toHaveBeenCalled();
    expect(runtimeMock.testExecutorProfile).not.toHaveBeenCalled();
    expect(runtimeMock.probeDesktopAgentCapabilities).toHaveBeenCalledWith(input);
  });

  it("registers handlers for every desktop bridge invoke channel", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    const { registerPackageWatchHandlers } = await import("../main/packageWatch");
    const { registerRuntimeStateWatchHandlers } = await import("../main/runtimeStateWatch");

    registerRuntimeBridgeHandlers();
    registerPackageWatchHandlers();
    registerRuntimeStateWatchHandlers();

    expect(new Set(electronMock.handlers.keys())).toEqual(
      new Set([
        ...Object.values(desktopBridgeInvokeChannels),
        runnerRecordSubscribeChannel,
        runnerRecordUnsubscribeChannel
      ])
    );
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

    await electronMock.handlers.get(desktopBridgeInvokeChannels.revealProjectInFinder)?.(
      null,
      "/tmp/project"
    );
    await electronMock.handlers.get(desktopBridgeInvokeChannels.openProjectInDevelopmentTool)?.(
      null,
      "/tmp/project",
      "vscode"
    );
    await electronMock.handlers.get(desktopBridgeInvokeChannels.revealPathInFinder)?.(
      null,
      "/tmp/project/.planweave/runs/RUN-001/metadata.json"
    );
    await electronMock.handlers.get(desktopBridgeInvokeChannels.revealTaskCanvasInFinder)?.(
      null,
      "/tmp/project",
      "canvas-a"
    );
    await electronMock.handlers.get(desktopBridgeInvokeChannels.revealTaskInFinder)?.(
      null,
      { projectRoot: "/tmp/project", canvasId: "canvas-a" },
      "T-001"
    );

    expect(electronMock.shell.openPath).not.toHaveBeenCalled();
    expect(electronMock.shell.openExternal).not.toHaveBeenCalled();
    expect(electronMock.shell.showItemInFolder).not.toHaveBeenCalled();
    expect(runtimeMock.resolveTaskCanvasWorkspace).not.toHaveBeenCalled();
    expect(runtimeMock.getTaskFileManagerPath).not.toHaveBeenCalled();
  });

  it("opens repository paths directly in the detected VS Code application", async () => {
    childProcessMock.execFile.mockImplementation(
      (
        command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) =>
        callback(
          null,
          command === "/usr/bin/mdfind" ? "/Resolved/Visual Studio Code.app\n" : "",
          ""
        )
    );
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await electronMock.handlers.get(desktopBridgeInvokeChannels.openProjectInDevelopmentTool)?.(
      null,
      "/tmp/project folder/repository#one",
      "vscode"
    );

    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["-a", "/Resolved/Visual Studio Code.app", "/tmp/project folder/repository#one"],
      { timeout: 2_000, maxBuffer: 64 * 1024 },
      expect.any(Function)
    );
    expect(electronMock.shell.openExternal).not.toHaveBeenCalled();
  });

  it("opens VS Code through its resolved executable path on Linux", async () => {
    platformSpy.mockReturnValue("linux");
    childProcessMock.execFile.mockImplementation(
      (
        command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => callback(null, command === "which" ? "/usr/local/bin/code\n" : "", "")
    );
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await electronMock.handlers.get(desktopBridgeInvokeChannels.openProjectInDevelopmentTool)?.(
      null,
      "/tmp/project",
      "vscode"
    );

    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "which",
      ["code"],
      { timeout: 2_000, maxBuffer: 64 * 1024 },
      expect.any(Function)
    );
    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "/usr/local/bin/code",
      ["/tmp/project"],
      { timeout: 2_000, maxBuffer: 64 * 1024 },
      expect.any(Function)
    );
  });

  it("prefers a directly executable VS Code binary on Windows", async () => {
    platformSpy.mockReturnValue("win32");
    const codeExecutable = "C:\\Program Files\\Microsoft VS Code\\Code.exe";
    childProcessMock.execFile.mockImplementation(
      (
        command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) =>
        callback(
          null,
          command === "where.exe" && args[0] === "Code.exe" ? `${codeExecutable}\r\n` : "",
          ""
        )
    );
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await electronMock.handlers.get(desktopBridgeInvokeChannels.openProjectInDevelopmentTool)?.(
      null,
      "C:\\work\\project",
      "vscode"
    );

    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "where.exe",
      ["Code.exe"],
      { timeout: 2_000, maxBuffer: 64 * 1024 },
      expect.any(Function)
    );
    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      codeExecutable,
      ["C:\\work\\project"],
      { timeout: 2_000, maxBuffer: 64 * 1024 },
      expect.any(Function)
    );
  });

  it("uses a Windows command shim only to locate the real executable", async () => {
    platformSpy.mockReturnValue("win32");
    const codeCommand = "C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd";
    const codeExecutable = "C:\\Program Files\\Microsoft VS Code\\Code.exe";
    const repositoryRoot = "C:\\work%name% & tools|review^(draft)";
    childProcessMock.execFile.mockImplementation(
      (
        command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (command === "where.exe" && args[0] === "Code.exe") {
          callback(new Error("Code.exe was not found"), "", "");
          return;
        }
        callback(
          null,
          command === "where.exe" && args[0] === "code.cmd" ? `${codeCommand}\r\n` : "",
          ""
        );
      }
    );
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await electronMock.handlers.get(desktopBridgeInvokeChannels.openProjectInDevelopmentTool)?.(
      null,
      repositoryRoot,
      "vscode"
    );

    expect(fileAccessMock).toHaveBeenCalledWith(codeExecutable);
    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      codeExecutable,
      [repositoryRoot],
      { timeout: 2_000, maxBuffer: 64 * 1024 },
      expect.any(Function)
    );
    expect(childProcessMock.execFile).not.toHaveBeenCalledWith(
      "cmd.exe",
      expect.anything(),
      expect.anything(),
      expect.any(Function)
    );
  });

  it("locates the real Cursor executable beside its Windows command shim", async () => {
    platformSpy.mockReturnValue("win32");
    const cursorCommand =
      "C:\\Users\\dev\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd";
    const cursorExecutable = "C:\\Users\\dev\\AppData\\Local\\Programs\\cursor\\Cursor.exe";
    childProcessMock.execFile.mockImplementation(
      (
        command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (command === "where.exe" && args[0] === "Cursor.exe") {
          callback(new Error("Cursor.exe was not found"), "", "");
          return;
        }
        callback(
          null,
          command === "where.exe" && args[0] === "cursor.cmd" ? `${cursorCommand}\r\n` : "",
          ""
        );
      }
    );
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await electronMock.handlers.get(desktopBridgeInvokeChannels.openProjectInDevelopmentTool)?.(
      null,
      "C:\\workspace",
      "cursor"
    );

    expect(fileAccessMock).toHaveBeenCalledWith(cursorExecutable);
    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      cursorExecutable,
      ["C:\\workspace"],
      { timeout: 2_000, maxBuffer: 64 * 1024 },
      expect.any(Function)
    );
  });

  it("opens the repository with the system file manager on every platform", async () => {
    platformSpy.mockReturnValue("win32");
    electronMock.shell.openPath.mockResolvedValue("");
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await electronMock.handlers.get(desktopBridgeInvokeChannels.openProjectInDevelopmentTool)?.(
      null,
      "C:\\work%name% & tools",
      "finder"
    );

    expect(electronMock.shell.openPath).toHaveBeenCalledWith("C:\\work%name% & tools");
    expect(childProcessMock.execFile).not.toHaveBeenCalled();
  });

  it("reuses the detected terminal launcher to open the repository directory", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await electronMock.handlers.get(desktopBridgeInvokeChannels.openProjectInDevelopmentTool)?.(
      null,
      "/tmp/project",
      "terminal"
    );

    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["-Ra", "Terminal"],
      { timeout: 2_000, maxBuffer: 64 * 1024 },
      expect.any(Function)
    );
    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["-a", "Terminal", "/tmp/project"],
      { maxBuffer: 64 * 1024 },
      expect.any(Function)
    );
  });

  it("rejects unsupported development tool ids before launching", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openProjectInDevelopmentTool)?.(
        null,
        "/tmp/project",
        "unknown-editor"
      )
    ).rejects.toThrow("Development tool id is invalid.");
    expect(childProcessMock.execFile).not.toHaveBeenCalled();
  });

  it("detects available development tools in preference order with native icons", async () => {
    childProcessMock.execFile.mockImplementation(
      async (
        command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (command === "/usr/bin/mdfind") {
          const bundleId = args[0]?.match(/'([^']+)'/u)?.[1] ?? "unknown.bundle";
          callback(null, `/Resolved/${bundleId}.app\n`, "");
          return;
        }
        if (command === "/usr/libexec/PlistBuddy") {
          callback(null, "ApplicationIcon\n", "");
          return;
        }
        if (command === "/usr/bin/sips") {
          const outputPath = args.at(-1);
          if (!outputPath) {
            callback(new Error("Icon output path is missing."), "", "");
            return;
          }
          await writeFile(outputPath, "native-development-tool-icon");
          callback(null, "", "");
          return;
        }
        callback(null, "", "");
      }
    );
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    const tools = (await electronMock.handlers.get(
      desktopBridgeInvokeChannels.detectDevelopmentTools
    )?.(null)) as Array<{
      toolId: string;
      label: string;
      available: boolean;
      iconDataUrl: string | null;
    }>;

    expect(tools.map((tool) => tool.toolId)).toEqual([
      "vscode",
      "cursor",
      "finder",
      "terminal",
      "iterm2",
      "ghostty",
      "xcode",
      "android-studio",
      "goland",
      "pycharm"
    ]);
    expect(tools).toContainEqual(
      expect.objectContaining({
        toolId: "finder",
        label: "Finder",
        available: true,
        iconDataUrl: `data:image/png;base64,${Buffer.from("native-development-tool-icon").toString(
          "base64"
        )}`
      })
    );
    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleIconFile", "/Resolved/com.apple.finder.app/Contents/Info.plist"],
      { timeout: 5_000, maxBuffer: 256 * 1024 },
      expect.any(Function)
    );
    expect(electronMock.app.getFileIcon).not.toHaveBeenCalled();
    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "/usr/bin/mdfind",
      [
        "kMDItemCFBundleIdentifier == 'com.jetbrains.pycharm' || " +
          "kMDItemCFBundleIdentifier == 'com.jetbrains.pycharm.ce'"
      ],
      { timeout: 5_000, maxBuffer: 256 * 1024 },
      expect.any(Function)
    );
    const applicationNames = new Set([
      "Visual Studio Code",
      "Cursor",
      "Finder",
      "Xcode",
      "Android Studio",
      "GoLand",
      "PyCharm"
    ]);
    expect(
      childProcessMock.execFile.mock.calls.some(
        (call) =>
          call[0] === "/usr/bin/osascript" ||
          (call[0] === "/usr/bin/open" && applicationNames.has(String(call[1]?.[1])))
      )
    ).toBe(false);

    await electronMock.handlers.get(desktopBridgeInvokeChannels.openProjectInDevelopmentTool)?.(
      null,
      "/tmp/goland-project",
      "goland"
    );
    await electronMock.handlers.get(desktopBridgeInvokeChannels.openProjectInDevelopmentTool)?.(
      null,
      "/tmp/pycharm-project",
      "pycharm"
    );

    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["-a", "/Resolved/com.jetbrains.goland.app", "/tmp/goland-project"],
      { timeout: 2_000, maxBuffer: 64 * 1024 },
      expect.any(Function)
    );
    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["-a", "/Resolved/com.jetbrains.pycharm.app", "/tmp/pycharm-project"],
      { timeout: 2_000, maxBuffer: 64 * 1024 },
      expect.any(Function)
    );
    expect(
      childProcessMock.execFile.mock.calls.filter(
        (call) =>
          call[0] === "/usr/bin/mdfind" && String(call[1]?.[0]).includes("com.jetbrains.goland")
      )
    ).toHaveLength(1);
    expect(
      childProcessMock.execFile.mock.calls.filter(
        (call) =>
          call[0] === "/usr/bin/mdfind" && String(call[1]?.[0]).includes("com.jetbrains.pycharm")
      )
    ).toHaveLength(1);
  });

  it("reports applications that cannot be resolved by the bundle index", async () => {
    childProcessMock.execFile.mockImplementation(
      (
        command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (command === "/usr/bin/mdfind") {
          const isCursor = args[0]?.includes("com.todesktop.230313mzl4w4u92") ?? false;
          callback(null, isCursor ? "" : "/Resolved/Application.app\n", "");
          return;
        }
        callback(null, "", "");
      }
    );
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    const tools = (await electronMock.handlers.get(
      desktopBridgeInvokeChannels.detectDevelopmentTools
    )?.(null)) as Array<{
      toolId: string;
      available: boolean;
      unavailableReason: string | null;
    }>;
    expect(tools.find((tool) => tool.toolId === "cursor")).toMatchObject({
      available: false,
      unavailableReason: "Cursor application bundle was not found."
    });
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

    await electronMock.handlers.get(desktopBridgeInvokeChannels.revealTaskCanvasInFinder)?.(
      null,
      "/tmp/project",
      "canvas-a"
    );

    expect(runtimeMock.resolveTaskCanvasWorkspace).toHaveBeenCalledWith("/tmp/project", "canvas-a");
    expect(electronMock.shell.openPath).toHaveBeenCalledWith("/tmp/project/canvases/canvas-a");
    expect(electronMock.shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("reveals the task prompt path resolved by runtime instead of assuming a node directory", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    runtimeMock.getTaskFileManagerPath.mockResolvedValueOnce(
      "/tmp/project/canvases/canvas-a/package/shared/P00.md"
    );
    registerRuntimeBridgeHandlers();

    await electronMock.handlers.get(desktopBridgeInvokeChannels.revealTaskInFinder)?.(
      null,
      { projectRoot: "/tmp/project", canvasId: "canvas-a" },
      "T-001"
    );

    expect(runtimeMock.resolveTaskCanvasWorkspace).toHaveBeenCalledWith("/tmp/project", "canvas-a");
    expect(runtimeMock.getTaskFileManagerPath).toHaveBeenCalledWith(
      { projectRoot: "/tmp/project", canvasId: "canvas-a", source: "task" },
      "T-001"
    );
    expect(electronMock.shell.showItemInFolder).toHaveBeenCalledWith(
      "/tmp/project/canvases/canvas-a/package/shared/P00.md"
    );
  });
});
