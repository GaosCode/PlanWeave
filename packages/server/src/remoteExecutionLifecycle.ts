import {
  acpRecoveryIdentitySchema,
  dispatchIdSchema,
  executionAttemptIdSchema,
  leaseIdSchema,
  normalizedFailureSchema,
  opaqueIdentifierSchema
} from "@planweave-ai/agent-host-protocol";
import { z } from "zod";
import { remoteAttemptStatusSchema } from "./remoteOperations.js";

const actionReasonSchema = z.string().trim().min(1).max(4_096);
const actionIdSchema = opaqueIdentifierSchema;
const expectedAttemptVersionSchema = z.number().int().nonnegative();

const actionIdentityShape = {
  actionId: actionIdSchema,
  operationId: opaqueIdentifierSchema,
  dispatchId: dispatchIdSchema,
  executionAttemptId: executionAttemptIdSchema,
  expectedAttemptVersion: expectedAttemptVersionSchema
};

export const remoteExecutionActionRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...actionIdentityShape,
      kind: z.literal("resume_same_session"),
      priorLeaseId: leaseIdSchema,
      leaseId: leaseIdSchema,
      leaseExpiresAt: z.iso.datetime(),
      recovery: acpRecoveryIdentitySchema,
      reason: actionReasonSchema
    })
    .strict()
    .refine((action) => action.priorLeaseId !== action.leaseId, {
      message: "Resume requires a fresh lease identity.",
      path: ["leaseId"]
    }),
  z
    .object({
      ...actionIdentityShape,
      kind: z.literal("retry_new_attempt"),
      priorLeaseId: leaseIdSchema,
      newDispatchId: dispatchIdSchema,
      newExecutionAttemptId: executionAttemptIdSchema,
      reason: actionReasonSchema
    })
    .strict()
    .refine((action) => action.executionAttemptId !== action.newExecutionAttemptId, {
      message: "Retry requires a new execution attempt identity.",
      path: ["newExecutionAttemptId"]
    })
    .refine((action) => action.dispatchId !== action.newDispatchId, {
      message: "Retry requires a new dispatch identity.",
      path: ["newDispatchId"]
    }),
  z
    .object({
      ...actionIdentityShape,
      kind: z.literal("fail"),
      leaseId: leaseIdSchema,
      failure: normalizedFailureSchema,
      reason: actionReasonSchema
    })
    .strict(),
  z
    .object({
      ...actionIdentityShape,
      kind: z.literal("block"),
      leaseId: leaseIdSchema,
      reason: actionReasonSchema
    })
    .strict(),
  z
    .object({
      ...actionIdentityShape,
      kind: z.literal("cancel"),
      leaseId: leaseIdSchema,
      reason: actionReasonSchema
    })
    .strict()
]);

export const remoteExecutionActionStateSchema = z.enum([
  "recorded",
  "delivered",
  "acknowledged",
  "settled",
  "rejected"
]);

export const remoteExecutionActionRejectionCodeSchema = z.enum(["work_not_agent_assigned"]);

export type RemoteExecutionActionRequest = z.infer<typeof remoteExecutionActionRequestSchema>;
export type RemoteExecutionActionState = z.infer<typeof remoteExecutionActionStateSchema>;
export type RemoteExecutionActionRejectionCode = z.infer<
  typeof remoteExecutionActionRejectionCodeSchema
>;

export type RemoteExecutionLifecycleSnapshot = {
  dispatchState: "persisted" | "preparation";
  operationId: string;
  dispatchId: string;
  executionAttemptId: string;
  attemptStatus: z.infer<typeof remoteAttemptStatusSchema>;
  attemptVersion: number;
  leaseId?: string;
  leaseFenced: boolean;
  interruption?: {
    resumable: boolean;
    recovery?: z.infer<typeof acpRecoveryIdentitySchema>;
  };
  hostCapabilities: readonly string[];
};

export type RemoteExecutionActionDecision =
  | { transition: "resume"; sendsCommand: true }
  | { transition: "retry"; sendsCommand: false }
  | { transition: "fail"; sendsCommand: false }
  | { transition: "block"; sendsCommand: false }
  | { transition: "cancel"; sendsCommand: true };

