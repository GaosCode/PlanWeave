import type { RemoteWorkspaceExecutionHandle } from "@planweave-ai/runtime/browser";
import { remoteAgentAuthorizationErrorCodeSchema } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import {
  remoteAttemptStatusSchema,
  remoteOperationStateSchema
} from "@planweave-ai/collaboration-protocol/remote-run";
import type {
  DesktopWorkspaceExecutionResponse,
  DesktopWorkspaceExecutionResumeResult
} from "../../shared/workspaceExecution.js";
import type { createTranslator } from "../i18n";

type Translator = ReturnType<typeof createTranslator>;

export function remoteRunOperationObservation(view: DesktopWorkspaceExecutionResponse) {
  const handle = view.handle;
  if (handle.target !== "remote") return undefined;
  const event = view.events.find(
    (item) =>
      item.type === "operation_observed" &&
      item.source.target === "remote" &&
      item.source.operationId === handle.operationId &&
      item.source.executionAttemptId === handle.executionAttemptId &&
      item.data.operationRevision === handle.operationRevision
  );
  if (event?.type !== "operation_observed") return undefined;
  const state = remoteOperationStateSchema.safeParse(event.data.state);
  const attemptStatus = remoteAttemptStatusSchema.safeParse(event.data.attemptStatus);
  if (!state.success || !attemptStatus.success) return undefined;
  return { state: state.data, attemptStatus: attemptStatus.data };
}

export type RemoteRunResumeObservation = {
  expected: RemoteWorkspaceExecutionHandle;
  observedLoad: boolean;
  receipt: "unknown" | "recorded" | "not_recorded" | { leaseId: string };
  paused: boolean;
};

export function remoteRunResumeOutcome(
  { expected, observedLoad, receipt }: RemoteRunResumeObservation,
  view: DesktopWorkspaceExecutionResponse
) {
  const handle = view.handle;
  if (
    handle.target !== "remote" ||
    handle.operationId !== expected.operationId ||
    handle.dispatchId !== expected.dispatchId ||
    handle.executionAttemptId !== expected.executionAttemptId ||
    handle.runSessionId !== expected.runSessionId ||
    handle.agentEndpointId !== expected.agentEndpointId ||
    handle.authorityBindingId !== expected.authorityBindingId
  ) {
    return "changed";
  }
  if (view.session.phase === "failed" || view.session.phase === "stopped") return "failed";
  const completed = view.session.phase === "completed";
  if (!handle.leaseId || handle.leaseId === expected.leaseId)
    return completed ? "failed" : "awaiting";
  if (typeof receipt !== "object") return "awaiting";
  if (handle.leaseId !== receipt.leaseId) return "changed";
  if (view.remoteResume || remoteRunOperationObservation(view)?.state === "interrupted")
    return "failed";
  const loaded =
    observedLoad ||
    view.events.some((event) => {
      if (
        event.type !== "runner_event" ||
        event.source.target !== "remote" ||
        event.source.operationId !== expected.operationId ||
        event.source.executionAttemptId !== expected.executionAttemptId ||
        event.data.eventProtocolVersion !== 2
      )
        return false;
      const { cursor, fragment } = event.data.event;
      return (
        cursor > expected.cursor.eventCursor &&
        fragment.kind === "engine_evidence" &&
        fragment.evidence.kind === "session_started" &&
        fragment.evidence.loaded
      );
    });
  if (loaded) return "resumed";
  return completed ? "failed" : "awaiting";
}

export function remoteRunResumeProgress(
  receipt: DesktopWorkspaceExecutionResumeResult
): RemoteRunResumeObservation["receipt"] {
  if (receipt.state === "rejected") throw new Error(receipt.rejectionCode);
  if ("leaseId" in receipt) return { leaseId: receipt.leaseId };
  return receipt.state;
}

export function remoteRunResumeFailure(code: string, t: Translator) {
  switch (code) {
    case "human_auth_unauthenticated":
    case "human_cross_project_forbidden":
    case "operator_human_identity_unauthorized":
    case "operator_human_identity_forbidden":
    case "operator_unauthorized":
    case "remote_resume_authorization_changed":
    case "remote_resume_rejected":
      return { message: t("remoteRunResumeDenied"), requiresRefresh: true };
    case "remote_resume_receipt_identity_mismatch":
    case "collaboration_workspace_connection_mismatch":
    case "workspace_execution_locator_mismatch":
    case "workspace_execution_scope_mismatch":
    case "workspace_execution_resume_mismatch":
    case "workspace_execution_authority_mismatch":
    case "remote_attempt_changed":
    case "remote_action_attempt_version_conflict":
    case "remote_resume_attempt_conflict":
    case "operator_operation_conflict":
    case "remote_agent_policy_revision_conflict":
    case "remote_agent_grant_revision_conflict":
    case "human_remote_operation_conflict":
    case "operator_resource_not_found":
    case "human_remote_resource_not_found":
      return { message: t("remoteRunResumeChanged"), requiresRefresh: true };
    case "remote_resume_unavailable":
      return { message: t("remoteRunResumeUnavailable"), requiresRefresh: true };
    case "remote_resume_host_unavailable":
      return { message: t("remoteRunResumeHostUnavailable"), requiresRefresh: false };
    case "remote_resume_host_capacity_exhausted":
      return { message: t("remoteRunResumeHostCapacity"), requiresRefresh: false };
    default:
      if (remoteAgentAuthorizationErrorCodeSchema.safeParse(code).success)
        return { message: t("remoteRunResumeDenied"), requiresRefresh: true };
      return { message: t("remoteRunResumeFailed"), requiresRefresh: false };
  }
}

export function remoteRunResumeAvailabilityLabel(
  view: DesktopWorkspaceExecutionResponse | null,
  bridgeSupportsResume: boolean,
  t: Translator
): string {
  const capability = view?.remoteResume;
  if (!bridgeSupportsResume || !capability) return t("remoteRunResumeUnsupported");
  if (capability.available) return t("remoteRunResumeUnavailable");
  switch (capability.reason) {
    case "unsupported":
      return t("remoteRunResumeUnsupported");
    case "prior_lease_not_fenced":
      return t("remoteRunResumePriorLeaseActive");
    case "recovery_evidence_missing":
      return t("remoteRunResumeEvidenceMissing");
    case "request_failed":
      return capability.code
        ? remoteRunResumeFailure(capability.code, t).message
        : t("remoteRunResumeUnavailable");
    case "not_interrupted":
      return t("remoteRunResumeChanged");
  }
}
