import { randomUUID } from "node:crypto";
import type { CollaborationOperationScope } from "../../shared/collaborationOperationScope.js";
import type { CollaborationSessionPhase } from "../../shared/collaboration.js";
import type { CollaborationClient } from "./CollaborationClient.js";
import { CollaborationClientError, collaborationErrorFromUnknown } from "./collaborationErrors.js";

/** Binds renderer operations to the client whose HTTP access was verified. */
export class CollaborationOperationSession {
  private verified: { client: CollaborationClient; scope: CollaborationOperationScope } | null =
    null;

  retire(): void {
    this.verified = null;
  }

  verify(client: CollaborationClient, profileId: string): void {
    const profile = client.connectionProfile;
    this.verified = {
      client,
      scope: {
        profileId,
        projectId: profile.projectId,
        serverBaseUrl: profile.serverBaseUrl,
        sessionId: randomUUID()
      }
    };
  }

  scope(phase: CollaborationSessionPhase): CollaborationOperationScope | null {
    return phase === "connected" ? (this.verified?.scope ?? null) : null;
  }

  async run<T>(
    scope: CollaborationOperationScope,
    phase: CollaborationSessionPhase,
    operation: (client: CollaborationClient) => Promise<T>
  ): Promise<T> {
    const verified = this.verified;
    if (
      phase !== "connected" ||
      !verified ||
      scope.sessionId !== verified.scope.sessionId ||
      scope.profileId !== verified.scope.profileId ||
      scope.projectId !== verified.scope.projectId ||
      scope.serverBaseUrl !== verified.scope.serverBaseUrl
    ) {
      throw new CollaborationClientError({
        kind: "conflict",
        code: "collaboration_operation_scope_stale",
        message:
          "The collaboration session changed. Reload this project before retrying the operation.",
        retryable: false
      });
    }
    try {
      return await operation(verified.client);
    } catch (error) {
      throw collaborationErrorFromUnknown(error);
    }
  }
}
