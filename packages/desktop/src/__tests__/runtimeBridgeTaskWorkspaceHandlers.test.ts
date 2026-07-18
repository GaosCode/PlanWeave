import { taskWorkspaceSchema } from "@planweave-ai/runtime";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { desktopBridgeInvokeChannels } from "../shared/ipcChannels";
import {
  getRuntimeBridgeMocks,
  registeredHandler,
  resetRuntimeBridgeMocks,
  restoreRuntimeBridgeEnv
} from "./support/runtimeBridgeTestHarness";

describe("Task Workspace runtime bridge", () => {
  beforeEach(async () => {
    await resetRuntimeBridgeMocks();
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();
  });

  afterAll(async () => {
    await restoreRuntimeBridgeEnv();
  });

  it("registers the channel and forwards the complete input to Runtime", async () => {
    const { runtimeMock } = getRuntimeBridgeMocks();
    const input = {
      projectRoot: "/tmp/project",
      canvasId: "canvas-a",
      taskId: "T-001"
    };

    const result = await registeredHandler(desktopBridgeInvokeChannels.getTaskWorkspace)(
      null,
      input
    );

    expect(runtimeMock.getTaskWorkspace).toHaveBeenCalledOnce();
    expect(runtimeMock.getTaskWorkspace).toHaveBeenCalledWith(input);
    expect(result).toMatchObject({
      version: "planweave.task-workspace/v1",
      project: { projectRoot: input.projectRoot, canvasId: input.canvasId },
      task: { taskId: input.taskId }
    });
  });

  it("validates and forwards the canonical retry identity to Runtime", async () => {
    const { runtimeMock } = getRuntimeBridgeMocks();
    const identity = {
      version: "planweave.task-workspace-retry/v1",
      projectId: "project-1",
      projectRoot: "/tmp/project",
      canvasId: "canvas-a",
      taskId: "T-001",
      blockId: "B-001",
      claimRef: "T-001#B-001",
      recordId: "T-001#B-001::RUN-001",
      runId: "RUN-001",
      executorRunId: "RUN-001"
    };

    await registeredHandler(desktopBridgeInvokeChannels.retryTaskWorkspaceRun)(null, identity);

    expect(runtimeMock.retryTaskWorkspaceRun).toHaveBeenCalledWith(identity);
  });

  it("rejects a retry identity whose executor run does not match the persisted run", async () => {
    const { runtimeMock } = getRuntimeBridgeMocks();

    expect(() =>
      registeredHandler(desktopBridgeInvokeChannels.retryTaskWorkspaceRun)(null, {
        version: "planweave.task-workspace-retry/v1",
        projectId: "project-1",
        projectRoot: "/tmp/project",
        canvasId: "canvas-a",
        taskId: "T-001",
        blockId: "B-001",
        claimRef: "T-001#B-001",
        recordId: "T-001#B-001::RUN-001",
        runId: "RUN-001",
        executorRunId: "RUN-OTHER"
      })
    ).toThrow("Retry executorRunId must equal runId");
    expect(runtimeMock.retryTaskWorkspaceRun).not.toHaveBeenCalled();
  });

  it.each([
    ["project root", "project.projectRoot", "/tmp/other-project"],
    ["canvas id", "project.canvasId", "canvas-other"],
    ["task id", "task.taskId", "T-OTHER"]
  ] as const)("rejects a Runtime response with a mismatched %s", async (_label, path, value) => {
    const { runtimeMock } = getRuntimeBridgeMocks();
    const handler = registeredHandler(desktopBridgeInvokeChannels.getTaskWorkspace);
    const input = { projectRoot: "/tmp/project", canvasId: "canvas-a", taskId: "T-001" };
    const validResult = taskWorkspaceSchema.parse(await handler(null, input));
    const mismatchedResult =
      path === "project.projectRoot"
        ? { ...validResult, project: { ...validResult.project, projectRoot: value } }
        : path === "project.canvasId"
          ? { ...validResult, project: { ...validResult.project, canvasId: value } }
          : { ...validResult, task: { ...validResult.task, taskId: value } };
    runtimeMock.getTaskWorkspace.mockResolvedValueOnce(mismatchedResult);

    await expect(handler(null, input)).rejects.toThrow(
      `Task Workspace request failed: invalid Runtime response identity: ${path}`
    );
  });

  it("rejects a Runtime response that ignores an explicit selected record", async () => {
    const input = {
      projectRoot: "/tmp/project",
      canvasId: "canvas-a",
      taskId: "T-001",
      selectedRecordId: "T-001#B-001::RUN-001"
    };

    await expect(
      registeredHandler(desktopBridgeInvokeChannels.getTaskWorkspace)(null, input)
    ).rejects.toThrow(
      "Task Workspace request failed: invalid Runtime response identity: selectedRecordId"
    );
  });

  it.each([
    ["task id", { projectRoot: "/tmp/project", canvasId: "canvas-a", taskId: "" }, "taskId"],
    [
      "canvas id",
      { projectRoot: "/tmp/project", canvasId: "invalid canvas", taskId: "T-001" },
      "canvasId"
    ]
  ])("rejects an invalid %s before invoking Runtime", async (_label, input, path) => {
    const { runtimeMock } = getRuntimeBridgeMocks();

    await expect(
      registeredHandler(desktopBridgeInvokeChannels.getTaskWorkspace)(null, input)
    ).rejects.toThrow(`Task Workspace request failed: ${path}`);
    expect(runtimeMock.getTaskWorkspace).not.toHaveBeenCalled();
  });

  it("rejects a Runtime runs page whose limit exceeds the hard upper bound", async () => {
    const { runtimeMock } = getRuntimeBridgeMocks();
    const handler = registeredHandler(desktopBridgeInvokeChannels.listTaskWorkspaceRuns);
    const input = {
      projectRoot: "/tmp/project",
      canvasId: "canvas-a",
      taskId: "T-001",
      limit: 101
    };

    await expect(handler(null, input)).rejects.toThrow(/Task Workspace runs request failed/i);
    expect(runtimeMock.listTaskWorkspaceRuns).not.toHaveBeenCalled();
  });

  it("rejects a Runtime run-detail response with mismatched record identity", async () => {
    const { runtimeMock } = getRuntimeBridgeMocks();
    const handler = registeredHandler(desktopBridgeInvokeChannels.getTaskWorkspaceRunDetail);
    const input = {
      projectRoot: "/tmp/project",
      canvasId: "canvas-a",
      taskId: "T-001",
      recordId: "T-001#B-001::RUN-001"
    };
    runtimeMock.getTaskWorkspaceRunDetail.mockResolvedValueOnce({
      version: "planweave.task-workspace-run-detail/v1",
      projectRoot: "/tmp/project",
      canvasId: "canvas-a",
      taskId: "T-001",
      blockRef: "T-001#B-001",
      item: {
        retryIndex: 1,
        active: false,
        selected: true,
        waitingInteraction: { active: false, count: 0, kinds: [] },
        run: {
          version: "planweave.task-workspace-run/v1",
          kind: "block",
          record: {
            recordId: "T-001#B-001::RUN-OTHER",
            ref: "T-001#B-001",
            taskId: "T-001",
            blockId: "B-001",
            runId: "RUN-OTHER"
          },
          runIdentity: {
            projectId: "project-1",
            canvasId: "canvas-a",
            taskId: "T-001",
            blockId: "B-001",
            claimRef: "T-001#B-001",
            runId: "RUN-OTHER",
            runOwner: "executor",
            runSessionId: null,
            desktopRunId: null,
            executorRunId: "RUN-OTHER"
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
        recordId: "T-001#B-001::RUN-OTHER",
        ref: "T-001#B-001",
        taskId: "T-001",
        blockId: "B-001",
        runId: "RUN-OTHER",
        promptMarkdown: "",
        reportMarkdown: "",
        displayMarkdown: "",
        displayMarkdownSource: "none",
        metadata: {},
        runnerReadModel: null
      }
    });

    await expect(handler(null, input)).rejects.toThrow(
      /Task Workspace run detail request failed|invalid Runtime response|recordId/i
    );
  });

  it("surfaces Runtime scope failures without a fallback result", async () => {
    const { runtimeMock } = getRuntimeBridgeMocks();
    runtimeMock.getTaskWorkspace.mockRejectedValueOnce(
      new Error("Task 'T-999' does not exist in canvas 'canvas-a'.")
    );

    await expect(
      registeredHandler(desktopBridgeInvokeChannels.getTaskWorkspace)(null, {
        projectRoot: "/tmp/project",
        canvasId: "canvas-a",
        taskId: "T-999"
      })
    ).rejects.toThrow(
      "Task Workspace request failed: Task 'T-999' does not exist in canvas 'canvas-a'."
    );
  });
});
