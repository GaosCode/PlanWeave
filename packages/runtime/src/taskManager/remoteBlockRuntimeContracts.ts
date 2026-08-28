import {
  artifactRefSchema,
  blockRefSchema,
  dispatchIdSchema,
  executionAttemptIdSchema,
  executionEnvelopeSchema,
  normalizedFailureSchema,
  normalizedAcpEventSchema,
  opaqueIdentifierSchema,
  OUTPUT_MAX_ARTIFACT_BYTES
} from "@planweave-ai/agent-host-protocol/browser";
import { z } from "zod";
import { redactRunnerEventText } from "../autoRun/runnerEventRedaction.js";
import {
  activeRemoteBlockOwnershipSchema,
  remoteExecutionControlPlaneSchema,
  remoteBlockOwnershipSchema,
  remoteInterruptionSchema,
  remoteOperationReceiptSchema
} from "../schema/remoteOwnership.js";
import { blockStatuses } from "../types/state.js";

const envelopeShape = executionEnvelopeSchema.shape;

const publicRemoteFailureCodes = [
  "acp_incomplete_response",
  "acp_operation_timeout",
  "acp_process_error",
  "acp_protocol_error",
  "acp_capability_missing",
  "acp_unknown_error",
  "acp_authentication_required",
  "acp_limit_exceeded",
  "acp_interaction_failed",
  "acp_interaction_timeout",
  "authentication_failed",
  "execution_cancelled",
  "executor_failed",
  "lease_expired",
  "persistence_failed",
  "protocol_error",
  "report_output_missing",
  "report_output_too_large",
  "remote_execution_failed",
  "transport_failed"
] as const;

const publicRemoteFailureCodeSchema = z.enum(publicRemoteFailureCodes);
type PublicRemoteFailureCode = z.infer<typeof publicRemoteFailureCodeSchema>;

const publicFailureMessagesByCode: Readonly<Record<PublicRemoteFailureCode, string>> = {
  acp_incomplete_response: "Remote ACP execution ended without a complete response.",
  acp_operation_timeout: "Remote ACP execution timed out.",
  acp_process_error: "Remote ACP process failed.",
  acp_protocol_error: "Remote ACP protocol failed.",
  acp_capability_missing: "Remote ACP capability is missing.",
  acp_unknown_error: "ACP execution failed.",
  acp_authentication_required: "ACP authentication is required.",
  acp_limit_exceeded: "ACP execution exceeded a configured limit.",
  acp_interaction_failed: "ACP interaction handling failed.",
  acp_interaction_timeout: "ACP interaction handling timed out.",
  authentication_failed: "Remote authentication failed.",
  execution_cancelled: "Remote execution was cancelled.",
  executor_failed: "Remote executor failed.",
  lease_expired: "Remote execution lease expired.",
  persistence_failed: "Remote persistence failed.",
  protocol_error: "Remote protocol failed.",
  report_output_missing: "Remote ACP execution completed without report output.",
  report_output_too_large: "Remote ACP report output exceeded its artifact contract.",
  remote_execution_failed: "Remote execution failed.",
  transport_failed: "Remote transport failed."
};

/** Codes where Host already redacts ACP engine diagnostics; keep the detail for operators. */
const diagnosticPreservingFailureCodes = new Set<PublicRemoteFailureCode>([
  "acp_unknown_error",
  "acp_authentication_required",
  "acp_limit_exceeded",
  "acp_interaction_failed",
  "acp_interaction_timeout"
]);

const PUBLIC_FAILURE_MESSAGE_MAX_CHARS = 2_048;

