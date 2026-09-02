export const skillRemoteRunTemplate =
  "<pw> run --once --target remote --scope block --block <ref> --agent-endpoint <endpoint-id> --connection-profile <profile-id> --event-format execution-v1";

export function skillEndpointListArgv(canvasId: string, profileId: string): string[] {
  return [
    "agent-endpoints",
    "list",
    "--canvas",
    canvasId,
    "--connection-profile",
    profileId,
    "--json"
  ];
}

export function skillRemoteRunArgv(
  blockRef: string,
  endpointId: string,
  profileId: string
): string[] {
  return [
    "run",
    "--once",
    "--target",
    "remote",
    "--scope",
    "block",
    "--block",
    blockRef,
    "--agent-endpoint",
    endpointId,
    "--connection-profile",
    profileId,
    "--event-format",
    "execution-v1"
  ];
}

export function skillInteractionListArgv(sessionId: string, profileId: string): string[] {
  return [
    "interaction",
    "list",
    "--session",
    sessionId,
    "--connection-profile",
    profileId,
    "--json"
  ];
}

export function skillInteractionRespondArgv(input: {
  sessionId: string;
  dispatchId: string;
  leaseId: string;
  executionAttemptId: string;
  acpSessionId: string;
  actionId: string;
  option: string;
  profileId: string;
}): string[] {
  return [
    "interaction",
    "respond",
    "--session",
    input.sessionId,
    "--dispatch",
    input.dispatchId,
    "--lease",
    input.leaseId,
    "--attempt",
    input.executionAttemptId,
    "--acp-session",
    input.acpSessionId,
    "--action",
    input.actionId,
    "--option",
    input.option,
    "--connection-profile",
    input.profileId,
    "--json"
  ];
}

export function skillRunSessionResumeArgv(sessionId: string, profileId: string): string[] {
  return [
    "run-session",
    sessionId,
    "--follow",
    "--event-format",
    "execution-v1",
    "--connection-profile",
    profileId
  ];
}

export function skillOwnerEndpointListArgv(canvasId: string, profileId: string): string[] {
  return [...skillEndpointListArgv(canvasId, profileId), "--authority", "owner_canvas"];
}

export function skillOwnerRemoteRunArgv(
  blockRef: string,
  endpointId: string,
  profileId: string
): string[] {
  return [...skillRemoteRunArgv(blockRef, endpointId, profileId), "--authority", "owner_canvas"];
}
