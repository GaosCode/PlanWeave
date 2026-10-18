import type { CollaborationOperationScope } from "../../shared/collaborationOperationScope.js";

export function collaborationOperationScopeFixture(
  profileId = "profile-1",
  projectId = "project-1"
): CollaborationOperationScope {
  return {
    profileId,
    projectId,
    serverBaseUrl: "https://example.test/",
    sessionId: "00000000-0000-4000-8000-000000000001"
  };
}

export function scopedProjectFixture<T extends { profileId: string; projectId: string }>(input: T) {
  return {
    ...input,
    operationScope: collaborationOperationScopeFixture(input.profileId, input.projectId)
  };
}
