import { z } from "zod";
import {
  collaborationServerOriginSchema,
  refineCollaborationTransportPolicy
} from "./connection.js";
import { normalizeHandoffClipboard } from "./setupHandoff.js";
import { humanProjectIdSchema, projectInvitationTokenSchema } from "./primitives.js";
import { deploymentEndpointSchema } from "./deployment.js";
import { humanCreateInvitationResponseSchema } from "./identity.js";

export const collaborationInvitationHandoffV1Prefix =
  "planweave-collaboration-invitation/v1:" as const;
export const collaborationInvitationHandoffV2Prefix =
  "planweave-collaboration-invitation/v2:" as const;

/**
 * Portable, one-time project invitation details. This contains a bearer secret
 * and must only be copied directly to the recipient, never persisted.
 */
export const collaborationInvitationHandoffV1Schema = z
  .object({
    serverBaseUrl: collaborationServerOriginSchema,
    projectId: humanProjectIdSchema,
    invitationToken: projectInvitationTokenSchema,
    allowInsecureTransport: z.boolean()
  })
  .strict()
  .superRefine(refineCollaborationTransportPolicy);
export type CollaborationInvitationHandoffV1 = z.infer<
  typeof collaborationInvitationHandoffV1Schema
>;

/**
 * Portable invitation whose network authority is the Server's validated
 * advertised endpoint. The bearer secret must never be logged or persisted.
 */
export const collaborationInvitationHandoffV2Schema = z
  .object({
    endpoint: deploymentEndpointSchema,
    projectId: humanProjectIdSchema,
    invitationToken: projectInvitationTokenSchema
  })
  .strict();
export type CollaborationInvitationHandoffV2 = z.infer<
  typeof collaborationInvitationHandoffV2Schema
>;

export type CollaborationInvitationHandoff =
  | CollaborationInvitationHandoffV1
  | CollaborationInvitationHandoffV2;

export function parseCollaborationInvitationHandoffPayload(
  value: unknown
): CollaborationInvitationHandoffV1 | null {
  const parsed = collaborationInvitationHandoffV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Produces a stable, locale-independent invitation envelope for the clipboard. */
export function serializeCollaborationInvitationHandoffV1(
  input: CollaborationInvitationHandoffV1
): string {
  const handoff = collaborationInvitationHandoffV1Schema.parse(input);
  return `${collaborationInvitationHandoffV1Prefix}${JSON.stringify({
    serverBaseUrl: handoff.serverBaseUrl,
    projectId: handoff.projectId,
    invitationToken: handoff.invitationToken,
    allowInsecureTransport: handoff.allowInsecureTransport
  })}`;
}

/** Parses only the versioned clipboard envelope; legacy text belongs to Desktop. */
export function parseCollaborationInvitationHandoffV1(
  value: string
): CollaborationInvitationHandoffV1 | null {
  const trimmed = normalizeHandoffClipboard(value);
  if (!trimmed.startsWith(collaborationInvitationHandoffV1Prefix)) return null;

  try {
    const candidate: unknown = JSON.parse(
      trimmed.slice(collaborationInvitationHandoffV1Prefix.length)
    );
    return parseCollaborationInvitationHandoffPayload(candidate);
  } catch {
    return null;
  }
}

/** New invitation serialization always emits V2. */
export function serializeCollaborationInvitationHandoffV2(
  input: CollaborationInvitationHandoffV2
): string {
  const handoff = collaborationInvitationHandoffV2Schema.parse(input);
  return `${collaborationInvitationHandoffV2Prefix}${JSON.stringify({
    endpoint: handoff.endpoint,
    projectId: handoff.projectId,
    invitationToken: handoff.invitationToken
  })}`;
}

export function parseCollaborationInvitationHandoffV2(
  value: string
): CollaborationInvitationHandoffV2 | null {
  const trimmed = normalizeHandoffClipboard(value);
  if (!trimmed.startsWith(collaborationInvitationHandoffV2Prefix)) return null;
  try {
    const candidate: unknown = JSON.parse(
      trimmed.slice(collaborationInvitationHandoffV2Prefix.length)
    );
    const parsed = collaborationInvitationHandoffV2Schema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const collaborationInvitationHandoffV2EnvelopeSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    if (!parseCollaborationInvitationHandoffV2(value)) {
      context.addIssue({ code: "custom", message: "invalid V2 invitation handoff envelope" });
    }
  });

export const collaborationInvitationHandoffResponseSchema = humanCreateInvitationResponseSchema
  .extend({ handoff: collaborationInvitationHandoffV2EnvelopeSchema })
  .strict()
  .superRefine((value, context) => {
    const handoff = parseCollaborationInvitationHandoffV2(value.handoff);
    if (!handoff) return;
    if (handoff.invitationToken !== value.invitationToken) {
      context.addIssue({
        code: "custom",
        path: ["handoff"],
        message: "handoff invitation token does not match response"
      });
    }
    if (handoff.projectId !== value.invitation.projectId) {
      context.addIssue({
        code: "custom",
        path: ["handoff"],
        message: "handoff project does not match invitation"
      });
    }
  });
export type CollaborationInvitationHandoffResponse = z.infer<
  typeof collaborationInvitationHandoffResponseSchema
>;

/** Parses current V2 and read-only V1 compatibility envelopes. */
export function parseCollaborationInvitationHandoff(
  value: string
): CollaborationInvitationHandoff | null {
  return (
    parseCollaborationInvitationHandoffV2(value) ?? parseCollaborationInvitationHandoffV1(value)
  );
}
