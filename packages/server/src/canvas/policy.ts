import type { ActorRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import type { CollaborationAuthContext } from "../identity/auth.js";

export type CanvasContentAuthorization =
  | {
      ok: true;
      scope: { workspaceId: string; projectId: string; canvasId: string };
      aclRevision: number;
    }
  | { ok: false; code: "unauthorized" | "forbidden" | "unknown_canvas" | "cross_scope" };

/**
 * Authorize content-version discovery, publish, and fetch from the ACL registry.
 * Unlike command/live-sync reads, this does not require a bound package path.
 */
export function authorizeCanvasContent(input: {
  actor: CollaborationAuthContext;
  projectId: string;
  canvasId: string;
  access: ProjectAccessRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
}): CanvasContentAuthorization {
  if (input.actor.projectId !== input.projectId) {
    return { ok: false, code: "cross_scope" };
  }
  const workspaceId =
    "kind" in input.actor && input.actor.kind === "workspace_device"
      ? input.actor.workspaceId
      : input.workspaceIdentity.workspaceForLegacyProject(input.projectId);
  if (!workspaceId) return { ok: false, code: "unknown_canvas" };
  const subject: ActorRef = { kind: "human", id: input.actor.humanPrincipalId };
  const canvasDecision = input.access.decideCanvasAccess({
    workspaceId,
    projectId: input.projectId,
    canvasId: input.canvasId,
    actor: subject
  });
  if (canvasDecision.decision !== "allow") {
    return {
      ok: false,
      code: canvasDecision.reason === "missing" ? "unknown_canvas" : "forbidden"
    };
  }
  const canvas = input.access.registry.canvasInternal(workspaceId, input.projectId, input.canvasId);
  if (!canvas || canvas.revokedAt !== null) return { ok: false, code: "unknown_canvas" };
  return {
    ok: true,
    scope: {
      workspaceId,
      projectId: input.projectId,
      canvasId: input.canvasId
    },
    aclRevision: canvas.aclRevision
  };
}

/**
 * Authorize durable canvas command submit against the ACL registry.
 * Command apply is content-version based and does not need a bound package path.
 */
export function authorizeCanvasCommand(input: {
  actor: CollaborationAuthContext;
  projectId: string;
  canvasId: string;
  access: ProjectAccessRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
}): CanvasContentAuthorization {
  const authorized = authorizeCanvasContent(input);
  if (!authorized.ok) return authorized;
  const subject: ActorRef = { kind: "human", id: input.actor.humanPrincipalId };
  try {
    input.access.policy.assertCapability({
      workspaceId: authorized.scope.workspaceId,
      projectId: authorized.scope.projectId,
      canvasId: authorized.scope.canvasId,
      actor: subject,
      capability: "persistent_canvas_command"
    });
  } catch {
    return { ok: false, code: "forbidden" };
  }
  return authorized;
}
