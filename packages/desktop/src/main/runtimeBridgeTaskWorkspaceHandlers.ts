import {
  getBlockDetail,
  getRunRecord,
  getTaskExecutionOrder,
  getTaskWorkspace,
  getTaskWorkspaceRunDetail,
  listBlockRunRecords,
  listTaskWorkspaceRuns,
  recoverTaskWorkspaceAcpRun,
  retryTaskWorkspaceRun,
  taskWorkspaceInputSchema,
  taskWorkspaceListRunsInputSchema,
  taskWorkspaceRunDetailInputSchema,
  taskWorkspaceRunDetailSchema,
  taskWorkspaceRunsPageSchema,
  taskWorkspaceSchema,
  taskWorkspaceAcpRecoveryIdentitySchema,
  taskWorkspaceRetryIdentitySchema
} from "@planweave-ai/runtime";
import type {
  TaskWorkspace,
  TaskWorkspaceInput,
  TaskWorkspaceRunDetail,
  TaskWorkspaceRunsPage
} from "@planweave-ai/runtime";
import { z } from "zod";
import { resolveDesktopCanvasReference } from "./runtimeBridgeCanvasReference.js";
import type { RuntimeBridgeHandlerMap } from "./runtimeBridgeHandlerTypes.js";
import { isValidationFailure, validationFailureMessage } from "./runtimeBridgeValidationFailure.js";

function assertTaskWorkspaceResponseIdentity(
  input: TaskWorkspaceInput,
  result: TaskWorkspace
): void {
  if (!("projectRoot" in result.project)) {
    throw new Error(
      "invalid Runtime response identity: local Task Workspace returned remote authority."
    );
  }
  const identityFields = [
    ["project.projectRoot", result.project.projectRoot, input.projectRoot],
    ["project.canvasId", result.project.canvasId, input.canvasId],
    ["task.taskId", result.task.taskId, input.taskId]
  ] as const;
  for (const [path, actual, expected] of identityFields) {
    if (actual !== expected) {
      throw new Error(
        `invalid Runtime response identity: ${path} '${actual}' does not match request '${expected}'.`
      );
    }
  }
  if (input.selectedRecordId != null && result.selectedRecordId !== input.selectedRecordId) {
    throw new Error(
      `invalid Runtime response identity: selectedRecordId '${result.selectedRecordId}' does not match request '${input.selectedRecordId}'.`
    );
  }
}

async function invokeTaskWorkspace(input: unknown) {
  const parsedInput = taskWorkspaceInputSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new Error(
      `Task Workspace request failed: ${validationFailureMessage(parsedInput.error)}`
    );
  }
  try {
    const result = await getTaskWorkspace(parsedInput.data);
    const parsedResult = taskWorkspaceSchema.safeParse(result);
    if (!parsedResult.success) {
      throw new Error(`invalid Runtime response: ${validationFailureMessage(parsedResult.error)}`);
    }
    assertTaskWorkspaceResponseIdentity(parsedInput.data, parsedResult.data);
    return parsedResult.data;
  } catch (error) {
    const message = isValidationFailure(error)
      ? validationFailureMessage(error)
      : error instanceof Error && error.message.trim()
        ? error.message
        : "unknown Runtime error";
    throw new Error(`Task Workspace request failed: ${message}`);
  }
}

function assertTaskWorkspaceScopeIdentity(
  input: { projectRoot: string; canvasId: string; taskId: string },
  result: { projectRoot: string; canvasId: string; taskId: string },
  label: string
): void {
  const identityFields = [
    ["projectRoot", result.projectRoot, input.projectRoot],
    ["canvasId", result.canvasId, input.canvasId],
    ["taskId", result.taskId, input.taskId]
  ] as const;
  for (const [path, actual, expected] of identityFields) {
    if (actual !== expected) {
      throw new Error(
        `invalid Runtime response identity: ${path} '${actual}' does not match request '${expected}'.`
      );
    }
  }
  void label;
}

