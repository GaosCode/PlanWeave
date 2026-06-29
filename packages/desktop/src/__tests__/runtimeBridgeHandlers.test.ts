import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { autoRunChangedChannel, desktopBridgeInvokeChannels } from "../shared/ipcChannels";

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown;
type AutoRunEventListener = (event: unknown) => void;
type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

const childProcessMock = vi.hoisted(() => ({
  execFile: vi.fn()
}));

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, RegisteredHandler>();
  const windows: Array<{ webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> } }> = [];
  return {
    handlers,
    windows,
    userDataDir: "/tmp/planweave-desktop-test",
    app: {
      getPath: vi.fn((name: string) => {
        if (name !== "userData") {
          throw new Error(`Unexpected Electron app path '${name}'.`);
        }
        return electronMock.userDataDir;
      }),
      getFileIcon: vi.fn(async () => ({
        toDataURL: () => "data:image/png;base64,terminal-icon"
      }))
    },
    ipcMain: {
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      })
    },
    BrowserWindow: {
      fromWebContents: vi.fn(),
      getAllWindows: vi.fn(() => windows)
    },
    shell: {
      openPath: vi.fn(),
      showItemInFolder: vi.fn()
    }
  };
});

const runtimeMock = vi.hoisted(() => {
  const autoRunEventListeners = new Set<AutoRunEventListener>();
  return {
    autoRunEventListeners,
    getDesktopProjectSnapshot: vi.fn(async (ref: unknown) => ({ ref })),
    getGraphViewModel: vi.fn(async (workspace: unknown) => ({ workspace })),
    getRunRecord: vi.fn(async () => ({
      recordId: "T-001#B-001::RUN-001",
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-001",
      executor: "codex",
      adapter: "codex-exec",
      executionCwd: "/tmp/project",
      projectRoot: "/tmp/project",
      agentSessionId: null,
      codexSessionId: null,
      tmuxSessionId: "planweave-T-001-B-001-RUN-001-abcd1234",
      tmuxAttachCommand: "tmux attach-session -t planweave-T-001-B-001-RUN-001-abcd1234",
      tmuxReadOnlyAttachCommand: "tmux attach-session -r -t planweave-T-001-B-001-RUN-001-abcd1234",
      exitCode: null,
      startedAt: null,
      finishedAt: null,
      promptPath: null,
      reportPath: null,
      metadataPath: "/tmp/project/results/T-001/blocks/B-001/runs/RUN-001/metadata.json",
      stdoutSummary: "",
      stderrSummary: "",
      promptMarkdown: "",
      reportMarkdown: "",
      displayMarkdown: "",
      displayMarkdownSource: "none",
      metadata: {
        tmuxSessionName: "planweave-T-001-B-001-RUN-001-abcd1234"
      }
    })),
    resetDesktopRuntimeState: vi.fn(async (projectRoot: string, canvasId: string | null | undefined, options: unknown) => ({
      projectRoot,
      canvasId,
      options
    })),
    resolveProjectCanvasWorkspace: vi.fn(async (projectRoot: string, canvasId: string) => ({
      projectRoot,
      canvasId,
      source: "project"
    })),
    resolveTaskCanvasWorkspace: vi.fn(async (projectRoot: string, canvasId?: string | null) => ({
      projectRoot,
      canvasId,
      source: "task"
    })),
    testExecutorProfile: vi.fn(async (options: unknown) => ({
      name: "codex",
      adapter: "codex-exec",
      ok: true,
      message: "executor preflight passed",
      checks: [],
      options
    })),
    subscribeAutoRunEvents: vi.fn((listener: AutoRunEventListener) => {
      autoRunEventListeners.add(listener);
      return () => autoRunEventListeners.delete(listener);
    })
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: childProcessMock.execFile
  };
});

vi.mock("electron", () => ({
  app: electronMock.app,
  BrowserWindow: electronMock.BrowserWindow,
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: electronMock.ipcMain,
  shell: electronMock.shell
}));

