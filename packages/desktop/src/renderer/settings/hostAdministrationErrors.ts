import { OperatorControlError } from "../../shared/operatorControl";
import type { createTranslator } from "../i18n";

const knownErrorCodes = new Set([
  "operator_bridge_unavailable",
  "operator_credential_missing",
  "operator_profile_missing",
  "operator_profile_not_found",
  "operator_offline",
  "operator_timeout",
  "operator_unauthorized",
  "operator_credential_invalid",
  "operator_admin_required",
  "operator_server_admin_required",
  "operator_forbidden",
  "operator_host_pagination_cursor_repeated",
  "operator_host_pagination_cursor_regressed",
  "operator_host_pagination_page_too_large",
  "local_agent_host_unavailable",
  "local_agent_host_custom_ca_unsupported",
  "local_agent_host_handoff_invalid",
  "local_agent_host_handoff_expired",
  "agent_host_enrollment_rejected",
  "agent_host_enrollment_exchange_failed",
  "agent_host_enrollment_transport_insecure",
  "agent_host_enrollment_transport_unsupported",
  "agent_host_enrollment_response_malformed",
  "agent_host_enrollment_response_too_large",
  "agent_host_enrollment_response_mismatch",
  "agent_host_enrollment_response_expired",
  "agent_host_enrollment_already_pending",
  "agent_host_handoff_config_conflict",
  "agent_host_handoff_pending_conflict",
  "agent_host_handoff_credential_conflict",
  "agent_host_handoff_provenance_invalid",
  "agent_host_windows_user_sid_unavailable",
  "agent_host_preset_binary_missing",
  "agent_host_background_setup_required",
  "human_principal_unavailable"
]);

function knownErrorCode(value: string): string | null {
  for (const code of knownErrorCodes) {
    if (new RegExp(`(?:^|: )${code}(?=$|[\\s:(])`).test(value)) return code;
  }
  return null;
}

function safeAgentHostErrorCode(value: string): string | null {
  return value.match(/(?:agent_host|local_agent_host)_[a-z0-9_]+/)?.[0] ?? null;
}

export function hostAdministrationErrorCode(error: unknown): string {
  if (error instanceof OperatorControlError && knownErrorCodes.has(error.code)) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && knownErrorCodes.has(code)) return code;
  }
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return (
      knownErrorCode(error.message) ??
      safeAgentHostErrorCode(error.message) ??
      "operator_request_failed"
    );
  }
  return "operator_request_failed";
}

export function formatHostAdministrationError(
  code: string | null,
  t: ReturnType<typeof createTranslator>
): string | null {
  if (!code) return null;
  if (code === "local_agent_host_unavailable") {
    return t("hostAdminLocalHostUnsupported");
  }
  if (code === "local_agent_host_custom_ca_unsupported") {
    return t("hostAdminLocalHostCustomCaUnsupported");
  }
  if (code === "local_agent_host_handoff_invalid") {
    return t("hostAdminLocalHostHandoffInvalid");
  }
  if (code === "local_agent_host_handoff_expired") {
    return t("hostAdminLocalHostHandoffExpired");
  }
  if (
    code === "agent_host_enrollment_rejected" ||
    code === "agent_host_enrollment_response_expired" ||
    code === "agent_host_enrollment_response_mismatch"
  ) {
    return t("hostAdminLocalHostEnrollmentRejected");
  }
  if (code === "agent_host_enrollment_exchange_failed") {
    return t("hostAdminLocalHostEnrollmentUnreachable");
  }
  if (
    code === "agent_host_enrollment_transport_insecure" ||
    code === "agent_host_enrollment_transport_unsupported"
  ) {
    return t("hostAdminLocalHostEnrollmentTransportUnsupported");
  }
  if (
    code === "agent_host_enrollment_response_malformed" ||
    code === "agent_host_enrollment_response_too_large"
  ) {
    return t("hostAdminLocalHostEnrollmentResponseInvalid");
  }
  if (
    code === "agent_host_enrollment_already_pending" ||
    code === "agent_host_handoff_config_conflict" ||
    code === "agent_host_handoff_pending_conflict" ||
    code === "agent_host_handoff_credential_conflict" ||
    code === "agent_host_handoff_provenance_invalid"
  ) {
    return t("hostAdminLocalHostEnrollmentConflict");
  }
  if (code === "agent_host_windows_user_sid_unavailable") {
    return t("hostAdminLocalHostWindowsIdentityUnavailable");
  }
  if (code === "agent_host_preset_binary_missing") {
    return t("hostAdminLocalHostAgentMissing");
  }
  if (code === "agent_host_background_setup_required") {
    return t("hostAdminLocalHostSetupRequired");
  }
  const key =
    code === "operator_bridge_unavailable"
      ? "hostAdminBridgeUnavailable"
      : code === "operator_credential_missing"
        ? "hostAdminCredentialMissing"
        : code === "human_principal_unavailable"
          ? "hostAdminHumanPrincipalUnavailable"
          : code === "operator_profile_missing" || code === "operator_profile_not_found"
            ? "hostAdminProfileMissing"
            : code === "operator_offline" || code === "operator_timeout"
              ? "hostAdminOffline"
              : code === "operator_unauthorized" || code === "operator_credential_invalid"
                ? "hostAdminUnauthorized"
                : code === "operator_admin_required" ||
                    code === "operator_server_admin_required" ||
                    code === "operator_forbidden"
                  ? "hostAdminForbidden"
                  : "hostAdminErrorGeneric";
  return t(key);
}