function assertCommonIdentity(
  action: RemoteExecutionActionRequest,
  snapshot: RemoteExecutionLifecycleSnapshot
): void {
  if (
    action.operationId !== snapshot.operationId ||
    action.dispatchId !== snapshot.dispatchId ||
    action.executionAttemptId !== snapshot.executionAttemptId
  ) {
    throw new Error("remote_action_identity_mismatch");
  }
  if (action.expectedAttemptVersion !== snapshot.attemptVersion) {
    throw new Error("remote_action_attempt_version_conflict");
  }
}

function assertLease(actionLeaseId: string, snapshot: RemoteExecutionLifecycleSnapshot): void {
  if (!snapshot.leaseId || actionLeaseId !== snapshot.leaseId) {
    throw new Error("remote_action_lease_mismatch");
  }
}

export function decideRemoteExecutionAction(
  rawAction: unknown,
  snapshot: RemoteExecutionLifecycleSnapshot
): RemoteExecutionActionDecision {
  const action = remoteExecutionActionRequestSchema.parse(rawAction);
  z.enum(["persisted", "preparation"]).parse(snapshot.dispatchState);
  remoteAttemptStatusSchema.parse(snapshot.attemptStatus);
  assertCommonIdentity(action, snapshot);
  if (snapshot.dispatchState === "preparation" && action.kind !== "retry_new_attempt") {
    throw new Error("remote_preparation_action_requires_retry");
  }

  switch (action.kind) {
    case "resume_same_session": {
      assertLease(action.priorLeaseId, snapshot);
      if (snapshot.attemptStatus !== "interrupted" || !snapshot.leaseFenced) {
        throw new Error("remote_resume_attempt_not_interrupted_and_fenced");
      }
      if (!snapshot.hostCapabilities.includes("acp.session.load")) {
        throw new Error("remote_resume_session_load_unsupported");
      }
      const recovery = snapshot.interruption?.recovery;
      if (!snapshot.interruption?.resumable || !recovery) {
        throw new Error("remote_resume_recovery_evidence_missing");
      }
      if (
        recovery.acpSessionId !== action.recovery.acpSessionId ||
        recovery.recoveryId !== action.recovery.recoveryId
      ) {
        throw new Error("remote_resume_recovery_identity_mismatch");
      }
      return { transition: "resume", sendsCommand: true };
    }
    case "retry_new_attempt":
      assertLease(action.priorLeaseId, snapshot);
      if (
        (snapshot.attemptStatus !== "interrupted" &&
          snapshot.attemptStatus !== "action_required") ||
        !snapshot.leaseFenced
      ) {
        throw new Error("remote_retry_prior_attempt_not_fenced");
      }
      if (snapshot.interruption?.resumable !== false) {
        throw new Error("remote_retry_resume_still_available");
      }
      return { transition: "retry", sendsCommand: false };
    case "fail":
      assertLease(action.leaseId, snapshot);
      if (
        snapshot.attemptStatus !== "interrupted" &&
        snapshot.attemptStatus !== "action_required"
      ) {
        throw new Error("remote_fail_attempt_not_action_required");
      }
      return { transition: "fail", sendsCommand: false };
    case "block":
      assertLease(action.leaseId, snapshot);
      if (snapshot.attemptStatus !== "interrupted") {
        throw new Error("remote_block_attempt_not_interrupted");
      }
      return { transition: "block", sendsCommand: false };
    case "cancel":
      assertLease(action.leaseId, snapshot);
      if (
        snapshot.leaseFenced ||
        (snapshot.attemptStatus !== "activated" && snapshot.attemptStatus !== "running")
      ) {
        throw new Error("remote_cancel_attempt_not_active");
      }
      return { transition: "cancel", sendsCommand: true };
  }
}

export function nextRemoteExecutionActionState(
  current: RemoteExecutionActionState,
  next: RemoteExecutionActionState
): RemoteExecutionActionState {
  if (current === next) return current;
  const allowed: Readonly<
    Record<RemoteExecutionActionState, readonly RemoteExecutionActionState[]>
  > = {
    recorded: ["delivered", "settled", "rejected"],
    delivered: ["acknowledged", "settled"],
    acknowledged: ["settled"],
    settled: [],
    rejected: []
  };
  if (!allowed[current].includes(next)) throw new Error("remote_action_state_transition_invalid");
  return next;
}
