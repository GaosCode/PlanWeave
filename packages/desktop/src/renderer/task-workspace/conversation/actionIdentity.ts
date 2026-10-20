import type {
  DesktopAgentPromptIdentity,
  DesktopAgentSessionActionIdentity
} from "@planweave-ai/runtime";

export function samePromptIdentity(
  left: DesktopAgentPromptIdentity | null,
  right: DesktopAgentPromptIdentity | null
): left is DesktopAgentPromptIdentity {
  return left !== null && right !== null && promptIdentityKey(left) === promptIdentityKey(right);
}

export function sameSessionActionIdentity(
  left: DesktopAgentSessionActionIdentity | null,
  right: DesktopAgentSessionActionIdentity | null
): left is DesktopAgentSessionActionIdentity {
  return (
    left !== null &&
    right !== null &&
    left.scope === right.scope &&
    left.executorRunId === right.executorRunId &&
    left.desktopRunId === right.desktopRunId &&
    left.runSessionId === right.runSessionId &&
    left.claimRef === right.claimRef &&
    left.sessionId === right.sessionId
  );
}

export function promptIdentityKey(identity: DesktopAgentPromptIdentity): string {
  return JSON.stringify([
    identity.ref.projectRoot,
    identity.ref.canvasId,
    identity.recordId,
    identity.executorRunId,
    identity.claimRef,
    identity.sessionId
  ]);
}
