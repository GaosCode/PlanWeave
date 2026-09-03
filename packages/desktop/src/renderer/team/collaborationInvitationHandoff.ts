import {
  collaborationInvitationHandoffV1Prefix,
  collaborationInvitationHandoffV2Prefix,
  parseCollaborationInvitationHandoffPayload,
  parseCollaborationInvitationHandoff as parseVersionedCollaborationInvitationHandoff,
  serializeCollaborationInvitationHandoffV2,
  type CollaborationInvitationHandoffV2
} from "@planweave-ai/collaboration-protocol/handoff/invitation";
import {
  deploymentEndpointSchema,
  isLoopbackHostname,
  isPrivateNetworkHostname,
  type DeploymentEndpoint
} from "@planweave-ai/collaboration-protocol/connection";

export { collaborationInvitationHandoffV1Prefix, collaborationInvitationHandoffV2Prefix };
export type CollaborationInvitationHandoff = {
  serverBaseUrl: string;
  projectId: string;
  invitationToken: string;
  allowInsecureTransport: boolean;
  endpoint?: CollaborationInvitationHandoffV2["endpoint"];
};
export const serializeCollaborationInvitationHandoff = (
  input: CollaborationInvitationHandoffV2
): string => serializeCollaborationInvitationHandoffV2(input);

/** Bounded adapter for the established V1 invitation envelope. HTTPS remains ambiguous. */
export function endpointForLegacyCollaborationInvitationHandoff(
  handoff: CollaborationInvitationHandoff
): DeploymentEndpoint | null {
  if (handoff.endpoint || !handoff.allowInsecureTransport) return handoff.endpoint ?? null;
  const url = new URL(handoff.serverBaseUrl);
  if (url.protocol !== "http:") return null;
  const topology = isLoopbackHostname(url.hostname)
    ? "loopback_http"
    : isPrivateNetworkHostname(url.hostname)
      ? "lan_http"
      : null;
  if (!topology) return null;
  return deploymentEndpointSchema.parse({
    topology,
    serverOrigin: handoff.serverBaseUrl,
    allowedClientOrigins: [handoff.serverBaseUrl],
    tlsTrust: "not_applicable"
  });
}

const invitationTokenPattern = /\bpw_inv_[A-Za-z0-9_-]{43}\b/;

function legacyProjectId(value: string): string | undefined {
  const match = value.match(/(?:^|\n)\s*(?:Project ID|projectId|项目 ID)\s*[:=]\s*([^\n\r]+)/i);
  return match?.[1]?.trim();
}

/**
 * Parses versioned envelopes first. The legacy branch intentionally extracts only
 * the URL and invitation token that are unambiguous in older copied text. A
 * project ID is still required, because a join cannot continue without it.
 */
export function parseCollaborationInvitationHandoff(
  value: string
): CollaborationInvitationHandoff | null {
  const trimmed = value
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (!trimmed) return null;

  if (
    trimmed.startsWith(collaborationInvitationHandoffV2Prefix) ||
    trimmed.startsWith(collaborationInvitationHandoffV1Prefix)
  ) {
    const handoff = parseVersionedCollaborationInvitationHandoff(trimmed);
    if (!handoff) return null;
    if ("endpoint" in handoff) {
      return {
        serverBaseUrl: handoff.endpoint.serverOrigin,
        projectId: handoff.projectId,
        invitationToken: handoff.invitationToken,
        allowInsecureTransport:
          handoff.endpoint.topology === "loopback_http" || handoff.endpoint.topology === "lan_http",
        endpoint: handoff.endpoint
      };
    }
    return handoff;
  }

  const token = trimmed.match(invitationTokenPattern)?.[0];
  const urlText = trimmed.match(/https?:\/\/[^\s]+/i)?.[0]?.replace(/[),.;]+$/, "");
  if (!token || !urlText) return null;

  const allowInsecureTransport = /^http:\/\//i.test(urlText);
  const projectId = legacyProjectId(trimmed);
  return parseCollaborationInvitationHandoffPayload({
    serverBaseUrl: urlText,
    projectId,
    invitationToken: token,
    allowInsecureTransport
  });
}