async function invokeTaskWorkspaceRuns(input: unknown): Promise<TaskWorkspaceRunsPage> {
  const parsedInput = taskWorkspaceListRunsInputSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new Error(
      `Task Workspace runs request failed: ${validationFailureMessage(parsedInput.error)}`
    );
  }
  try {
    const result = await listTaskWorkspaceRuns(parsedInput.data);
    const parsedResult = taskWorkspaceRunsPageSchema.safeParse(result);
    if (!parsedResult.success) {
      throw new Error(`invalid Runtime response: ${validationFailureMessage(parsedResult.error)}`);
    }
    assertTaskWorkspaceScopeIdentity(parsedInput.data, parsedResult.data, "runs page");
    return parsedResult.data;
  } catch (error) {
    const message = isValidationFailure(error)
      ? validationFailureMessage(error)
      : error instanceof Error && error.message.trim()
        ? error.message
        : "unknown Runtime error";
    throw new Error(`Task Workspace runs request failed: ${message}`);
  }
}

async function invokeTaskWorkspaceRunDetail(input: unknown): Promise<TaskWorkspaceRunDetail> {
  const parsedInput = taskWorkspaceRunDetailInputSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new Error(
      `Task Workspace run detail request failed: ${validationFailureMessage(parsedInput.error)}`
    );
  }
  try {
    const result = await getTaskWorkspaceRunDetail(parsedInput.data);
    const parsedResult = taskWorkspaceRunDetailSchema.safeParse(result);
    if (!parsedResult.success) {
      throw new Error(`invalid Runtime response: ${validationFailureMessage(parsedResult.error)}`);
    }
    assertTaskWorkspaceScopeIdentity(parsedInput.data, parsedResult.data, "run detail");
    if (parsedResult.data.record.recordId !== parsedInput.data.recordId) {
      throw new Error(
        `invalid Runtime response identity: record.recordId '${parsedResult.data.record.recordId}' does not match request '${parsedInput.data.recordId}'.`
      );
    }
    return parsedResult.data;
  } catch (error) {
    const message = isValidationFailure(error)
      ? validationFailureMessage(error)
      : error instanceof Error && error.message.trim()
        ? error.message
        : "unknown Runtime error";
    throw new Error(`Task Workspace run detail request failed: ${message}`);
  }
}

export const runtimeBridgeTaskWorkspaceHandlers = {
  getTaskWorkspace: (_event, input) => invokeTaskWorkspace(input),
  listTaskWorkspaceRuns: (_event, input) => invokeTaskWorkspaceRuns(input),
  getTaskWorkspaceRunDetail: (_event, input) => invokeTaskWorkspaceRunDetail(input),
  retryTaskWorkspaceRun: (_event, identity) =>
    retryTaskWorkspaceRun(taskWorkspaceRetryIdentitySchema.parse(identity)),
  recoverTaskWorkspaceAcpRun: (_event, identity, audit) =>
    recoverTaskWorkspaceAcpRun(
      taskWorkspaceAcpRecoveryIdentitySchema.parse(identity),
      z
        .object({ source: z.string().min(1).max(128), reason: z.string().min(1).max(4_096) })
        .strict()
        .parse(audit)
    ),
  getBlockDetail: async (_event, ref, blockRef) =>
    getBlockDetail(await resolveDesktopCanvasReference(ref), blockRef),
  getTaskExecutionOrder: async (_event, ref, taskId) =>
    getTaskExecutionOrder(await resolveDesktopCanvasReference(ref), taskId),
  listBlockRunRecords: async (_event, ref, blockRef) =>
    listBlockRunRecords(await resolveDesktopCanvasReference(ref), blockRef),
  getRunRecord: async (_event, ref, recordId) =>
    getRunRecord(await resolveDesktopCanvasReference(ref), recordId)
} satisfies Partial<RuntimeBridgeHandlerMap>;
