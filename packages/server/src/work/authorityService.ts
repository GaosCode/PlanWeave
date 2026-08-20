import {
  executionTargetReadModelSchema,
  type ExecutionTargetReadModel
} from "@planweave-ai/collaboration-protocol/work/execution-target";
import { hostAuthorizationReadModelSchema } from "@planweave-ai/collaboration-protocol/work/host-authorization";
import {
  responsibilityReadModelSchema,
  type ResponsibilityReadModel
} from "@planweave-ai/collaboration-protocol/work/responsibility";
import {
  reviewAssignmentReadModelSchema,
  type ReviewAssignmentReadModel
} from "@planweave-ai/collaboration-protocol/work/review";
import {
  workAuthorityProjectionSchema,
  type WorkAuthorityProjection
} from "@planweave-ai/collaboration-protocol/work/authority";
import type { CollaborationAuthContext } from "../identity/index.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import type { AgentHost, AgentHostRepository } from "../hosts.js";
import { isAgentHostOnline, operatorHostAvailability } from "../hosts.js";
import { AuthorityRepository } from "./authorityRepository.js";
import {
  executionTargetMutationSchema,
  responsibilityMutationSchema,
  reviewerMutationSchema,
  authorityScopeSchema,
  type AuthorityActor,
  type AuthorityScope
} from "./authoritySchemas.js";
import {
  assertAssignmentPrincipalActive,
  assertExecutionTargetMutation,
  assertHumanScopeAuthorized
} from "./authorityPolicy.js";
import type { WorkItemPackagePort } from "./workItemFacts.js";
import { withWorkRuntimeFacts, type WorkRuntimePackageFactsPort } from "./runtimePort.js";
import { workItemRefSchema } from "./schemas.js";

function actorOf(context: CollaborationAuthContext): AuthorityActor {
  return { kind: "human", id: context.humanPrincipalId };
}

function assertMigration(repository: AuthorityRepository, scope: AuthorityScope): void {
  const state = repository.migrationState(scope.workspaceId, scope.projectId);
  if (state?.status === "repair_required") throw new Error("authority_migration_repair_required");
}

function workItem(scope: AuthorityScope) {
  return workItemRefSchema.parse(
    scope.kind === "task"
      ? { kind: "task", canvasId: scope.canvasId, taskId: scope.taskId }
      : { kind: "block", canvasId: scope.canvasId, blockRef: scope.blockRef }
  );
}

export type AuthorityServiceOptions = {
  repository: AuthorityRepository;
  runtimeFacts: WorkRuntimePackageFactsPort;
  access: ProjectAccessRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  hosts: AgentHostRepository;
  clock?: () => Date;
  /** Optional online window for Host selection projections (ms). */
  hostOfflineAfterMs?: number;
  /**
   * Optional active-dispatch lease snapshot for UI only.
   * Never used as mutation or dispatch authority.
   */
  resolveActiveLease?: (input: {
    projectId: string;
    canvasId: string;
    blockRef: string;
    hostId: string;
  }) =>
    | {
        status: "active" | "expired" | "revoked";
        leaseId: string;
        expiresAt: string;
      }
    | undefined;
};

/** Server application boundary for independent responsibility/reviewer/Host mutations. */
export class AuthorityService {
  private readonly clock: () => Date;

