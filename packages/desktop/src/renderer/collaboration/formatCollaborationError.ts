import type { CollaborationBoundaryErrorView } from "../../shared/collaborationReadModels.js";
import type { createTranslator } from "../i18n";
import {
  formatCollaborationBoundaryError,
  formatUnknownCollaborationError,
  stripElectronRemoteInvokeMessage
} from "./peopleViewModels.js";

const collaborationErrorCodePattern = /^[A-Za-z0-9_.-]{1,96}$/;

export function collaborationErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  const raw =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : "";
  if (!raw.trim()) return null;
  const stripped = stripElectronRemoteInvokeMessage(raw).trim();
  const named = stripped.match(/^(?:[\w.]+Error:\s*)*([A-Za-z0-9_.-]{1,96})$/);
  const candidate = named?.[1] ?? stripped;
  return collaborationErrorCodePattern.test(candidate) ? candidate : null;
}

export function logCollaborationRendererError(scope: string, error: unknown): void {
  const code = collaborationErrorCode(error);
  const message = collaborationErrorMessage(error);
  console.error(`[planweave.collaboration] ${scope}`, {
    code,
    message,
    error
  });
}

export function collaborationDeveloperErrorDetail(
  error: unknown,
  formatted: string
): string | null {
  const code = collaborationErrorCode(error);
  const raw =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : "";
  const parts = [
    code && !formatted.includes(code) ? code : null,
    raw && raw !== formatted && !formatted.includes(raw) ? raw : null
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function collaborationErrorMessage(
  error: CollaborationBoundaryErrorView | unknown | null | undefined
): string {
  if (error == null) {
    return "collaboration_error";
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    "kind" in error &&
    "retryable" in error
  ) {
    return (
      formatCollaborationBoundaryError(error as CollaborationBoundaryErrorView) ??
      "collaboration_error"
    );
  }
  return formatUnknownCollaborationError(error);
}

export function isCollaborationConnectionUnavailable(error: unknown): boolean {
  const code = collaborationErrorCode(error);
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  const kind = typeof record?.kind === "string" ? record.kind : null;
  const message =
    error instanceof Error
      ? error.message
      : typeof record?.message === "string"
        ? record.message
        : null;
  return (
    kind === "offline" ||
    kind === "network" ||
    kind === "timeout" ||
    code === "collaboration_offline" ||
    code === "collaboration_timeout" ||
    code === "network_unreachable" ||
    code === "canvas_replica_session_disconnected" ||
    (message !== null &&
      /fetch failed|network request failed|network unreachable|timed?\s*out|canvas_replica_session_disconnected/i.test(
        message
      ))
  );
}

export function collaborationConnectionErrorMessage(
  t: ReturnType<typeof createTranslator>,
  error: unknown
): string {
  const code = collaborationErrorCode(error);
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : "";
  if (
    code === "local_collaboration_selection_required" ||
    code === "local_collaboration_profile_unavailable" ||
    message.includes("local_collaboration_selection_required") ||
    message.includes("local_collaboration_profile_unavailable")
  ) {
    return t("peopleLocalOwnerRestoreUnavailable");
  }
  if (
    code === "collaboration_credential_missing" ||
    message.includes("collaboration_credential_missing")
  ) {
    return t("peopleMissingCredential");
  }
  if (code === "PRIVATE_NETWORK_UNREACHABLE") {
    return t("peoplePrivateNetworkUnreachable");
  }
  if (code === "WORKSPACE_FORBIDDEN") {
    return t("peopleWorkspaceForbidden");
  }
  if (code === "WORKSPACE_UNAUTHORIZED") {
    return t("peopleWorkspaceUnauthorized");
  }
  if (isCollaborationConnectionUnavailable(error)) {
    return t("peopleServerUnreachable");
  }
  return t("peopleConnectionUnexpectedError");
}
