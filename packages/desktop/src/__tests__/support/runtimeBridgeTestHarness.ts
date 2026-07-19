import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import { vi } from "vitest";

type GetTaskWorkspace = DesktopBridgeApi["getTaskWorkspace"];
type GetTaskWorkspaceInput = Parameters<GetTaskWorkspace>[0];
type GetTaskWorkspaceResult = Awaited<ReturnType<GetTaskWorkspace>>;

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown;
type AutoRunEventListener = (event: unknown) => void;
type RunnerRecordEventListener = (event: unknown) => void;

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

function taskWorkspaceFixture(input: GetTaskWorkspaceInput): GetTaskWorkspaceResult {
  return {
    version: "planweave.task-workspace/v1",
    project: {
      projectId: "project-1",
      projectRoot: input.projectRoot,
      canvasId: input.canvasId
    },
    task: {
      taskId: input.taskId,
      title: "Task workspace",
      status: "planned",
      executor: null,
      promptMarkdown: "# Task workspace",
      promptMissing: false,
      acceptance: []
    },
    dependencyProgress: {
      total: 0,
      completed: 0,
      percent: 100,
      status: "not_applicable",
      blockers: []
    },
    blocks: [],
    activeRecordIds: [],
    selectedRecordId: null,
    latestArtifact: null,
    duration: {
      wallClock: {
        available: false,
        startedAt: null,
        endedAt: null,
        calculatedAt: "2026-07-13T00:00:00.000Z",
        totalMs: null,
        unavailableReason: "No Task runs are available."
      },
      agentTime: {
        availability: "unavailable",
        totalMs: null,
        includedRunCount: 0,
        missingRunCount: 0,
        reason: "No Task runs are available."
      }
    },
    usage: {
      taskTokens: {
        available: false,
        totalTokens: null,
        reason: "Task token accounting is unavailable."
      },
      taskCost: {
        available: false,
        totals: null,
        reason: "Task cost accounting is unavailable."
      }
    }
  };
}

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
      openExternal: vi.fn(),
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
    getTaskWorkspace: vi.fn<GetTaskWorkspace>(async (input) => taskWorkspaceFixture(input)),
    listTaskWorkspaceRuns: vi.fn(
      async (input: { projectRoot: string; canvasId: string; taskId: string }) => ({
        version: "planweave.task-workspace-runs-page/v1" as const,
        projectRoot: input.projectRoot,
        canvasId: input.canvasId,
        taskId: input.taskId,
        limit: 50,
        items: [],
        nextCursor: null
      })
    ),
    getTaskWorkspaceRunDetail: vi.fn(
      async (input: {
        projectRoot: string;
        canvasId: string;
        taskId: string;
        recordId: string;
      }) => ({
        version: "planweave.task-workspace-run-detail/v1" as const,
        projectRoot: input.projectRoot,
        canvasId: input.canvasId,
        taskId: input.taskId,
        blockRef: input.recordId.split("::")[0] ?? "T-001#B-001",
        item: {
          retryIndex: 1,
          active: false,
          selected: true,
          waitingInteraction: { active: false as const, count: 0 as const, kinds: [] },
          run: {
            version: "planweave.task-workspace-run/v1",
            kind: "block",
            record: {
              recordId: input.recordId,
              ref: input.recordId.split("::")[0] ?? "T-001#B-001",
              taskId: input.taskId,
              blockId: "B-001",
              runId: input.recordId.split("::")[1] ?? "RUN-001"
            },
            runIdentity: {
              projectId: "project-1",
              canvasId: input.canvasId,
              taskId: input.taskId,
              blockId: "B-001",
              claimRef: input.recordId.split("::")[0] ?? "T-001#B-001",
              runId: input.recordId.split("::")[1] ?? "RUN-001",
              runOwner: "executor",
              runSessionId: null,
              desktopRunId: null,
              executorRunId: input.recordId.split("::")[1] ?? "RUN-001"
            },
            metadata: {
              executor: null,
              adapter: null,
              runnerKind: null,
              agentId: null,
              executionCwd: null,
              projectRoot: null,
              agentSessionId: null,
              tmuxSessionId: null,
              exitCode: null,
              terminalState: null
            },
            executionWaveId: null,
            duration: {
              startedAt: null,
              finishedAt: null,
              calculatedAt: "2026-07-13T00:00:00.000Z",
              wallClockMs: null,
              unavailableReason: "Unavailable."
            },
            usage: {
              currentContext: null,
              runTokens: { available: false, totalTokens: null, reason: "Unavailable." },
              taskTokens: { available: false, totalTokens: null, reason: "Unavailable." }
            },
            actualConfiguration: { available: false, reason: "Unavailable." },
            nextActions: { version: "planweave.runner-next-actions/v1", actions: [] },
            capabilities: {
              prompt: { available: false, reason: "Unavailable.", identity: null, inFlight: false },
              cancel: { available: false, reason: "Unavailable.", identity: null },
              retry: { available: false, reason: "Unavailable.", identity: null },
              recoverAcpSession: {
                available: false,
                reason: { code: "runner_not_acp", message: "Unavailable." },
                identity: null
              },
              resume: { available: false, reason: "Unavailable.", identity: null }
            }
          }
        },
        record: {
          recordId: input.recordId,
          ref: input.recordId.split("::")[0] ?? "T-001#B-001",
          taskId: input.taskId,
          blockId: "B-001",
          runId: input.recordId.split("::")[1] ?? "RUN-001",
          executor: null,
          adapter: null,
          executionCwd: null,
          projectRoot: input.projectRoot,
          agentSessionId: null,
          codexSessionId: null,
          tmuxSessionId: null,
          exitCode: null,
          startedAt: null,
          finishedAt: null,
          promptPath: null,
          reportPath: null,
          metadataPath: "/tmp/metadata.json",
          stdoutSummary: "",
          stderrSummary: "",
          promptMarkdown: "",
          reportMarkdown: "",
          displayMarkdown: "",
          displayMarkdownSource: "none" as const,
          metadata: {},
          runnerReadModel: null
        }
      })
    ),
    retryTaskWorkspaceRun: vi.fn(async (identity: unknown) => ({ identity })),
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
    listDesktopPendingAgentRequests: vi.fn(async () => []),
    listPendingRunnerInteractions: vi.fn(async () => []),
    respondToDesktopAgentRequest: vi.fn(async () => undefined),
    respondToDesktopAgentAuthenticationRequest: vi.fn(async () => undefined),
    respondToRunnerInteractionAction: vi.fn(async (_ref, action, decision, audit) => ({
      version: "planweave.runner-interaction-response-receipt/v1" as const,
      identity: {
        projectId: "project-1",
        canvasId: "canvas-a",
        claimRef: "T-001#B-001",
        executorRunId: "RUN-001",
        sessionId: "session-1",
        requestId: action.requestId,
        ownerLeaseId: action.ownerLeaseId,
        ownerGeneration: 1
      },
      acceptedAt: "2026-07-17T00:00:00.000Z",
      decision,
      selectedOption:
        decision.kind === "select"
          ? { optionId: decision.optionId, label: "Allow once", decision: "approve" as const }
          : null,
      decisionSource: audit.decisionSource
    })),
    cancelDesktopAgentRun: vi.fn(async () => undefined),
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
    probeDesktopAgentCapabilities: vi.fn(async (input: unknown) => ({
      agentKind: "codex",
      ok: true,
      message: "ACP capability probe passed.",
      failureCode: null,
      agentInfo: null,
      authentication: { status: "not_advertised" },
      capabilities: ["session"],
      sessionConfig: null,
      checks: [
        { check: "acp_initialized", status: "passed", message: "ACP initialize completed." }
      ],
      input
    })),
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
    addTaskNode: vi.fn(async (workspace: unknown, input: unknown) => ({
      ok: true,
      affectedTasks: ["T-new"],
      diagnostics: [],
      graph: { workspace, input }
    })),
    addBlock: vi.fn(async (workspace: unknown, input: unknown) => ({
      ok: true,
      affectedTasks: ["T-001"],
      diagnostics: [],
      graph: { workspace, input }
    })),
    validateGraphEdit: vi.fn(async (workspace: unknown, input: unknown) => ({
      ok: true,
      affectedTasks: [],
      diagnostics: [],
      graph: { workspace, input }
    })),
    updateReviewPipeline: vi.fn(async (workspace: unknown, taskId: string, input: unknown) => ({
      ok: true,
      affectedTasks: [taskId],
      diagnostics: [],
      graph: { workspace, input }
    })),
    updateTaskPrompt: vi.fn(
      async (workspace: unknown, taskId: string, markdown: string, options?: unknown) => ({
        ok: true,
        affectedTasks: [taskId],
        diagnostics: [],
        graph: { workspace, markdown, options }
      })
    ),
    updateBlockPrompt: vi.fn(
      async (workspace: unknown, blockRef: string, markdown: string, options?: unknown) => ({
        ok: true,
        affectedTasks: [blockRef.split("#")[0] ?? "T-001"],
        diagnostics: [],
        graph: { workspace, markdown, options }
      })
    ),
    addDependencyEdge: vi.fn(
      async (
        workspace: unknown,
        fromTaskId: string,
        toTaskId: string,
        baseGraphVersion?: string,
        layoutSnapshot?: unknown
      ) => ({
        ok: true,
        affectedTasks: [fromTaskId, toTaskId],
        diagnostics: [],
        graph: { workspace, baseGraphVersion, layoutSnapshot }
      })
    ),
    removeDependencyEdge: vi.fn(
      async (
        workspace: unknown,
        fromTaskId: string,
        toTaskId: string,
        baseGraphVersion?: string,
        layoutSnapshot?: unknown
      ) => ({
        ok: true,
        affectedTasks: [fromTaskId, toTaskId],
        diagnostics: [],
        graph: { workspace, baseGraphVersion, layoutSnapshot }
      })
    ),
    reconnectDependencyEdge: vi.fn(
      async (
        workspace: unknown,
        fromTaskId: string,
        oldToTaskId: string,
        newFromTaskId: string,
        newToTaskId: string,
        baseGraphVersion?: string,
        layoutSnapshot?: unknown
      ) => ({
        ok: true,
        affectedTasks: [fromTaskId, oldToTaskId, newFromTaskId, newToTaskId],
        diagnostics: [],
        graph: { workspace, baseGraphVersion, layoutSnapshot }
      })
    ),
    saveDesktopLayout: vi.fn(async (_workspace: unknown, layout: unknown) => layout),
    startAutoRun: vi.fn(
      async (
        projectRoot: string,
        canvasId: string | null | undefined,
        scope: unknown,
        stepLimit?: number,
        options?: unknown
      ) => ({
        runId: "RUN-001",
        projectRoot,
        canvasId: canvasId ?? null,
        scope,
        stepLimit,
        options
      })
    ),
    subscribeAutoRunEvents: vi.fn((listener: AutoRunEventListener) => {
      autoRunEventListeners.add(listener);
      return () => autoRunEventListeners.delete(listener);
    }),
    subscribeRunRecord: vi.fn(
      async (
        _workspace: unknown,
        _recordId: string,
        _cursor: unknown,
        _listener: RunnerRecordEventListener
      ) => ({
        snapshot: null,
        subscription: null
      })
    ),
    resolveRunRecordArtifactPath: vi.fn(async () => "/tmp/project/report.md")
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
    getTaskWorkspace: runtimeMock.getTaskWorkspace,
    listTaskWorkspaceRuns: runtimeMock.listTaskWorkspaceRuns,
    getTaskWorkspaceRunDetail: runtimeMock.getTaskWorkspaceRunDetail,
    retryTaskWorkspaceRun: runtimeMock.retryTaskWorkspaceRun,
    getTaskFileManagerPath: runtimeMock.getTaskFileManagerPath,
    getRunRecord: runtimeMock.getRunRecord,
    listDesktopPendingAgentRequests: runtimeMock.listDesktopPendingAgentRequests,
    listPendingRunnerInteractions: runtimeMock.listPendingRunnerInteractions,
    respondToDesktopAgentRequest: runtimeMock.respondToDesktopAgentRequest,
    respondToDesktopAgentAuthenticationRequest:
      runtimeMock.respondToDesktopAgentAuthenticationRequest,
    respondToRunnerInteractionAction: runtimeMock.respondToRunnerInteractionAction,
    cancelDesktopAgentRun: runtimeMock.cancelDesktopAgentRun,
    listPendingImportRecoveries: runtimeMock.listPendingImportRecoveries,
    resetDesktopRuntimeState: runtimeMock.resetDesktopRuntimeState,
    resolveProjectCanvasWorkspace: runtimeMock.resolveProjectCanvasWorkspace,
    resolveTaskCanvasWorkspace: runtimeMock.resolveTaskCanvasWorkspace,
    resolveRunRecordArtifactPath: runtimeMock.resolveRunRecordArtifactPath,
    rollbackPendingImportRecovery: runtimeMock.rollbackPendingImportRecovery,
    probeDesktopAgentCapabilities: runtimeMock.probeDesktopAgentCapabilities,
    testExecutorProfile: runtimeMock.testExecutorProfile,
    updateCanvasExecutionPolicy: runtimeMock.updateCanvasExecutionPolicy,
    addTaskNode: runtimeMock.addTaskNode,
    addBlock: runtimeMock.addBlock,
    validateGraphEdit: runtimeMock.validateGraphEdit,
    updateReviewPipeline: runtimeMock.updateReviewPipeline,
    updateTaskPrompt: runtimeMock.updateTaskPrompt,
    updateBlockPrompt: runtimeMock.updateBlockPrompt,
    addDependencyEdge: runtimeMock.addDependencyEdge,
    removeDependencyEdge: runtimeMock.removeDependencyEdge,
    reconnectDependencyEdge: runtimeMock.reconnectDependencyEdge,
    saveDesktopLayout: runtimeMock.saveDesktopLayout,
    startAutoRun: runtimeMock.startAutoRun,
    subscribeAutoRunEvents: runtimeMock.subscribeAutoRunEvents,
    subscribeRunRecord: runtimeMock.subscribeRunRecord
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
  electronMock.shell.openExternal.mockClear();
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
  runtimeMock.getTaskWorkspace.mockClear();
  runtimeMock.listTaskWorkspaceRuns.mockClear();
  runtimeMock.getTaskWorkspaceRunDetail.mockClear();
  runtimeMock.retryTaskWorkspaceRun.mockClear();
  runtimeMock.getTaskFileManagerPath.mockClear();
  runtimeMock.getRunRecord.mockClear();
  runtimeMock.listDesktopPendingAgentRequests.mockClear();
  runtimeMock.listPendingRunnerInteractions.mockClear();
  runtimeMock.respondToDesktopAgentRequest.mockClear();
  runtimeMock.respondToRunnerInteractionAction.mockClear();
  runtimeMock.cancelDesktopAgentRun.mockClear();
  runtimeMock.listPendingImportRecoveries.mockClear();
  runtimeMock.resetDesktopRuntimeState.mockClear();
  runtimeMock.resolveProjectCanvasWorkspace.mockClear();
  runtimeMock.resolveTaskCanvasWorkspace.mockClear();
  runtimeMock.resolveRunRecordArtifactPath.mockClear();
  runtimeMock.rollbackPendingImportRecovery.mockClear();
  runtimeMock.probeDesktopAgentCapabilities.mockClear();
  runtimeMock.testExecutorProfile.mockClear();
  runtimeMock.updateCanvasExecutionPolicy.mockClear();
  runtimeMock.addTaskNode.mockClear();
  runtimeMock.addBlock.mockClear();
  runtimeMock.validateGraphEdit.mockClear();
  runtimeMock.updateReviewPipeline.mockClear();
  runtimeMock.updateTaskPrompt.mockClear();
  runtimeMock.updateBlockPrompt.mockClear();
  runtimeMock.addDependencyEdge.mockClear();
  runtimeMock.removeDependencyEdge.mockClear();
  runtimeMock.reconnectDependencyEdge.mockClear();
  runtimeMock.saveDesktopLayout.mockClear();
  runtimeMock.startAutoRun.mockClear();
  runtimeMock.subscribeAutoRunEvents.mockClear();
  runtimeMock.subscribeRunRecord.mockReset();
  runtimeMock.subscribeRunRecord.mockImplementation(async () => ({
    snapshot: null,
    subscription: null
  }));
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