  constructor(private readonly options: AuthorityServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  async updateResponsibility(actor: CollaborationAuthContext, rawIntent: unknown) {
    const intent = responsibilityMutationSchema.parse(rawIntent);
    const scope = authorityScopeSchema.parse(intent.scope);
    this.assertActorScope(actor, scope);
    assertMigration(this.options.repository, scope);
    assertHumanScopeAuthorized({
      actor,
      scope,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity,
      capability: "assignment"
    });
    return await this.withPackageScope(scope, (packagePort) => {
      this.assertPackageScope(scope, packagePort);
      if (intent.principal) {
        assertAssignmentPrincipalActive({
          actor,
          workspaceId: scope.workspaceId,
          humanPrincipalId: intent.principal.humanPrincipalId,
          workspaceIdentity: this.options.workspaceIdentity
        });
      }
      this.options.repository.applyResponsibility({ mutation: intent, actor: actorOf(actor) });
      return this.getResponsibility(actor, scope)!;
    });
  }

  async updateReviewer(actor: CollaborationAuthContext, rawIntent: unknown) {
    const intent = reviewerMutationSchema.parse(rawIntent);
    const scope = authorityScopeSchema.parse(intent.scope);
    this.assertActorScope(actor, scope);
    assertMigration(this.options.repository, scope);
    assertHumanScopeAuthorized({
      actor,
      scope,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity,
      capability: "assignment"
    });
    return await this.withPackageScope(scope, (packagePort) => {
      this.assertPackageScope(scope, packagePort);
      if (intent.principal) {
        assertAssignmentPrincipalActive({
          actor,
          workspaceId: scope.workspaceId,
          humanPrincipalId: intent.principal.humanPrincipalId,
          workspaceIdentity: this.options.workspaceIdentity
        });
      }
      this.options.repository.applyReviewer({ mutation: intent, actor: actorOf(actor) });
      return this.getReviewer(actor, scope)!;
    });
  }

  async updateExecutionTarget(actor: CollaborationAuthContext, rawIntent: unknown) {
    const intent = executionTargetMutationSchema.parse(rawIntent);
    const scope = intent.scope;
    this.assertActorScope(actor, scope);
    assertMigration(this.options.repository, scope);
    assertHumanScopeAuthorized({
      actor,
      scope,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity,
      capability: "assignment"
    });
    return await this.withPackageScope(scope, (packagePort) => {
      const packageFacts = packagePort.resolveWorkItem(workItem(scope));
      assertExecutionTargetMutation({
        actor,
        scope,
        target: intent.target,
        access: this.options.access,
        workspaceIdentity: this.options.workspaceIdentity,
        hosts: this.options.hosts,
        packageFacts,
        now: this.clock(),
        hostOfflineAfterMs: this.options.hostOfflineAfterMs ?? 60_000
      });
      this.options.repository.applyExecutionTarget({
        mutation: intent,
        actor: actorOf(actor)
      });
      return this.getExecutionTargetWithFacts(scope, packagePort)!;
    });
  }

  getResponsibility(
    actor: CollaborationAuthContext,
    rawScope: unknown
  ): ResponsibilityReadModel | undefined {
    const scope = this.authorizeRead(actor, rawScope);
    const record = this.options.repository.getResponsibility(scope);
    if (!record) return undefined;
    const availability =
      record.principal === null
        ? "unassigned"
        : this.isActiveWorkspaceMember(scope.workspaceId, record.principal.humanPrincipalId)
          ? "active"
          : "inactive_member";
    return responsibilityReadModelSchema.parse({ ...record, availability });
  }

  getReviewer(
    actor: CollaborationAuthContext,
    rawScope: unknown
  ): ReviewAssignmentReadModel | undefined {
    const scope = this.authorizeRead(actor, rawScope);
    const record = this.options.repository.getReviewer(scope);
    if (!record) return undefined;
    const availability =
      record.principal === null
        ? "unassigned"
        : this.isActiveWorkspaceMember(scope.workspaceId, record.principal.humanPrincipalId)
          ? "active"
          : "inactive_member";
    return reviewAssignmentReadModelSchema.parse({ ...record, availability });
  }

  async getExecutionTarget(
    actor: CollaborationAuthContext,
    rawScope: unknown
  ): Promise<ExecutionTargetReadModel | undefined> {
    const scope = authorityScopeSchema.parse(rawScope);
    if (scope.kind !== "block") throw new Error("execution_target_requires_exact_block_scope");
    this.authorizeRead(actor, scope);
    return await this.withPackageScope(scope, (packagePort) =>
      this.getExecutionTargetWithFacts(scope, packagePort)
    );
  }

  private getExecutionTargetWithFacts(
    scope: Extract<AuthorityScope, { kind: "block" }>,
    packagePort: WorkItemPackagePort
  ): ExecutionTargetReadModel | undefined {
    this.assertPackageScope(scope, packagePort);
    const record = this.options.repository.getExecutionTarget(scope);
    if (!record) return undefined;
    const target = record.target;
    if (target.kind === "unassigned")
      return executionTargetReadModelSchema.parse({
        ...record,
        availability: { status: "unassigned", reason: "unassigned" }
      });
    const host = target.kind === "exact_host" ? this.options.hosts.get(target.hostId) : undefined;
    if (target.kind === "automatic_host")
      return executionTargetReadModelSchema.parse({
        ...record,
        availability: { status: "pending", reason: "automatic_pending_selection" }
      });
    // Align exact_host availability with selection readiness (offline/capacity/capability/ACL),
    // not only missing/revoked — Desktop assignmentProjectionFromAuthority uses this field.
    const packageFacts = packagePort.resolveWorkItem(workItem(scope));
    const reason = this.selectionAvailabilityReason({
      host,
      hostId: target.hostId,
      scope,
      requiredCapabilities: packageFacts.requiredCapabilities
    });
    const availability =
      reason === "ready"
        ? ({ status: "ready", reason: "ready" } as const)
        : reason === "host_offline" || reason === "host_at_capacity"
          ? ({ status: "unavailable", reason } as const)
          : ({ status: "invalid", reason } as const);
    return executionTargetReadModelSchema.parse({
      ...record,
      availability
    });
  }

  currentRevisions(actor: CollaborationAuthContext, rawScope: unknown) {
    const scope = this.authorizeRead(actor, rawScope);
    return this.options.repository.currentRevisions(scope);
  }

  /**
   * Redacted composite projection for Desktop.
   * Missing durable rows surface as unassigned revision 0 so clients can CAS cleanly.
   * Task scopes never include Host execution targets.
   */
  async getWorkAuthorityProjection(
    actor: CollaborationAuthContext,
    rawScope: unknown
  ): Promise<WorkAuthorityProjection> {
    const scope = this.authorizeRead(actor, rawScope);
    return await this.withPackageScope(scope, (packagePort) => {
      this.assertPackageScope(scope, packagePort);
      const evaluatedAt = this.clock().toISOString();
      const revisions = this.options.repository.currentRevisions(scope);
      const responsibility =
        this.getResponsibility(actor, scope) ??
        responsibilityReadModelSchema.parse({
          schemaVersion: "responsibility/v1",
          scope,
          principal: null,
          revision: 0,
          updatedAt: evaluatedAt,
          availability: "unassigned"
        });
      const reviewer =
        this.getReviewer(actor, scope) ??
        reviewAssignmentReadModelSchema.parse({
          schemaVersion: "review-assignment/v1",
          scope,
          principal: null,
          revision: 0,
          updatedAt: evaluatedAt,
          availability: "unassigned"
        });

      if (scope.kind === "task") {
        return workAuthorityProjectionSchema.parse({
          schemaVersion: "work-authority/v1",
          scope,
          responsibility,
          reviewer,
          executionTarget: null,
          revisions,
          selectedHost: null,
          evaluatedAt
        });
      }

      const executionTarget =
        this.getExecutionTargetWithFacts(scope, packagePort) ??
        executionTargetReadModelSchema.parse({
          schemaVersion: "execution-target/v1",
          scope,
          target: { kind: "unassigned" },
          revision: 0,
          updatedAt: evaluatedAt,
          availability: { status: "unassigned", reason: "unassigned" }
        });
      const selectedHost = this.projectSelectedHost({
        scope,
        executionTarget,
        revisions,
        evaluatedAt,
        packagePort
      });

      return workAuthorityProjectionSchema.parse({
        schemaVersion: "work-authority/v1",
        scope,
        responsibility,
        reviewer,
        executionTarget,
        revisions,
        selectedHost,
        evaluatedAt
      });
    });
  }

  private projectSelectedHost(input: {
    scope: Extract<AuthorityScope, { kind: "block" }>;
    executionTarget: ExecutionTargetReadModel;
    revisions: ReturnType<AuthorityRepository["currentRevisions"]>;
    evaluatedAt: string;
    packagePort: WorkItemPackagePort;
  }) {
    const { scope, executionTarget, revisions, evaluatedAt, packagePort } = input;
    if (executionTarget.target.kind !== "exact_host") {
      return null;
    }

    const hostId = executionTarget.target.hostId;
    const host = this.options.hosts.get(hostId);
    const packageFacts = packagePort.resolveWorkItem(workItem(scope));
    const availabilityReason = this.selectionAvailabilityReason({
      host,
      hostId,
      scope,
      requiredCapabilities: packageFacts.requiredCapabilities
    });
    const lease = this.resolveLeaseProjection({
      projectId: scope.projectId,
      canvasId: scope.canvasId,
      blockRef: scope.blockRef,
      hostId
    });
    // Selection readiness (availabilityReason) is independent of active lease.
    // Authorization reason stays deny/lease_missing until a live attempt holds a lease.
    const authorizationReason =
      availabilityReason === "host_missing"
        ? ("host_missing" as const)
        : availabilityReason === "host_revoked"
          ? ("host_revoked" as const)
          : availabilityReason === "host_offline"
            ? ("host_offline" as const)
            : availabilityReason === "host_at_capacity"
              ? ("host_at_capacity" as const)
              : availabilityReason === "host_capability_mismatch"
                ? ("capability_mismatch" as const)
                : availabilityReason === "host_not_authorized"
                  ? ("workspace_acl_denied" as const)
                  : lease.status === "active"
                    ? ("authorized" as const)
                    : ("lease_missing" as const);
    const authorization = hostAuthorizationReadModelSchema.parse({
      schemaVersion: "host-authorization/v1",
      scope,
      hostId,
      decision: authorizationReason === "authorized" ? "allow" : "deny",
      reason: authorizationReason,
      currentRevisions: revisions,
      evaluatedAt
    });

    return {
      hostId,
      availabilityReason,
      lease,
      authorization
    };
  }

  private selectionAvailabilityReason(input: {
    host: AgentHost | undefined;
    hostId: string;
    scope: Extract<AuthorityScope, { kind: "block" }>;
    requiredCapabilities: readonly string[];
  }):
    | "ready"
    | "host_missing"
    | "host_revoked"
    | "host_offline"
    | "host_at_capacity"
    | "host_capability_mismatch"
    | "host_not_authorized" {
    const { host, scope, requiredCapabilities } = input;
    if (!host) return "host_missing";
    if (host.revokedAt !== undefined) return "host_revoked";
    const hostWorkspace = this.options.workspaceIdentity.workspaceForHost(host.id);
    if (!hostWorkspace || hostWorkspace !== scope.workspaceId) return "host_not_authorized";
    const project = this.options.access.registry.projectInternal(
      scope.workspaceId,
      scope.projectId
    );
    const canvas = this.options.access.registry.canvasInternal(
      scope.workspaceId,
      scope.projectId,
      scope.canvasId
    );
    if (!project || project.revokedAt !== null || !canvas || canvas.revokedAt !== null) {
      return "host_not_authorized";
    }
    const offlineAfterMs = this.options.hostOfflineAfterMs ?? 60_000;
    const online = isAgentHostOnline(host, {
      now: this.clock(),
      hostOfflineAfterMs: offlineAfterMs
    });
    if (!online) {
      return "host_offline";
    }
    if (operatorHostAvailability(host, scope.workspaceId, online).status !== "available") {
      return "host_offline";
    }
    if (host.capacity < 1) return "host_at_capacity";
    if (!requiredCapabilities.every((capability) => host.capabilities.includes(capability))) {
      return "host_capability_mismatch";
    }
    return "ready";
  }

  private resolveLeaseProjection(input: {
    projectId: string;
    canvasId: string;
    blockRef: string;
    hostId: string;
  }) {
    const snapshot = this.options.resolveActiveLease?.(input);
    if (!snapshot) {
      return { status: "none" as const, leaseId: null, expiresAt: null };
    }
    return {
      status: snapshot.status,
      leaseId: snapshot.leaseId,
      expiresAt: snapshot.expiresAt
    };
  }

  private authorizeRead(actor: CollaborationAuthContext, rawScope: unknown): AuthorityScope {
    const scope = authorityScopeSchema.parse(rawScope);
    this.assertActorScope(actor, scope);
    assertMigration(this.options.repository, scope);
    assertHumanScopeAuthorized({
      actor,
      scope,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity
    });
    return scope;
  }

  private assertActorScope(actor: CollaborationAuthContext, scope: AuthorityScope): void {
    if (actor.projectId !== scope.projectId) throw new Error("authority_project_mismatch");
    if (!this.options.workspaceIdentity.workspaceExists(scope.workspaceId))
      throw new Error("authority_workspace_mismatch");
  }

  private assertPackageScope(scope: AuthorityScope, packagePort: WorkItemPackagePort): void {
    const facts = packagePort.resolveWorkItem(workItem(scope));
    if (!facts.exists || facts.kind !== scope.kind)
      throw new Error("authority_work_item_not_found");
    if (scope.kind === "task" && facts.taskId !== scope.taskId)
      throw new Error("authority_work_item_not_found");
    if (scope.kind === "block" && facts.blockRef !== scope.blockRef)
      throw new Error("authority_work_item_not_found");
  }

  private withPackageScope<T>(
    scope: AuthorityScope,
    use: (packagePort: WorkItemPackagePort) => T | Promise<T>
  ): Promise<T> {
    return withWorkRuntimeFacts(
      this.options.runtimeFacts,
      { workspaceId: scope.workspaceId, projectId: scope.projectId },
      [workItem(scope)],
      use
    );
  }

  private isActiveWorkspaceMember(workspaceId: string, humanPrincipalId: string): boolean {
    return this.options.workspaceIdentity
      .listMembershipViews(workspaceId)
      .some(
        (membership) =>
          membership.humanPrincipalId === humanPrincipalId && membership.revokedAt === null
      );
  }
}
