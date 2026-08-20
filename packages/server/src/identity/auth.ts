import {
  humanAuthContextSchema,
  humanDeviceTokenSchema,
  type HumanAuthContext
} from "./schemas.js";
import {
  workspaceIdSchema,
  type DeviceSessionId,
  type WorkspaceId
} from "@planweave-ai/collaboration-protocol/core/primitives";
import type { HumanIdentityRepository } from "./repository.js";
import type { WorkspaceIdentityRepository } from "./workspaceRepository.js";
import type { CollaborationScopeAuthority } from "./service.js";

export type WorkspaceDeviceAuthContext = {
  kind: "workspace_device";
  workspaceId: WorkspaceId;
  deviceSessionId: DeviceSessionId;
  humanPrincipalId: string;
  displayName: string;
  projectId: string;
};

export type CollaborationAuthContext = HumanAuthContext | WorkspaceDeviceAuthContext;

export type AuthenticatedCollaborationScope = {
  actor: CollaborationAuthContext;
  workspaceId: WorkspaceId;
  projectId: string;
  canvasId?: string;
};

/**
 * Convert an already-authenticated Workspace device session into the human
 * context required by legacy application services. Role and membership identity
 * are read from the current Workspace membership projection, never from request
 * fields or a legacy project mapping.
 */
export function workspaceDeviceSessionHumanContext(
  actor: CollaborationAuthContext,
  workspaceIdentity: WorkspaceIdentityRepository
): HumanAuthContext | undefined {
  if (!("kind" in actor) || actor.kind !== "workspace_device") {
    return humanAuthContextSchema.parse(actor);
  }
  const membership = workspaceIdentity
    .listMembershipViews(actor.workspaceId)
    .find(
      (candidate) =>
        candidate.humanPrincipalId === actor.humanPrincipalId && candidate.revokedAt === null
    );
  if (!membership) return undefined;
  return humanAuthContextSchema.parse({
    humanPrincipalId: actor.humanPrincipalId,
    displayName: actor.displayName,
    deviceCredentialId: actor.deviceSessionId,
    projectId: actor.projectId,
    role: membership.role,
    membershipId: membership.membershipId
  });
}

/**
 * Human-specific authentication adapter.
 *
 * Parses only `pw_hdev_` device bearer credentials. Host (`pw_host_`), enrollment,
 * operator, and invitation tokens must not authenticate as humans here.
 * Invalid / expired / revoked / unknown tokens all resolve to unauthenticated without
 * revealing which failure mode applied for unknown external tokens.
 */

function bearerToken(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value) || value === undefined) return undefined;
  const match = /^Bearer (.+)$/.exec(value);
  if (!match) return undefined;
  const token = match[1]?.trim();
  return token && token.length > 0 ? token : undefined;
}

/**
 * Extract a human device bearer from the Authorization header.
 * Returns undefined when missing, malformed, or not a human device token shape.
 */
export function parseHumanDeviceBearer(
  authorization: string | string[] | undefined
): string | undefined {
  const token = bearerToken(authorization);
  if (!token) return undefined;
  const parsed = humanDeviceTokenSchema.safeParse(token);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Authenticate a human device credential and resolve active project membership.
 * Returns undefined for any authentication or membership failure (uniform unauthenticated).
 */
export function authenticateHumanForProject(
  repository: HumanIdentityRepository,
  authorization: string | string[] | undefined,
  projectId: string,
  options: { recordLastUsed?: boolean } = {}
): HumanAuthContext | undefined {
  const token = parseHumanDeviceBearer(authorization);
  if (!token) return undefined;

  const authenticated = repository.authenticateDevice(token, projectId, options);
  if (!authenticated?.membership) return undefined;

  return humanAuthContextSchema.parse({
    humanPrincipalId: authenticated.principal.humanPrincipalId,
    displayName: authenticated.principal.displayName,
    deviceCredentialId: authenticated.device.deviceCredentialId,
    projectId: authenticated.membership.projectId,
    role: authenticated.membership.role,
    membershipId: authenticated.membership.membershipId
  });
}

/**
 * Authenticate a collaboration request through either the legacy project-device
 * credential or a Workspace-scoped setup-code device session. Workspace sessions
 * establish their authority from the session workspace; legacy credentials resolve
 * through the uniquely mapped legacy-project adapter before downstream ACL checks.
 */
export function authenticateCollaborationForProject(
  repository: HumanIdentityRepository,
  workspaceIdentity: WorkspaceIdentityRepository,
  authorization: string | string[] | undefined,
  projectId: string,
  options: { recordLastUsed?: boolean } = {}
): CollaborationAuthContext | undefined {
  const token = parseHumanDeviceBearer(authorization);
  if (!token) return undefined;
  const workspaceSession = workspaceIdentity.authenticateWorkspaceDeviceSession(token);
  if (workspaceSession) {
    return {
      kind: "workspace_device",
      workspaceId: workspaceSession.workspaceId,
      deviceSessionId: workspaceSession.deviceSessionId,
      humanPrincipalId: workspaceSession.humanPrincipalId,
      displayName: workspaceSession.displayName,
      projectId
    };
  }
  return authenticateHumanForProject(repository, authorization, projectId, options);
}

export function hasAuthenticatedCollaborationDevice(
  repository: HumanIdentityRepository,
  workspaceIdentity: WorkspaceIdentityRepository,
  authorization: string | string[] | undefined
): boolean {
  const token = parseHumanDeviceBearer(authorization);
  if (!token) return false;
  return (
    workspaceIdentity.authenticateWorkspaceDeviceSession(token) !== undefined ||
    repository.authenticateDevice(token) !== undefined
  );
}

/** Resolve a credential to one exact collaboration scope before selecting scoped services. */
export function authenticateCollaborationForScope(
  repository: HumanIdentityRepository,
  workspaceIdentity: WorkspaceIdentityRepository,
  collaborationScopeAuthority: CollaborationScopeAuthority,
  authorization: string | string[] | undefined,
  projectId: string,
  canvasId?: string,
  options: { recordLastUsed?: boolean } = {}
): AuthenticatedCollaborationScope | undefined {
  const actor = authenticateCollaborationForProject(
    repository,
    workspaceIdentity,
    authorization,
    projectId,
    options
  );
  if (!actor) return undefined;
  const workspaceCandidate =
    "kind" in actor && actor.kind === "workspace_device"
      ? actor.workspaceId
      : workspaceIdentity.workspaceForLegacyProject(projectId);
  if (!workspaceCandidate) return undefined;
  const workspaceId = workspaceIdSchema.parse(workspaceCandidate);
  const scope = {
    workspaceId,
    projectId,
    ...(canvasId === undefined ? {} : { canvasId })
  };
  if (!collaborationScopeAuthority.hasScope(scope)) return undefined;
  return { actor, ...scope };
}

/**
 * Authenticate a device without project membership resolution (device-only operations).
 * Prefer `authenticateHumanForProject` for project-scoped APIs.
 */
export function authenticateHumanDevice(
  repository: HumanIdentityRepository,
  authorization: string | string[] | undefined
):
  | {
      humanPrincipalId: string;
      displayName: string;
      deviceCredentialId: string;
    }
  | undefined {
  const token = parseHumanDeviceBearer(authorization);
  if (!token) return undefined;
  const authenticated = repository.authenticateDevice(token);
  if (!authenticated) return undefined;
  return {
    humanPrincipalId: authenticated.principal.humanPrincipalId,
    displayName: authenticated.principal.displayName,
    deviceCredentialId: authenticated.device.deviceCredentialId
  };
}
