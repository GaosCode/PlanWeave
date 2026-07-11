import { vi } from "vitest";

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown;
type AutoRunEventListener = (event: unknown) => void;
type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

export function registeredHandler(channel: string): RegisteredHandler {
  const handler = electronMock.handlers.get(channel);
  if (!handler) {
    throw new Error(`Handler not registered for '${channel}'.`);
  }
  return handler;
}

const childProcessMock = vi.hoisted(() => ({
  execFile: vi.fn()
}));

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, RegisteredHandler>();
  const windows: Array<{
    webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
  }> = [];
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
    applyCanvasLaneLayout: vi.fn(async (workspace: unknown) => ({ workspace, nodes: [] })),
    getDesktopGraphDiagnostics: vi.fn(async (workspace: unknown) => ({
      workspace,
      diagnostics: []
    })),
    getDesktopProjectSnapshot: vi.fn(async (ref: unknown) => ({ ref })),
    getDesktopRuntimeRefresh: vi.fn(async (ref: unknown) => ({
      ref,
      latestAutoRun: null,
      diagnostics: [],
      errors: []
    })),
    getGraphViewModel: vi.fn(async (workspace: unknown) => ({ workspace })),
    getTaskFileManagerPath: vi.fn(async () => "/tmp/project/package/shared/P00.md"),
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
    listPendingImportRecoveries: vi.fn(async () => [
      {
        transactionId: "import-tx-1",
        recoveryRoot: "/tmp/project/desktop/recovery/package-import/import-tx-1",
        createdAt: "2026-07-06T00:00:00.000Z",
        operationCount: 2,
        phases: ["prepared", "applied"]
      }
    ]),
    resetDesktopRuntimeState: vi.fn(
      async (projectRoot: string, canvasId: string | null | undefined, options: unknown) => ({
        projectRoot,
        canvasId,
        options
      })
    ),
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
    rollbackPendingImportRecovery: vi.fn(async () => undefined),
    testExecutorProfile: vi.fn(async (options: unknown) => ({
      name: "codex",
      adapter: "codex-exec",
      profileAdapter: "agent",
      executionIntegration: "codex-exec",
      ok: true,
      message: "executor preflight passed",
      checks: [],
      options
    })),
    updateCanvasExecutionPolicy: vi.fn(async (workspace: unknown, input: unknown) => ({
      ok: true,
      affectedTasks: ["T-001"],
      diagnostics: [],
      graph: { workspace, input }
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
  const actual =
    await vi.importActual<typeof import("@planweave-ai/runtime")>("@planweave-ai/runtime");
  return {
    ...actual,
    applyCanvasLaneLayout: runtimeMock.applyCanvasLaneLayout,
    getDesktopProjectSnapshot: runtimeMock.getDesktopProjectSnapshot,
    getDesktopGraphDiagnostics: runtimeMock.getDesktopGraphDiagnostics,
    getDesktopRuntimeRefresh: runtimeMock.getDesktopRuntimeRefresh,
    getGraphViewModel: runtimeMock.getGraphViewModel,
    getTaskFileManagerPath: runtimeMock.getTaskFileManagerPath,
    getRunRecord: runtimeMock.getRunRecord,
    listPendingImportRecoveries: runtimeMock.listPendingImportRecoveries,
    resetDesktopRuntimeState: runtimeMock.resetDesktopRuntimeState,
    resolveProjectCanvasWorkspace: runtimeMock.resolveProjectCanvasWorkspace,
    resolveTaskCanvasWorkspace: runtimeMock.resolveTaskCanvasWorkspace,
    rollbackPendingImportRecovery: runtimeMock.rollbackPendingImportRecovery,
    testExecutorProfile: runtimeMock.testExecutorProfile,
    updateCanvasExecutionPolicy: runtimeMock.updateCanvasExecutionPolicy,
    subscribeAutoRunEvents: runtimeMock.subscribeAutoRunEvents
  };
});

export function getRuntimeBridgeMocks() {
  return { childProcessMock, electronMock, runtimeMock };
}

const originalPlanweaveHome = process.env.PLANWEAVE_HOME;

export async function resetRuntimeBridgeMocks(): Promise<void> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  vi.resetModules();
  await rm(electronMock.userDataDir, { recursive: true, force: true });
  electronMock.userDataDir = await mkdtemp(join(tmpdir(), "planweave-terminal-prefs-"));
  process.env.PLANWEAVE_HOME = join(electronMock.userDataDir, "planweave-home");
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
  childProcessMock.execFile.mockImplementation(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      callback(null, "", "");
    }
  );
  delete process.env.PLANWEAVE_DESKTOP_SMOKE;
  runtimeMock.autoRunEventListeners.clear();
  runtimeMock.applyCanvasLaneLayout.mockClear();
  runtimeMock.getDesktopGraphDiagnostics.mockClear();
  runtimeMock.getDesktopProjectSnapshot.mockClear();
  runtimeMock.getDesktopRuntimeRefresh.mockClear();
  runtimeMock.getGraphViewModel.mockClear();
  runtimeMock.getTaskFileManagerPath.mockClear();
  runtimeMock.getRunRecord.mockClear();
  runtimeMock.listPendingImportRecoveries.mockClear();
  runtimeMock.resetDesktopRuntimeState.mockClear();
  runtimeMock.resolveProjectCanvasWorkspace.mockClear();
  runtimeMock.resolveTaskCanvasWorkspace.mockClear();
  runtimeMock.rollbackPendingImportRecovery.mockClear();
  runtimeMock.testExecutorProfile.mockClear();
  runtimeMock.updateCanvasExecutionPolicy.mockClear();
  runtimeMock.subscribeAutoRunEvents.mockClear();
}

export async function restoreRuntimeBridgeEnv(): Promise<void> {
  const { rm } = await import("node:fs/promises");
  if (originalPlanweaveHome === undefined) {
    delete process.env.PLANWEAVE_HOME;
  } else {
    process.env.PLANWEAVE_HOME = originalPlanweaveHome;
  }
  await rm(electronMock.userDataDir, { recursive: true, force: true });
}
