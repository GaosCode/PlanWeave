import {
  remoteAgentAuthorizationErrorCodeSchema,
  type RemoteAgentAuthorizationErrorCode
} from "@planweave-ai/collaboration-protocol/agent-endpoint";

export { remoteAgentAuthorizationErrorCodeSchema, type RemoteAgentAuthorizationErrorCode };

export class RemoteAgentAuthorizationError extends Error {
  readonly code: RemoteAgentAuthorizationErrorCode;

  constructor(code: RemoteAgentAuthorizationErrorCode) {
    const parsed = remoteAgentAuthorizationErrorCodeSchema.parse(code);
    super(parsed);
    this.name = "RemoteAgentAuthorizationError";
    this.code = parsed;
  }
}

export function remoteAgentAuthorizationErrorCode(
  error: unknown
): RemoteAgentAuthorizationErrorCode | undefined {
  return error instanceof RemoteAgentAuthorizationError ? error.code : undefined;
}
