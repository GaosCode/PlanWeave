import {
  hostAuthorizationDecisionSchema,
  hostAuthorizationFactsSchema,
  type HostAuthorizationDecision,
  type HostAuthorizationFacts,
  type HostAuthorizationCurrentRevisions,
  type HostAuthorizationDecisionReason
} from "@planweave-ai/collaboration-protocol/work/host-authorization";
import {
  type ExactBlockExecutionScope,
  type ExecutionTarget
} from "@planweave-ai/collaboration-protocol/work/execution-target";
import type { AgentHost } from "../hosts.js";
import {
  hostExecutionProfileAvailability,
  isAgentHostOnline,
  operatorHostAvailability
} from "../hosts.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import type { CollaborationAuthContext } from "../identity/auth.js";
import type { WorkItemPackageFacts } from "./schemas.js";

export type AuthorityPolicyErrorCode =
  | "authority_input_invalid"
  | "authority_scope_forbidden"
  | "authority_project_mismatch"
  | "authority_workspace_mismatch"
  | "authority_membership_required"
  | "authority_revision_conflict"
  | "authority_host_not_found"
  | "authority_host_revoked"
  | "authority_host_workspace_mismatch"
  | "authority_host_capability_mismatch"
  | "authority_migration_repair_required"
  | "host_cross_workspace"
  | "host_workspace_acl_denied"
  | "host_project_acl_denied"
  | "host_canvas_acl_denied"
  | "host_missing"
  | "host_revoked"
  | "host_offline"
  | "host_at_capacity"
  | "host_capability_mismatch"
  | "host_lease_missing"
  | "host_attempt_mismatch"
  | "host_stale_responsibility_revision"
  | "host_stale_reviewer_revision"
  | "host_stale_execution_target_revision";

export function assertHumanScopeAuthorized(input: {
  actor: CollaborationAuthContext;
  scope: { workspaceId: string; projectId: string; canvasId: string };
  access: ProjectAccessRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  capability?: "read" | "assignment";
}): void {
  const { actor, scope } = input;
  if (actor.projectId !== scope.projectId) throw new Error("authority_project_mismatch");
  const workspace =
    "kind" in actor && actor.kind === "workspace_device"
      ? actor.workspaceId
      : input.workspaceIdentity.workspaceForLegacyProject(scope.projectId);
  if (!workspace || workspace !== scope.workspaceId)
    throw new Error("authority_workspace_mismatch");
  const subject = { kind: "human" as const, id: actor.humanPrincipalId };
  try {
    input.access.policy.assertCapability({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      canvasId: scope.canvasId,
      actor: subject,
      capability: input.capability ?? "read"
    });
  } catch {
    throw new Error("authority_scope_forbidden");
  }
}

export function assertAssignmentPrincipalActive(input: {
  actor: CollaborationAuthContext;
  workspaceId: string;
  humanPrincipalId: string;
  workspaceIdentity: WorkspaceIdentityRepository;
}): void {
  if (!input.workspaceIdentity.hasActiveMembership(input.workspaceId, input.humanPrincipalId)) {
    throw new Error("authority_membership_required");
  }
}

export function assertExecutionTargetMutation(input: {
  actor: CollaborationAuthContext;
  scope: ExactBlockExecutionScope;
  target: ExecutionTarget;
  access: ProjectAccessRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  hosts: { get(hostId: string): AgentHost | undefined };
  packageFacts: WorkItemPackageFacts;
  now: Date;
  hostOfflineAfterMs: number;
}): void {
  assertHumanScopeAuthorized({ ...input, scope: input.scope, capability: "assignment" });
  if (!input.packageFacts.exists || input.packageFacts.kind !== "block")
    throw new Error("authority_input_invalid");
  if (input.target.kind !== "exact_host") return;
  const host = input.hosts.get(input.target.hostId);
  if (!host) throw new Error("authority_host_not_found");
  if (host.revokedAt !== undefined) throw new Error("authority_host_revoked");
  const workspace = input.workspaceIdentity.workspaceForHost(host.id);
  if (!workspace || workspace !== input.scope.workspaceId)
    throw new Error("authority_host_workspace_mismatch");
  if (
    operatorHostAvailability(
      host,
      input.scope.workspaceId,
      isAgentHostOnline(host, {
        now: input.now,
        hostOfflineAfterMs: input.hostOfflineAfterMs
      })
    ).status !== "available"
  ) {
    throw new Error("authority_host_not_ready");
  }
  if (
    !input.packageFacts.requiredCapabilities.every((capability) =>
      host.capabilities.includes(capability)
    )
  ) {
    throw new Error("authority_host_capability_mismatch");
  }
}

