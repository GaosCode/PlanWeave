import {
  collaborationConnectionProfileSchema,
  deploymentEndpointSchema,
  isLoopbackHostname,
  isPrivateNetworkHostname,
  legacyCollaborationConnectionProfileSchema,
  type CollaborationConnectionProfile,
  type DeploymentEndpoint
} from "@planweave-ai/collaboration-protocol/connection";

export function migrateLegacyStoredCollaborationProfile(
  input: unknown
): CollaborationConnectionProfile {
  const legacy = legacyCollaborationConnectionProfileSchema.parse(input);
  const origin = new URL(legacy.serverBaseUrl);
  if (origin.protocol !== "http:" || !legacy.allowInsecureTransport) {
    throw new Error("collaboration_profile_endpoint_reconnect_required");
  }
  const topology = isLoopbackHostname(origin.hostname)
    ? "loopback_http"
    : isPrivateNetworkHostname(origin.hostname)
      ? "lan_http"
      : null;
  if (!topology) throw new Error("collaboration_profile_endpoint_reconnect_required");
  const endpoint = deploymentEndpointSchema.parse({
    topology,
    serverOrigin: legacy.serverBaseUrl,
    allowedClientOrigins: [legacy.serverBaseUrl],
    tlsTrust: "not_applicable"
  });
  return collaborationConnectionProfileSchema.parse({ ...legacy, endpoint });
}

/** Build a connection endpoint from the live Server origin. Topology follows transport, not which machine last hosted it. */
export function collaborationEndpointForServerOrigin(
  serverBaseUrl: string,
  allowInsecureTransport: boolean
): DeploymentEndpoint {
  const origin = new URL(serverBaseUrl);
  const serverOrigin = `${origin.origin}/`;
  if (origin.protocol === "https:") {
    return deploymentEndpointSchema.parse({
      topology: "public_https",
      serverOrigin,
      allowedClientOrigins: [serverOrigin],
      tlsTrust: "system_ca"
    });
  }
  if (!allowInsecureTransport) {
    throw new Error("collaboration_profile_endpoint_reconnect_required");
  }
  const topology = isLoopbackHostname(origin.hostname) ? "loopback_http" : "lan_http";
  if (topology === "lan_http" && !isPrivateNetworkHostname(origin.hostname)) {
    throw new Error("collaboration_profile_endpoint_reconnect_required");
  }
  return deploymentEndpointSchema.parse({
    topology,
    serverOrigin,
    allowedClientOrigins: [serverOrigin],
    tlsTrust: "not_applicable"
  });
}

export const LOCAL_COLLABORATION_PROFILE_PREFIX = "planweave-local-";

export function isLocalCollaborationProfileId(profileId: string): boolean {
  return profileId.startsWith(LOCAL_COLLABORATION_PROFILE_PREFIX);
}

export function assertRendererProfileNamespace(input: unknown): void {
  const candidate = input && typeof input === "object" ? Reflect.get(input, "profileId") : null;
  if (typeof candidate === "string" && isLocalCollaborationProfileId(candidate)) {
    throw new Error("collaboration_local_profile_namespace_reserved");
  }
}
