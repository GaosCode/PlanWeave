import {
  collaborationSetupHandoffV1Prefix,
  normalizeHandoffClipboard,
  parseCollaborationSetupHandoffV1,
  type CollaborationSetupHandoffV1
} from "@planweave-ai/collaboration-protocol/handoff/setup";
import {
  parseCollaborationInvitationHandoff,
  type CollaborationInvitationHandoff
} from "./collaborationInvitationHandoff";

export type CollaborationJoinPaste =
  | { kind: "setup"; handoff: CollaborationSetupHandoffV1 }
  | { kind: "invalid_setup" }
  | { kind: "invitation"; handoff: CollaborationInvitationHandoff }
  | { kind: "invalid_invitation" };

/** Join field accepts a project invitation or a member-device setup envelope. */
export function parseCollaborationJoinPaste(value: string): CollaborationJoinPaste {
  const normalized = normalizeHandoffClipboard(value);
  const setupHandoff = parseCollaborationSetupHandoffV1(normalized);
  if (setupHandoff) return { kind: "setup", handoff: setupHandoff };
  if (normalized.startsWith(collaborationSetupHandoffV1Prefix)) return { kind: "invalid_setup" };
  const invitation = parseCollaborationInvitationHandoff(normalized);
  if (invitation) return { kind: "invitation", handoff: invitation };
  return { kind: "invalid_invitation" };
}