export function hostCanSatisfyBlock(
  host: AgentHost,
  input: {
    scope: ExactBlockExecutionScope;
    requiredCapabilities: readonly string[];
    agentId: string;
    agentProfileId: string;
    workspaceIdentity: WorkspaceIdentityRepository;
    now: Date;
    hostOfflineAfterMs: number;
    activeReservations: number;
  }
): boolean {
  const workspaceIds = input.workspaceIdentity.workspaceIdsForHost(host.id);
  const fleetUnbound = workspaceIds.length === 0;
  if (!fleetUnbound && (workspaceIds.length !== 1 || workspaceIds[0] !== input.scope.workspaceId)) {
    return false;
  }
  const online = isAgentHostOnline(host, {
    now: input.now,
    hostOfflineAfterMs: input.hostOfflineAfterMs
  });
  return (
    host.revokedAt === undefined &&
    online &&
    hostExecutionProfileAvailability(host, {
      workspaceId: input.scope.workspaceId,
      online,
      agentId: input.agentId,
      agentProfileId: input.agentProfileId,
      requiredCapabilities: input.requiredCapabilities,
      fleetUnbound
    }).status === "available" &&
    host.capacity > input.activeReservations
  );
}

function denyDecision(input: {
  scope: ExactBlockExecutionScope;
  hostId: string;
  reason: HostAuthorizationDecisionReason;
  currentRevisions: HostAuthorizationCurrentRevisions;
  evaluatedAt: string;
  facts?: HostAuthorizationFacts;
}): HostAuthorizationDecision {
  return hostAuthorizationDecisionSchema.parse({
    schemaVersion: "host-authorization/v1",
    decision: "deny",
    scope: input.scope,
    hostId: input.hostId,
    hostWorkspaceId: input.facts?.hostWorkspaceId ?? input.scope.workspaceId,
    reason: input.reason,
    currentRevisions: input.currentRevisions,
    evaluatedAt: input.evaluatedAt,
    ...(input.facts ? { facts: input.facts } : {})
  });
}

/** Final execution/resolve check. Selection must use `hostCanSatisfyBlock` instead. */
export function evaluateHostAuthorization(input: {
  facts: HostAuthorizationFacts;
}): HostAuthorizationDecision {
  const facts = hostAuthorizationFactsSchema.parse(input.facts);
  const { scope, hostId, currentRevisions, evaluatedAt } = facts;
  if (facts.hostWorkspaceId !== "" && facts.hostWorkspaceId !== scope.workspaceId)
    return denyDecision({
      scope,
      hostId,
      reason: "cross_workspace",
      currentRevisions,
      evaluatedAt,
      facts
    });
  if (!facts.workspaceAcl.allowed)
    return denyDecision({
      scope,
      hostId,
      reason: "workspace_acl_denied",
      currentRevisions,
      evaluatedAt,
      facts
    });
  if (!facts.projectAcl.allowed)
    return denyDecision({
      scope,
      hostId,
      reason: "project_acl_denied",
      currentRevisions,
      evaluatedAt,
      facts
    });
  if (!facts.canvasAcl.allowed)
    return denyDecision({
      scope,
      hostId,
      reason: "canvas_acl_denied",
      currentRevisions,
      evaluatedAt,
      facts
    });
  if (facts.revoked)
    return denyDecision({
      scope,
      hostId,
      reason: "host_revoked",
      currentRevisions,
      evaluatedAt,
      facts
    });
  if (!facts.online)
    return denyDecision({
      scope,
      hostId,
      reason: "host_offline",
      currentRevisions,
      evaluatedAt,
      facts
    });
  if (facts.capacityRemaining < 1)
    return denyDecision({
      scope,
      hostId,
      reason: "host_at_capacity",
      currentRevisions,
      evaluatedAt,
      facts
    });
  if (
    !facts.requiredCapabilities.every((capability) =>
      facts.advertisedCapabilities.includes(capability)
    )
  )
    return denyDecision({
      scope,
      hostId,
      reason: "capability_mismatch",
      currentRevisions,
      evaluatedAt,
      facts
    });
  if (facts.lease.status !== "active")
    return denyDecision({
      scope,
      hostId,
      reason: "lease_missing",
      currentRevisions,
      evaluatedAt,
      facts
    });
  if (
    !(
      facts.attempt.status === "reserved" ||
      facts.attempt.status === "activated" ||
      facts.attempt.status === "running" ||
      facts.attempt.status === "awaiting_writeback"
    )
  )
    return denyDecision({
      scope,
      hostId,
      reason: "attempt_mismatch",
      currentRevisions,
      evaluatedAt,
      facts
    });
  if (facts.expectedRevisions.responsibilityRevision !== currentRevisions.responsibilityRevision)
    return denyDecision({
      scope,
      hostId,
      reason: "stale_responsibility_revision",
      currentRevisions,
      evaluatedAt,
      facts
    });
  if (facts.expectedRevisions.reviewerRevision !== currentRevisions.reviewerRevision)
    return denyDecision({
      scope,
      hostId,
      reason: "stale_reviewer_revision",
      currentRevisions,
      evaluatedAt,
      facts
    });
  if (facts.expectedRevisions.executionTargetRevision !== currentRevisions.executionTargetRevision)
    return denyDecision({
      scope,
      hostId,
      reason: "stale_execution_target_revision",
      currentRevisions,
      evaluatedAt,
      facts
    });
  return hostAuthorizationDecisionSchema.parse({
    schemaVersion: "host-authorization/v1",
    decision: "allow",
    scope,
    hostId,
    hostWorkspaceId: facts.hostWorkspaceId,
    reason: "authorized",
    currentRevisions,
    evaluatedAt,
    facts
  });
}
