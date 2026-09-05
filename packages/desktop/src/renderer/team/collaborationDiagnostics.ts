import type { CurrentCanvasAccessView } from "@planweave-ai/collaboration-protocol/access/control";
import type { CollaborationStatus } from "../../shared/collaboration.js";
import type { CollaborationReadModelSnapshot } from "../../shared/collaborationReadModels.js";

const SECRET_PATTERN = /\b(?:Bearer\s+)?pw_(?:hdev|inv|setup|op|enroll)_[A-Za-z0-9_-]+\b/gi;

function diagnosticValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "none";
  return String(value)
    .replace(SECRET_PATTERN, "[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
}

function observerUrl(serverBaseUrl: string, projectId: string): string {
  try {
    const url = new URL(serverBaseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/api/v1/projects/${encodeURIComponent(projectId)}/human/observe`;
    return url.toString();
  } catch {
    return "invalid";
  }
}

function membersUrl(serverBaseUrl: string, projectId: string): string {
  try {
    const url = new URL(serverBaseUrl);
    url.pathname = `/api/v1/projects/${encodeURIComponent(projectId)}/human/members`;
    return url.toString();
  } catch {
    return "invalid";
  }
}

export type CollaborationReadModelDiagnosticContext = Pick<
  CollaborationReadModelSnapshot,
  | "profileId"
  | "projectId"
  | "canvasId"
  | "syncPhase"
  | "observerCursor"
  | "members"
  | "loadingKinds"
  | "lastError"
  | "updatedAt"
>;

/** Builds an allowlisted, copy-safe report. Credentials and invitation secrets are never included. */
export function buildCollaborationDiagnosticReport(
  status: CollaborationStatus,
  platform = typeof navigator === "undefined" ? "unknown" : navigator.platform || "unknown",
  readModel?: CollaborationReadModelDiagnosticContext | null,
  access?: CurrentCanvasAccessView | null
): string {
  const activeProfile =
    status.profiles.find((profile) => profile.profileId === status.activeProfileId) ?? null;
  const workspace = status.workspaceConnection;
  const workspaceProfile = workspace.profile;
  const lines = [
    "planweave.collaboration.diagnostics/v1",
    `captured_at=${diagnosticValue(status.updatedAt)}`,
    `platform=${diagnosticValue(platform)}`,
    `workspace.status=${diagnosticValue(workspace.status)}`,
    `workspace.id=${diagnosticValue(workspace.workspaceId)}`,
    `workspace.name=${diagnosticValue(workspace.workspaceDisplayName)}`,
    `workspace.server_url=${diagnosticValue(workspaceProfile?.serverBaseUrl)}`,
    `workspace.allow_insecure_transport=${diagnosticValue(
      workspaceProfile?.allowInsecureTransport
    )}`,
    `workspace.error_code=${diagnosticValue(workspace.error?.code)}`,
    `workspace.error_message=${diagnosticValue(workspace.error?.message)}`,
    `workspace.error_retryable=${diagnosticValue(workspace.error?.retryable)}`,
    `session.phase=${diagnosticValue(status.session.phase)}`,
    `session.detail=${diagnosticValue(status.session.detail)}`,
    `session.error_code=${diagnosticValue(status.session.lastErrorCode)}`,
    `session.error_message=${diagnosticValue(status.session.lastErrorMessage)}`,
    `credential.storage=${diagnosticValue(status.credentialStorage)}`,
    `credential.warning=${status.nonPersistenceWarning ? "present" : "none"}`,
    `profile.id=${diagnosticValue(activeProfile?.profileId)}`,
    `profile.server_url=${diagnosticValue(activeProfile?.serverBaseUrl)}`,
    `profile.observer_url=${diagnosticValue(
      activeProfile ? observerUrl(activeProfile.serverBaseUrl, activeProfile.projectId) : null
    )}`,
    `profile.members_url=${diagnosticValue(
      activeProfile ? membersUrl(activeProfile.serverBaseUrl, activeProfile.projectId) : null
    )}`,
    `profile.project_id=${diagnosticValue(activeProfile?.projectId)}`,
    `profile.allow_insecure_transport=${diagnosticValue(activeProfile?.allowInsecureTransport)}`,
    `profile.has_device_credential=${diagnosticValue(activeProfile?.hasDeviceCredential)}`,
    `profile.credential_persistence=${diagnosticValue(activeProfile?.deviceCredentialPersistence)}`,
    `read_model.profile_id=${diagnosticValue(readModel?.profileId)}`,
    `read_model.project_id=${diagnosticValue(readModel?.projectId)}`,
    `read_model.canvas_id=${diagnosticValue(readModel?.canvasId)}`,
    `read_model.sync_phase=${diagnosticValue(readModel?.syncPhase)}`,
    `read_model.observer_cursor=${diagnosticValue(readModel?.observerCursor)}`,
    `read_model.loading_kinds=${diagnosticValue(readModel?.loadingKinds.join(","))}`,
    `read_model.member_count=${diagnosticValue(readModel?.members.length)}`,
    `read_model.updated_at=${diagnosticValue(readModel?.updatedAt)}`,
    `read_model.error_kind=${diagnosticValue(readModel?.lastError?.kind)}`,
    `read_model.error_code=${diagnosticValue(readModel?.lastError?.code)}`,
    `read_model.error_http_status=${diagnosticValue(readModel?.lastError?.httpStatus)}`,
    `read_model.error_retryable=${diagnosticValue(readModel?.lastError?.retryable)}`,
    `read_model.error_retry_after_ms=${diagnosticValue(readModel?.lastError?.retryAfterMs)}`,
    `read_model.error_message=${diagnosticValue(readModel?.lastError?.message)}`,
    `access.workspace_id=${diagnosticValue(access?.scope.workspaceId)}`,
    `access.project_id=${diagnosticValue(access?.scope.projectId)}`,
    `access.canvas_id=${diagnosticValue(access?.scope.canvasId)}`,
    `access.project_visibility=${diagnosticValue(access?.projectVisibility)}`,
    `access.project_role=${diagnosticValue(access?.project.effectiveRole)}`,
    `access.project_role_source=${diagnosticValue(access?.project.roleSource)}`,
    `access.project_disabled_reason=${diagnosticValue(access?.project.disabledReason)}`,
    `access.canvas_visibility=${diagnosticValue(access?.canvasVisibility)}`,
    `access.canvas_role=${diagnosticValue(access?.canvas.effectiveRole)}`,
    `access.canvas_role_source=${diagnosticValue(access?.canvas.roleSource)}`,
    `access.canvas_disabled_reason=${diagnosticValue(access?.canvas.disabledReason)}`
  ];
  return lines.join("\n");
}
