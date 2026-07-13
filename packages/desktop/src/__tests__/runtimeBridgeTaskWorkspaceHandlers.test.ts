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

  it("rejects a Runtime response with an invalid selected record identity", async () => {
    const { runtimeMock } = getRuntimeBridgeMocks();
    const handler = registeredHandler(desktopBridgeInvokeChannels.getTaskWorkspace);
    const input = { projectRoot: "/tmp/project", canvasId: "canvas-a", taskId: "T-001" };
    const validResult = await handler(null, input);
    runtimeMock.getTaskWorkspace.mockResolvedValueOnce({
      ...taskWorkspaceSchema.parse(validResult),
      selectedRecordId: "T-001#B-001::RUN-MISSING"
    });

    await expect(handler(null, input)).rejects.toThrow(
      "Task Workspace request failed: invalid Runtime response: selectedRecordId"
    );
  });

  it("surfaces a selectedRecordId that does not belong to the Task as a readable error", async () => {
    const { runtimeMock } = getRuntimeBridgeMocks();
    const handler = registeredHandler(desktopBridgeInvokeChannels.getTaskWorkspace);
    const input = { projectRoot: "/tmp/project", canvasId: "canvas-a", taskId: "T-001" };
    const validResult = taskWorkspaceSchema.parse(await handler(null, input));
    const invalidResult = taskWorkspaceSchema.safeParse({
      ...validResult,
      selectedRecordId: "T-001#B-001::RUN-MISSING"
    });
    if (invalidResult.success) throw new Error("Expected an invalid selected record identity.");
    runtimeMock.getTaskWorkspace.mockRejectedValueOnce(invalidResult.error);

    await expect(handler(null, input)).rejects.toThrow(
      "Task Workspace request failed: selectedRecordId: Selected record id"
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