vi.mock("@planweave-ai/runtime", async () => {
  const actual = await vi.importActual<typeof import("@planweave-ai/runtime")>("@planweave-ai/runtime");
  return {
    ...actual,
    getDesktopProjectSnapshot: runtimeMock.getDesktopProjectSnapshot,
    getGraphViewModel: runtimeMock.getGraphViewModel,
    getRunRecord: runtimeMock.getRunRecord,
    resetDesktopRuntimeState: runtimeMock.resetDesktopRuntimeState,
    resolveProjectCanvasWorkspace: runtimeMock.resolveProjectCanvasWorkspace,
    resolveTaskCanvasWorkspace: runtimeMock.resolveTaskCanvasWorkspace,
    testExecutorProfile: runtimeMock.testExecutorProfile,
    subscribeAutoRunEvents: runtimeMock.subscribeAutoRunEvents
  };
});

describe("runtime bridge handlers", () => {
  beforeEach(async () => {
    vi.resetModules();
    await rm(electronMock.userDataDir, { recursive: true, force: true });
    electronMock.userDataDir = await mkdtemp(join(tmpdir(), "planweave-terminal-prefs-"));
    electronMock.handlers.clear();
    electronMock.windows.length = 0;
    electronMock.app.getPath.mockClear();
    electronMock.app.getFileIcon.mockClear();
    electronMock.ipcMain.handle.mockClear();
    electronMock.BrowserWindow.fromWebContents.mockClear();
    electronMock.BrowserWindow.getAllWindows.mockClear();
    electronMock.shell.openPath.mockClear();
    electronMock.shell.showItemInFolder.mockClear();
    childProcessMock.execFile.mockReset();
    childProcessMock.execFile.mockImplementation((_command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
      callback(null, "", "");
    });
    delete process.env.PLANWEAVE_DESKTOP_SMOKE;
    runtimeMock.autoRunEventListeners.clear();
    runtimeMock.getDesktopProjectSnapshot.mockClear();
    runtimeMock.getGraphViewModel.mockClear();
    runtimeMock.getRunRecord.mockClear();
    runtimeMock.resetDesktopRuntimeState.mockClear();
    runtimeMock.resolveProjectCanvasWorkspace.mockClear();
    runtimeMock.resolveTaskCanvasWorkspace.mockClear();
    runtimeMock.testExecutorProfile.mockClear();
    runtimeMock.subscribeAutoRunEvents.mockClear();
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

    registerRuntimeBridgeHandlers();
    registerPackageWatchHandlers();

    expect(new Set(electronMock.handlers.keys())).toEqual(new Set(Object.values(desktopBridgeInvokeChannels)));
    expect(electronMock.handlers.has(desktopBridgeInvokeChannels.watchPackageFiles)).toBe(true);
    expect(electronMock.handlers.has(desktopBridgeInvokeChannels.unwatchPackageFiles)).toBe(true);
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

    expect(electronMock.shell.openPath).not.toHaveBeenCalled();
    expect(electronMock.shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("detects terminal apps with icon data from application bundle icons", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const pngBytes = Buffer.from("terminal-icon-png");
    childProcessMock.execFile.mockImplementation((command: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
      if (command === "/usr/bin/sips") {
        const outputPath = args.at(-1);
        if (!outputPath) {
          callback(new Error("Missing sips output path."), "", "");
          return;
        }
        void writeFile(outputPath, pngBytes).then(
          () => callback(null, "", ""),
          (caught: unknown) => callback(caught instanceof Error ? caught : new Error(String(caught)), "", "")
        );
        return;
      }
      callback(null, "", "");
    });
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    try {
      const result = await electronMock.handlers.get(desktopBridgeInvokeChannels.detectTerminalApps)?.(null);

      expect(result).toEqual([
        {
          appId: "terminal",
          label: "Terminal",
          available: true,
          iconDataUrl: `data:image/png;base64,${pngBytes.toString("base64")}`,
          unavailableReason: null
        },
        {
          appId: "iterm2",
          label: "iTerm2",
          available: true,
          iconDataUrl: `data:image/png;base64,${pngBytes.toString("base64")}`,
          unavailableReason: null
        },
        {
          appId: "ghostty",
          label: "Ghostty",
          available: true,
          iconDataUrl: `data:image/png;base64,${pngBytes.toString("base64")}`,
          unavailableReason: null
        }
      ]);
      expect(childProcessMock.execFile).toHaveBeenCalledWith(
        "/usr/bin/sips",
        ["-z", "64", "64", "-s", "format", "png", "/System/Applications/Utilities/Terminal.app/Contents/Resources/Terminal.icns", "--out", expect.stringMatching(/terminal\.png$/)],
        { timeout: 5_000, maxBuffer: 64 * 1024 },
        expect.any(Function)
      );
      expect(electronMock.app.getFileIcon).not.toHaveBeenCalled();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("returns unavailable terminal apps without failing detection", async () => {
    childProcessMock.execFile.mockImplementation((command: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
      if (command === "/usr/bin/open" && args[0] === "-Ra" && args[1] === "Ghostty") {
        callback(new Error("Unable to find application named 'Ghostty'"), "", "");
        return;
      }
      callback(null, "", "");
    });
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    const result = await electronMock.handlers.get(desktopBridgeInvokeChannels.detectTerminalApps)?.(null);

    expect(result).toEqual(
      expect.arrayContaining([
        {
          appId: "ghostty",
          label: "Ghostty",
          available: false,
          iconDataUrl: null,
          unavailableReason: "Unable to find application named 'Ghostty'"
        }
      ])
    );
  });

  it("reads and updates terminal preferences in Electron user data", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(electronMock.handlers.get(desktopBridgeInvokeChannels.getTerminalPreferences)?.(null)).resolves.toEqual({
      defaultTerminalAppId: null
    });

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.updateTerminalPreferences)?.(null, {
        defaultTerminalAppId: "ghostty"
      })
    ).resolves.toEqual({
      defaultTerminalAppId: "ghostty"
    });

    await expect(electronMock.handlers.get(desktopBridgeInvokeChannels.getTerminalPreferences)?.(null)).resolves.toEqual({
      defaultTerminalAppId: "ghostty"
    });
    await expect(readFile(join(electronMock.userDataDir, "terminal-preferences.json"), "utf8")).resolves.toContain('"defaultTerminalAppId": "ghostty"');
  });

  it("rejects unsupported terminal preferences values", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.updateTerminalPreferences)?.(null, {
        defaultTerminalAppId: "wezterm"
      })
    ).rejects.toThrow("Terminal preferences defaultTerminalAppId is invalid.");
  });

  it("returns run terminal availability from live tmux sessions", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.getRunTerminalAvailability)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordIds: ["T-001#B-001::RUN-001"]
      })
    ).resolves.toEqual([
      {
        recordId: "T-001#B-001::RUN-001",
        tmuxSessionId: "planweave-T-001-B-001-RUN-001-abcd1234",
        available: true,
        unavailableReason: null
      }
    ]);
    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "tmux",
      ["has-session", "-t", "planweave-T-001-B-001-RUN-001-abcd1234"],
      { timeout: 2_000, env: process.env, maxBuffer: 64 * 1024 },
      expect.any(Function)
    );
  });

  it("marks stale run terminal metadata unavailable when the live tmux session is gone", async () => {
    childProcessMock.execFile.mockImplementation((command: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
      if (command === "tmux" && args[0] === "has-session") {
        callback(new Error("no such session"), "", "");
        return;
      }
      callback(null, "", "");
    });
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.getRunTerminalAvailability)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordIds: ["T-001#B-001::RUN-001"]
      })
    ).resolves.toEqual([
      {
        recordId: "T-001#B-001::RUN-001",
        tmuxSessionId: "planweave-T-001-B-001-RUN-001-abcd1234",
        available: false,
        unavailableReason: "tmux_session_not_running"
      }
    ]);
  });

  it("marks run terminal availability unavailable without tmux metadata", async () => {
    runtimeMock.getRunRecord.mockResolvedValueOnce({
      executionCwd: "/tmp/project",
      projectRoot: "/tmp/project",
      tmuxSessionId: null,
      metadata: {}
    });
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.getRunTerminalAvailability)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordIds: ["T-001#B-001::RUN-001"]
      })
    ).resolves.toEqual([
      {
        recordId: "T-001#B-001::RUN-001",
        tmuxSessionId: null,
        available: false,
        unavailableReason: "no_tmux_session"
      }
    ]);
  });

  it("rejects renderer-provided commands in run terminal availability requests", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.getRunTerminalAvailability)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordIds: ["T-001#B-001::RUN-001"],
        command: "tmux attach-session -t injected"
      })
    ).rejects.toThrow("Renderer must not provide terminal commands.");
  });

  it("rejects oversized run terminal availability requests", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.getRunTerminalAvailability)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordIds: Array.from({ length: 101 }, (_value, index) => `T-001#B-001::RUN-${index}`)
      })
    ).rejects.toThrow("Terminal availability recordIds must not exceed 100.");
  });

  it("opens a regular terminal at the run record cwd without tmux attach", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordId: "T-001#B-001::RUN-001",
        appId: "terminal"
      })
    ).resolves.toEqual({
      appId: "terminal",
      cwd: "/tmp/project"
    });

    expect(runtimeMock.resolveTaskCanvasWorkspace).toHaveBeenCalledWith("/tmp/project", "canvas-a");
    expect(runtimeMock.getRunRecord).toHaveBeenCalledWith(
      {
        projectRoot: "/tmp/project",
        canvasId: "canvas-a",
        source: "task"
      },
      "T-001#B-001::RUN-001"
    );
    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["-a", "Terminal", "/tmp/project"],
      { maxBuffer: 64 * 1024 },
      expect.any(Function)
    );
    expect(childProcessMock.execFile.mock.calls.some((call) => call[0] === "tmux")).toBe(false);
    expect(childProcessMock.execFile.mock.calls.some((call) => call[0] === "/usr/bin/osascript")).toBe(false);
  });

  it("opens regular iTerm2 and Ghostty windows at the run record cwd", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();
    runtimeMock.getRunRecord.mockResolvedValueOnce({
      executionCwd: "/tmp/Ecco the Dolphin",
      projectRoot: "/tmp/project"
    });

    await electronMock.handlers.get(desktopBridgeInvokeChannels.openTerminal)?.(null, {
      ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
      recordId: "T-001#B-001::RUN-001",
      appId: "iterm2"
    });

    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["-a", "iTerm", "/tmp/Ecco the Dolphin"],
      { maxBuffer: 64 * 1024 },
      expect.any(Function)
    );
    expect(childProcessMock.execFile.mock.calls.some((call) => call[0] === "/usr/bin/osascript")).toBe(false);

    childProcessMock.execFile.mockClear();
    runtimeMock.getRunRecord.mockResolvedValueOnce({
      executionCwd: "/tmp/Ecco the Dolphin",
      projectRoot: "/tmp/project"
    });
    await electronMock.handlers.get(desktopBridgeInvokeChannels.openTerminal)?.(null, {
      ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
      recordId: "T-001#B-001::RUN-001",
      appId: "ghostty"
    });

    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["-n", "-a", "Ghostty", "--args", "--working-directory=/tmp/Ecco the Dolphin"],
      { cwd: "/tmp/Ecco the Dolphin", maxBuffer: 64 * 1024 },
      expect.any(Function)
    );
    expect(childProcessMock.execFile.mock.calls.some((call) => call[0] === "tmux")).toBe(false);
  });

  it("opens a regular terminal at the project root when no run record is supplied", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        appId: "terminal"
      })
    ).resolves.toEqual({
      appId: "terminal",
      cwd: "/tmp/project"
    });

    expect(runtimeMock.getRunRecord).not.toHaveBeenCalled();
  });

  it("rejects renderer-provided commands in regular terminal open requests", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordId: "T-001#B-001::RUN-001",
        appId: "terminal",
        command: "tmux attach-session -t injected"
      })
    ).rejects.toThrow("Renderer must not provide terminal commands.");
  });

  it("opens a run terminal in smoke mode after validating app id, record, and tmux metadata", async () => {
    process.env.PLANWEAVE_DESKTOP_SMOKE = "1";
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openRunTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordId: "T-001#B-001::RUN-001",
        appId: "terminal"
      })
    ).resolves.toEqual({
      appId: "terminal",
      tmuxSessionId: "planweave-T-001-B-001-RUN-001-abcd1234",
      mode: "readOnly"
    });

    expect(runtimeMock.resolveTaskCanvasWorkspace).toHaveBeenCalledWith("/tmp/project", "canvas-a");
    expect(runtimeMock.getRunRecord).toHaveBeenCalledWith(
      {
        projectRoot: "/tmp/project",
        canvasId: "canvas-a",
        source: "task"
      },
      "T-001#B-001::RUN-001"
    );
    expect(
      childProcessMock.execFile.mock.calls.some((call) => call[0] === "/usr/bin/osascript" || (call[0] === "/usr/bin/open" && call[1]?.[0] === "-a"))
    ).toBe(false);
  });

  it("allows interactive terminal attach only when the mode is explicit and valid", async () => {
    process.env.PLANWEAVE_DESKTOP_SMOKE = "1";
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openRunTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordId: "T-001#B-001::RUN-001",
        appId: "iterm2",
        mode: "interactive"
      })
    ).resolves.toEqual({
      appId: "iterm2",
      tmuxSessionId: "planweave-T-001-B-001-RUN-001-abcd1234",
      mode: "interactive"
    });

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openRunTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordId: "T-001#B-001::RUN-001",
        appId: "iterm2",
        mode: "writeable"
      })
    ).rejects.toThrow("Terminal attach mode is invalid.");
  });

  it("rejects unknown terminal app ids and renderer-provided terminal commands", async () => {
    process.env.PLANWEAVE_DESKTOP_SMOKE = "1";
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openRunTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordId: "T-001#B-001::RUN-001",
        appId: "wezterm"
      })
    ).rejects.toThrow("Terminal app id is invalid.");

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openRunTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordId: "T-001#B-001::RUN-001",
        appId: "terminal",
        command: "tmux attach-session -t injected"
      })
    ).rejects.toThrow("Renderer must not provide terminal commands.");
  });

  it("rejects run terminal requests when the run record has no tmux metadata", async () => {
    process.env.PLANWEAVE_DESKTOP_SMOKE = "1";
    runtimeMock.getRunRecord.mockResolvedValueOnce({
      executionCwd: "/tmp/project",
      projectRoot: "/tmp/project",
      tmuxSessionId: null,
      metadata: {}
    });
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openRunTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordId: "T-001#B-001::RUN-001",
        appId: "terminal"
      })
    ).rejects.toThrow("Run record has no tmux session.");
  });

  it("launches Ghostty as a new macOS app instance before passing tmux args", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openRunTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordId: "T-001#B-001::RUN-001",
        appId: "ghostty"
      })
    ).resolves.toEqual({
      appId: "ghostty",
      tmuxSessionId: "planweave-T-001-B-001-RUN-001-abcd1234",
      mode: "readOnly"
    });

    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["-n", "-a", "Ghostty", "--args", "-e", "tmux", "attach-session", "-r", "-t", "planweave-T-001-B-001-RUN-001-abcd1234"],
      { cwd: "/tmp/project", maxBuffer: 64 * 1024 },
      expect.any(Function)
    );
  });

  it("does not swallow launcher failures outside desktop smoke mode", async () => {
    childProcessMock.execFile.mockImplementation((command: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
      if (command === "/usr/bin/open" && args[0] === "-Ra") {
        callback(null, "", "");
        return;
      }
      if (command === "tmux" && args[0] === "has-session") {
        callback(new Error("no such session"), "", "");
        return;
      }
      callback(null, "", "");
    });
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openRunTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordId: "T-001#B-001::RUN-001",
        appId: "terminal"
      })
    ).rejects.toThrow("tmux session does not exist.");
  });
});