function looksLikePrivateFilesystemPath(value: string): boolean {
  return (
    /(?:^|[\s"'`(])(?:\/(?:Users|home|root|var\/folders|tmp)\/|[A-Za-z]:\\(?:Users|Windows|Program Files)\\|\\\\)/i.test(
      value
    ) || /\bfile:\/\//i.test(value)
  );
}

function publicRemoteFailureMessage(code: PublicRemoteFailureCode, wireMessage: string): string {
  const base = publicFailureMessagesByCode[code];
  if (!diagnosticPreservingFailureCodes.has(code)) return base;
  const redacted = redactRunnerEventText(wireMessage).text.trim();
  if (!redacted || looksLikePrivateFilesystemPath(redacted)) return base;
  return redacted.length <= PUBLIC_FAILURE_MESSAGE_MAX_CHARS
    ? redacted
    : redacted.slice(0, PUBLIC_FAILURE_MESSAGE_MAX_CHARS);
}

/**
 * Runtime-safe terminal failure: unknown Host codes stay opaque, while selected ACP codes
 * keep redacted engine diagnostics (e.g. provider usage limits) for operator localization.
 */
export const publicRemoteFailureSchema = normalizedFailureSchema.transform((failure) => {
  const parsedCode = publicRemoteFailureCodeSchema.safeParse(failure.code);
  const code: PublicRemoteFailureCode = parsedCode.success
    ? parsedCode.data
    : "remote_execution_failed";
  return {
    code,
    message: publicRemoteFailureMessage(code, failure.message),
    retryable: failure.retryable
  };
});

/** Runtime-owned, portable fields used by Server to assemble one Execution Envelope. */
export const remoteBlockDispatchCandidateSchema = z
  .object({
    projectId: envelopeShape.projectId,
    canvasId: envelopeShape.canvasId,
    taskId: envelopeShape.taskId,
    blockRef: envelopeShape.blockRef,
    blockType: envelopeShape.blockType,
    sourceRevision: envelopeShape.sourceRevision,
    graphFingerprint: envelopeShape.graphFingerprint.unwrap(),
    renderedPrompt: envelopeShape.renderedPrompt,
    acceptance: envelopeShape.acceptance,
    dependencySummaries: envelopeShape.dependencySummaries,
    inputArtifacts: envelopeShape.inputArtifacts,
    workspaceId: envelopeShape.workspaceId,
    effectiveExecutor: opaqueIdentifierSchema,
    agentId: envelopeShape.agentId,
    agentProfileId: envelopeShape.agentProfileId,
    session: envelopeShape.session,
    requiredCapabilities: envelopeShape.requiredCapabilities
  })
  .strict();

export const remoteBlockClaimInputSchema = z
  .object({
    ref: blockRefSchema,
    operationId: opaqueIdentifierSchema,
    controlPlane: remoteExecutionControlPlaneSchema,
    sourceRevision: envelopeShape.sourceRevision,
    graphFingerprint: envelopeShape.graphFingerprint.unwrap()
  })
  .strict();

export const remoteBlockInspectInputSchema = z.object({ ref: blockRefSchema }).strict();

export const remoteBlockOperationQuerySchema = z
  .object({ ref: blockRefSchema, operationId: opaqueIdentifierSchema })
  .strict();

export const remoteBlockActiveIdentitySchema = activeRemoteBlockOwnershipSchema.omit({
  phase: true
});

export const remoteBlockRefIdentitySchema = remoteBlockActiveIdentitySchema.extend({
  ref: blockRefSchema
});

export const remoteBlockCompletionInputSchema = remoteBlockRefIdentitySchema.extend({
  reportArtifactRef: artifactRefSchema,
  reportBytes: z
    .instanceof(Uint8Array)
    .refine((bytes) => bytes.byteLength > 0, "report bytes must not be empty")
    .refine(
      (bytes) => bytes.byteLength <= OUTPUT_MAX_ARTIFACT_BYTES,
      `report bytes must not exceed ${OUTPUT_MAX_ARTIFACT_BYTES} bytes`
    ),
  transcript: z
    .object({
      sessionId: z.string().min(1).max(256),
      executor: opaqueIdentifierSchema,
      agentId: envelopeShape.agentId,
      events: z
        .array(
          z
            .object({
              timestamp: z.string().datetime(),
              event: normalizedAcpEventSchema
            })
            .strict()
        )
        .max(100_000)
    })
    .strict()
    .optional()
});

export const remoteBlockFailureInputSchema = remoteBlockRefIdentitySchema.extend({
  failure: publicRemoteFailureSchema,
  /** When present, Task Workspace failure materialization labels the run with this agent. */
  agentId: envelopeShape.agentId.optional()
});

export const remoteBlockInterruptionInputSchema = remoteBlockRefIdentitySchema.extend({
  interruption: remoteInterruptionSchema,
  /** When present, Task Workspace failure materialization labels the run with this agent. */
  agentId: envelopeShape.agentId.optional()
});

export const remoteBlockRetryAttemptInputSchema = remoteBlockRefIdentitySchema
  .extend({
    newDispatchId: dispatchIdSchema,
    newExecutionAttemptId: executionAttemptIdSchema
  })
  .refine((input) => input.executionAttemptId !== input.newExecutionAttemptId, {
    message: "A remote retry requires a new execution attempt identity.",
    path: ["newExecutionAttemptId"]
  });

export const remoteBlockBindingViewSchema = z
  .object({
    ref: blockRefSchema,
    status: z.enum(blockStatuses),
    ownership: remoteBlockOwnershipSchema.optional(),
    interruption: remoteInterruptionSchema.optional(),
    terminalReceipt: remoteOperationReceiptSchema.optional(),
    blockedReason: z.string().nullable().optional(),
    divergenceReason: z.string().nullable().optional()
  })
  .strict();

export const remoteBlockRetryDecisionSchema = z.enum([
  "resume_exact_attempt",
  "manual_retry_required",
  "not_retryable"
]);

export const remoteBlockMutationResultSchema = z
  .object({
    binding: remoteBlockBindingViewSchema,
    retryDecision: remoteBlockRetryDecisionSchema
  })
  .strict();

export const remoteBlockCompletionResultSchema = z
  .object({
    ref: blockRefSchema,
    runId: opaqueIdentifierSchema,
    status: z.literal("completed")
  })
  .strict();

export type RemoteBlockDispatchCandidate = z.infer<typeof remoteBlockDispatchCandidateSchema>;
export type RemoteBlockClaimInput = z.infer<typeof remoteBlockClaimInputSchema>;
export type RemoteBlockInspectInput = z.infer<typeof remoteBlockInspectInputSchema>;
export type RemoteBlockOperationQuery = z.infer<typeof remoteBlockOperationQuerySchema>;
export type RemoteBlockActiveIdentity = z.infer<typeof remoteBlockActiveIdentitySchema>;
export type RemoteBlockRefIdentity = z.infer<typeof remoteBlockRefIdentitySchema>;
export type RemoteBlockCompletionInput = z.infer<typeof remoteBlockCompletionInputSchema>;
export type RemoteBlockFailureInput = z.infer<typeof remoteBlockFailureInputSchema>;
export type RemoteBlockInterruptionInput = z.infer<typeof remoteBlockInterruptionInputSchema>;
export type RemoteBlockRetryAttemptInput = z.infer<typeof remoteBlockRetryAttemptInputSchema>;
export type RemoteBlockBindingView = z.infer<typeof remoteBlockBindingViewSchema>;
export type RemoteBlockRetryDecision = z.infer<typeof remoteBlockRetryDecisionSchema>;
export type RemoteBlockMutationResult = z.infer<typeof remoteBlockMutationResultSchema>;
export type RemoteBlockCompletionResult = z.infer<typeof remoteBlockCompletionResultSchema>;

export type RemoteBlockRuntimeErrorCode =
  | "remote_block_not_found"
  | "remote_block_not_executable"
  /** @deprecated Alias kept for older tests/callers; prefer remote_block_not_executable. */
  | "remote_block_not_implementation"
  | "remote_block_not_dispatchable"
  | "remote_block_executor_not_acp"
  | "remote_block_source_changed"
  | "remote_block_result_conflict";

export class RemoteBlockRuntimeError extends Error {
  readonly code: RemoteBlockRuntimeErrorCode;

  constructor(code: RemoteBlockRuntimeErrorCode, message: string) {
    super(message);
    this.name = "RemoteBlockRuntimeError";
    this.code = code;
  }
}
