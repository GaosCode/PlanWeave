import type { createTranslator } from "../i18n";

type Translator = ReturnType<typeof createTranslator>;

const reasonTranslationKeys = {
  host_offline: "agentEndpointUnavailableHostOffline",
  host_revoked: "agentEndpointUnavailableHostRevoked",
  host_credential_expired: "agentEndpointUnavailableCredentialExpired",
  profile_missing: "agentEndpointUnavailableProfileMissing",
  profile_invalid: "agentEndpointUnavailableProfileInvalid",
  at_capacity: "agentEndpointUnavailableAtCapacity",
  host_capability_missing: "agentEndpointUnavailableHostCapabilityMissing",
  agent_endpoint_incompatible: "agentEndpointUnavailableIncompatible",
  agent_endpoint_request_failed: "agentEndpointUnavailableRequestFailed",
  agent_endpoint_local_profile_missing: "agentEndpointUnavailableLocalProfileMissing",
  agent_endpoint_local_not_detected: "agentEndpointUnavailableLocalNotDetected",
  agent_endpoint_local_preflight_failed: "agentEndpointUnavailableLocalPreflightFailed"
} as const;

export function formatAgentEndpointUnavailableReason(reason: string | null, t: Translator): string {
  const key = reason ? reasonTranslationKeys[reason as keyof typeof reasonTranslationKeys] : null;
  return key ? t(key) : t("unavailable");
}
