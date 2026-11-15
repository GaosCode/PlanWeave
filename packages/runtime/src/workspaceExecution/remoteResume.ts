import { createHash } from "node:crypto";
import {
  remoteHumanResumeCommandSchema,
  remoteResumeReceiptSchema,
  remoteResumeTargetSchema,
  type RemoteResumeReceipt,
  type RemoteResumeTarget
} from "@planweave-ai/collaboration-protocol/remote-run";
import { stableJson } from "../plangraph/hash.js";
import type { RemoteWorkspaceExecutionHandle } from "./contracts.js";
import { WorkspaceExecutionError, workspaceExecutionPortError } from "./errors.js";
import type { RemoteOperationResumePort } from "./ports.js";
import type { WorkspaceExecutionRemoteResumeCapability } from "./view.js";

type ResumeContext = {
  binding: Parameters<RemoteOperationResumePort["read"]>[0]["binding"];
  handle: RemoteWorkspaceExecutionHandle;
  signal?: AbortSignal;
};

function targetForHandle(handle: RemoteWorkspaceExecutionHandle) {
  return {
    operationId: handle.operationId,
    dispatchId: handle.dispatchId,
    executionAttemptId: handle.executionAttemptId,
    expectedAttemptVersion: handle.attemptStateVersion,
    priorLeaseId: handle.leaseId
  };
}

function targetMatches(observed: RemoteResumeTarget, expected: ReturnType<typeof targetForHandle>) {
  return (
    observed.operationId === expected.operationId &&
    observed.dispatchId === expected.dispatchId &&
    observed.executionAttemptId === expected.executionAttemptId &&
    observed.expectedAttemptVersion === expected.expectedAttemptVersion &&
    observed.priorLeaseId === expected.priorLeaseId
  );
}

function unavailable(reason: string) {
  return new WorkspaceExecutionError(
    "remote_resume_unavailable",
    reason,
    false,
    undefined,
    "conflict"
  );
}

export async function readWorkspaceRemoteResumeCapability(
  port: RemoteOperationResumePort | undefined,
  { binding, handle, signal }: ResumeContext
): Promise<WorkspaceExecutionRemoteResumeCapability> {
  if (!port) return { available: false, reason: "unsupported" };
  let status: Awaited<ReturnType<RemoteOperationResumePort["read"]>>;
  try {
    status = await port.read({ binding, operationId: handle.operationId }, signal);
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    return {
      available: false,
      reason: "request_failed",
      code: workspaceExecutionPortError(error, "remote_resume_status_unavailable").code
    };
  }
  if (status === null) return { available: false, reason: "unsupported" };
  if (!status.capability.available) return status.capability;
  return targetMatches(status.capability.target, targetForHandle(handle))
    ? { available: true }
    : {
        available: false,
        reason: "request_failed",
        code: "remote_action_attempt_version_conflict"
      };
}

function workspaceResumeAction(
  port: RemoteOperationResumePort | undefined,
  { handle, binding, signal }: ResumeContext
) {
  if (!port) throw unavailable("unsupported");
  const parsedTarget = remoteResumeTargetSchema.safeParse(targetForHandle(handle));
  if (!parsedTarget.success) throw unavailable("recovery_evidence_missing");
  const target = parsedTarget.data;
  const actionId = `workspace-resume-${createHash("sha256").update(stableJson(target)).digest("hex")}`;
  const command = remoteHumanResumeCommandSchema.parse({
    ...target,
    kind: "resume_same_session",
    actionId,
    reason: "Resume the interrupted ACP session"
  });
  const readStatus = async () => {
    signal?.throwIfAborted();
    try {
      const status = await port.read(
        { binding, operationId: target.operationId, actionId },
        signal
      );
      signal?.throwIfAborted();
      if (!status) throw unavailable("unsupported");
      const receipt = status.receipt;
      if (receipt && (receipt.actionId !== actionId || !targetMatches(receipt.target, target))) {
        throw new WorkspaceExecutionError("remote_resume_receipt_identity_mismatch");
      }
      return status;
    } catch (error) {
      signal?.throwIfAborted();
      throw workspaceExecutionPortError(error, "remote_resume_status_unavailable");
    }
  };
  return { command, target, actionId, readStatus };
}

export async function observeWorkspaceResumeAction(
  port: RemoteOperationResumePort | undefined,
  context: ResumeContext
): Promise<RemoteResumeReceipt | null> {
  return (await workspaceResumeAction(port, context).readStatus()).receipt;
}

export async function resumeWorkspaceRemoteAttempt(
  port: RemoteOperationResumePort | undefined,
  context: ResumeContext,
  current: RemoteWorkspaceExecutionHandle
): Promise<RemoteResumeReceipt> {
  const { binding, handle, signal } = context;
  if (!port) throw unavailable("unsupported");
  if (
    current.dispatchId !== handle.dispatchId ||
    current.executionAttemptId !== handle.executionAttemptId
  ) {
    throw new WorkspaceExecutionError("remote_attempt_changed");
  }
  const { command, target, actionId, readStatus } = workspaceResumeAction(port, context);
  const status = await readStatus();
  if (status.receipt && status.receipt.state !== "recorded") return status.receipt;
  if (!targetMatches(target, targetForHandle(current))) {
    if (status.receipt && !status.capability.available) return status.receipt;
    throw new WorkspaceExecutionError("remote_action_attempt_version_conflict");
  }
  if (!status.capability.available) throw unavailable(status.capability.reason);
  if (!targetMatches(status.capability.target, target)) {
    throw new WorkspaceExecutionError("remote_action_attempt_version_conflict");
  }

  signal?.throwIfAborted();
  let response: Awaited<ReturnType<RemoteOperationResumePort["execute"]>>;
  try {
    response = await port.execute({ binding, command }, signal);
  } catch (error) {
    signal?.throwIfAborted();
    const failure = workspaceExecutionPortError(error, "remote_resume_execution_unavailable");
    if (!failure.retryable) throw failure;
    const { receipt } = await readStatus();
    if (receipt && receipt.state !== "recorded") return receipt;
    throw failure;
  }
  signal?.throwIfAborted();
  if (
    response.request.kind !== "resume_same_session" ||
    response.request.actionId !== actionId ||
    response.request.reason !== command.reason ||
    !targetMatches(response.request, target)
  ) {
    throw new WorkspaceExecutionError("remote_resume_receipt_identity_mismatch");
  }
  return remoteResumeReceiptSchema.parse({
    actionId,
    target,
    leaseId: response.request.leaseId,
    state: response.state,
    ...(response.rejectionCode === undefined ? {} : { rejectionCode: response.rejectionCode })
  });
}
