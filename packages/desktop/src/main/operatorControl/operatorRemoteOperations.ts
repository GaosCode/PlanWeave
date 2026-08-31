import {
  OPERATOR_PUBLIC_RUNTIME_MEDIA_TYPE,
  remoteActionViewSchema,
  remoteDispatchIntentV3Schema,
  remoteHumanExecutionActionCommandSchema,
  remoteOperationObservationSchema,
  remoteRuntimeBindingProjectionSchema,
  type RemoteActionView,
  type RemoteDispatchIntentV3,
  type RemoteHumanExecutionActionCommand,
  type RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import { remoteBlockBindingViewSchema } from "@planweave-ai/runtime";
import { z, type ZodType } from "zod";

const operatorOperationViewSchema = z
  .object({
    operationId: z.string().min(1),
    projectId: z.string().min(1),
    canvasId: z.string().min(1),
    blockRef: z.string().min(1),
    state: z.string().min(1),
    dispatchId: z.string().min(1),
    executionAttemptId: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    terminalAt: z.string().optional(),
    attempt: z.object({}).passthrough(),
    runtime: z.union([remoteRuntimeBindingProjectionSchema, remoteBlockBindingViewSchema]),
    dispatchStatus: z.string().optional(),
    failure: z.object({}).passthrough().optional(),
    diagnostics: z.object({}).passthrough().optional(),
    agentEndpoint: z.object({}).passthrough().optional()
  })
  .passthrough();

/** Map operator observation wire to collaboration remote-run observation for claim-bus reuse. */
export function operatorObservationToRemoteRun(input: unknown): RemoteOperationObservation {
  const view = operatorOperationViewSchema.parse(input);
  const ownership = view.runtime.ownership;
  const terminalReceipt = view.runtime.terminalReceipt;
  return remoteOperationObservationSchema.parse({
    operationId: view.operationId,
    projectId: view.projectId,
    canvasId: view.canvasId,
    blockRef: view.blockRef,
    state: view.state,
    dispatchId: view.dispatchId,
    executionAttemptId: view.executionAttemptId,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    ...(view.terminalAt === undefined ? {} : { terminalAt: view.terminalAt }),
    attempt: view.attempt,
    ...(view.dispatchStatus === undefined ? {} : { dispatchStatus: view.dispatchStatus }),
    ...(view.failure === undefined ? {} : { failure: view.failure }),
    ...(view.diagnostics === undefined ? {} : { diagnostics: view.diagnostics }),
    ...(view.agentEndpoint === undefined ? {} : { agentEndpoint: view.agentEndpoint }),
    runtime: {
      ref: view.runtime.ref,
      status: view.runtime.status,
      ...(ownership
        ? {
            ownership: {
              operationId: ownership.operationId,
              ...(ownership.phase !== undefined ? { phase: ownership.phase } : {}),
              ...(ownership.phase === "active"
                ? {
                    dispatchId: ownership.dispatchId,
                    executionAttemptId: ownership.executionAttemptId
                  }
                : {})
            }
          }
        : {}),
      ...(view.runtime.interruption ? { interruption: view.runtime.interruption } : {}),
      ...(terminalReceipt
        ? {
            terminalReceipt: {
              ...(terminalReceipt.operationId !== undefined
                ? { operationId: terminalReceipt.operationId }
                : {}),
              ...(terminalReceipt.outcome !== undefined
                ? { outcome: terminalReceipt.outcome }
                : {}),
              ...("summary" in terminalReceipt ? { summary: terminalReceipt.summary } : {})
            }
          }
        : {}),
      ...(view.runtime.blockedReason !== undefined
        ? { blockedReason: view.runtime.blockedReason }
        : {}),
      ...(view.runtime.divergenceReason !== undefined
        ? { divergenceReason: view.runtime.divergenceReason }
        : {})
    }
  });
}

export type OperatorRemoteOperationsPort = {
  dispatchRemoteOperation(command: RemoteDispatchIntentV3): Promise<RemoteOperationObservation>;
  observeRemoteOperation(operationId: string): Promise<RemoteOperationObservation>;
  executeRemoteOperationAction(
    operationId: string,
    action: RemoteHumanExecutionActionCommand
  ): Promise<RemoteActionView>;
};

export function createOperatorRemoteOperationsPort(input: {
  json<T>(
    method: "GET" | "POST",
    path: string,
    schema: ZodType<T>,
    options?: { body?: unknown; accept?: string }
  ): Promise<T>;
}): OperatorRemoteOperationsPort {
  return {
    async dispatchRemoteOperation(command) {
      const body = remoteDispatchIntentV3Schema.parse(command);
      return operatorObservationToRemoteRun(
        await input.json("POST", "/api/v1/remote-operations", operatorOperationViewSchema, {
          body,
          accept: OPERATOR_PUBLIC_RUNTIME_MEDIA_TYPE
        })
      );
    },
    async observeRemoteOperation(operationId) {
      return operatorObservationToRemoteRun(
        await input.json(
          "GET",
          `/api/v1/remote-operations/${encodeURIComponent(operationId)}`,
          operatorOperationViewSchema,
          { accept: OPERATOR_PUBLIC_RUNTIME_MEDIA_TYPE }
        )
      );
    },
    async executeRemoteOperationAction(operationId, action) {
      return remoteActionViewSchema.parse(
        await input.json(
          "POST",
          `/api/v1/remote-operations/${encodeURIComponent(operationId)}/actions`,
          remoteActionViewSchema,
          { body: remoteHumanExecutionActionCommandSchema.parse(action) }
        )
      );
    }
  };
}
