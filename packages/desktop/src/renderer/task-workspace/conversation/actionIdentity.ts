import type {
  DesktopAgentPromptIdentity,
  DesktopAgentSessionActionIdentity
} from "@planweave-ai/runtime";

export function samePromptIdentity(
  left: DesktopAgentPromptIdentity | null,
  right: DesktopAgentPromptIdentity | null
): left is DesktopAgentPromptIdentity {
  return (
    left !== null &&
    right !== null &&
    left.ref.projectRoot === right.ref.projectRoot &&
    left.ref.canvasId === right.ref.canvasId &&
    left.recordId === right.recordId &&
    left.executorRunId === right.executorRunId &&
    left.claimRef === right.claimRef &&
    left.sessionId === right.sessionId
  );
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
