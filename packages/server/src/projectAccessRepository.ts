import { createHash } from "node:crypto";
import {
  accessDisabledReasonSchema,
  accessMutationRequestSchema,
  activeCanvasPersonGrantSchema,
  requiredCapabilityForAccessMutation,
  type AccessMutationRequest,
  type AccessMutationResult,
  type ActiveCanvasPersonGrant,
  type EffectiveAccessView
} from "@planweave-ai/collaboration-protocol/access/control";
import {
  canvasScopeRefSchema,
  humanPrincipalIdSchema,
  actorRefSchema,
  type ActorRef
} from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  aclRevisionSchema,
  membershipGrantSchema,
  type MembershipGrant,
  type ProjectAccessDecision,
  type ProjectAccessRecord,
  type CanvasAccessRecord
} from "@planweave-ai/collaboration-protocol/access/project";
import { z } from "zod";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";
import { assertNoPendingSnapshotRestore } from "./authorizationFence.js";
import type { AuthorizationChangeScope } from "./authorizationChangeSignal.js";
import { ProjectAccessPolicy } from "./projectAccessPolicy.js";
import {
  ProjectRegistryRepository,
  type InternalCanvasRecord,
  type InternalProjectRecord,
  activeWorkspacePrincipal
} from "./projectRegistryRepository.js";

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const grantInputSchema = z
  .object({
    workspaceId: identifierSchema,
    projectId: identifierSchema,
    canvasId: identifierSchema.nullable().default(null),
    humanPrincipalId: identifierSchema,
    role: z.enum(["owner", "editor", "viewer"]),
    grantedBy: actorRefSchema
  })
  .strict();
const revokeInputSchema = z
  .object({
    workspaceId: identifierSchema,
    projectId: identifierSchema,
    canvasId: identifierSchema.nullable().default(null),
    grantId: identifierSchema,
    actor: actorRefSchema,
    expectedAclRevision: aclRevisionSchema
  })
  .strict();

/** Grant/revocation persistence composed with the registry and policy boundaries. */
export class ProjectAccessRepository {
  readonly registry: ProjectRegistryRepository;
  readonly policy: ProjectAccessPolicy;

  constructor(
    private readonly database: SqliteDatabase,
    clock: () => Date = () => new Date(),
    private readonly onAuthorizationChangeAfterCommit?: (change: AuthorizationChangeScope) => void
  ) {
    this.registry = new ProjectRegistryRepository(database, clock);
    this.policy = new ProjectAccessPolicy(database, this.registry);
    this.clock = clock;
  }

  private readonly clock: () => Date;

  registerProjectInternal(input: unknown): InternalProjectRecord {
    return this.registry.registerProjectInternal(input);
  }
  registerCanvasInternal(input: unknown): InternalCanvasRecord {
    return this.registry.registerCanvasInternal(input);
  }
  initializeProjectOwner(
    workspaceId: string,
    projectId: string,
    ownerHumanPrincipalId: string
  ): InternalProjectRecord {
    return this.registry.initializeProjectOwner(workspaceId, projectId, ownerHumanPrincipalId);
  }
  initializeCanvasOwner(
    workspaceId: string,
    projectId: string,
    canvasId: string,
    ownerHumanPrincipalId: string
  ): InternalCanvasRecord {
    return this.registry.initializeCanvasOwner(
      workspaceId,
      projectId,
      canvasId,
      ownerHumanPrincipalId
    );
  }
  synchronizeHumanMembershipOwnerInCallerTransaction(input: {
    workspaceId: string;
    projectId: string;
    humanPrincipalId: string;
    transition: "member_joined" | "member_removed" | "owner_promoted" | "owner_demoted";
    membershipRole: "owner" | "member";
  }): void {
    this.registry.synchronizeHumanMembershipOwnerInCallerTransaction(input);
  }
  registerProject(input: unknown): ProjectAccessRecord | undefined {
    return this.registry.registerProject(input);
  }
  registerCanvas(input: unknown): CanvasAccessRecord | undefined {
    return this.registry.registerCanvas(input);
  }
  registerPathlessCanvas(input: unknown): CanvasAccessRecord {
    return this.registry.registerPathlessCanvas(input);
  }
  project(workspaceId: string, projectId: string): ProjectAccessRecord | undefined {
    return this.registry.project(workspaceId, projectId);
  }
  canvas(workspaceId: string, projectId: string, canvasId: string): CanvasAccessRecord | undefined {
    return this.registry.canvas(workspaceId, projectId, canvasId);
  }
  decideProjectAccess(input: {
    workspaceId: string;
    projectId: string;
    actor: ActorRef;
  }): ProjectAccessDecision {
    return this.policy.decideProject(input);
  }
  decideCanvasAccess(input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    actor: ActorRef;
  }): ProjectAccessDecision {
    return this.policy.decideCanvas(input);
  }
  evaluateEffectiveAccess(input: {
    workspaceId: string;
    projectId: string;
    canvasId?: string;
    actor: ActorRef;
    session?: "active" | "missing" | "expired" | "revoked";
  }): EffectiveAccessView {
    return this.policy.evaluate(input);
  }
  listAuthorizedProjects(input: {
    workspaceId: string;
    actor: ActorRef;
    limit?: number;
    offset?: number;
  }): ProjectAccessRecord[] {
    return this.policy.listProjects(input);
  }
  listAuthorizedCanvases(input: {
    workspaceId: string;
    projectId: string;
    actor: ActorRef;
    limit?: number;
    offset?: number;
  }): CanvasAccessRecord[] {
    return this.policy.listCanvases(input);
  }
  listActiveCanvasPersonGrants(input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    humanPrincipalId: string;
  }): ActiveCanvasPersonGrant[] {
    const scope = canvasScopeRefSchema.parse({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      canvasId: input.canvasId
    });
    const humanPrincipalId = humanPrincipalIdSchema.parse(input.humanPrincipalId);
    const project = this.registry.projectInternal(scope.workspaceId, scope.projectId);
    const canvas = this.registry.canvasInternal(scope.workspaceId, scope.projectId, scope.canvasId);
    if (!project || project.revokedAt !== null || !canvas || canvas.revokedAt !== null) {
      throw new Error("access_scope_not_found");
    }
    return this.database
      .prepare(
        `SELECT grant_id,scope_kind,role FROM project_access_grants
         WHERE workspace_id=? AND project_id=? AND human_principal_id=? AND revoked_at IS NULL
           AND role IN ('editor','viewer')
           AND ((scope_kind='project' AND project_registry_id=? AND canvas_registry_id IS NULL)
             OR (scope_kind='canvas' AND canvas_registry_id=?))
         ORDER BY CASE scope_kind WHEN 'project' THEN 0 ELSE 1 END`
      )
      .all(
        scope.workspaceId,
        scope.projectId,
        humanPrincipalId,
        project.projectRegistryId,
        canvas.canvasRegistryId
      )
      .map((row) =>
        activeCanvasPersonGrantSchema.parse({
          grantId: row.grant_id,
          scopeKind: row.scope_kind,
          role: row.role
        })
      );
  }
  bindProjectPath(workspaceId: string, projectId: string, projectRoot: string): void {
    this.registry.bindProjectPath(workspaceId, projectId, projectRoot);
  }
  bindCanvasPath(
    workspaceId: string,
    projectId: string,
    canvasId: string,
    packageDir: string
  ): void {
    this.registry.bindCanvasPath(workspaceId, projectId, canvasId, packageDir);
  }
  markCanvasCutover(workspaceId: string, projectId: string, canvasId: string): void {
    this.registry.markCanvasCutover(workspaceId, projectId, canvasId);
  }
  finalizeProjectCutover(workspaceId: string, projectId: string): void {
    this.registry.finalizeProjectCutover(workspaceId, projectId);
  }
  reconcileRuntimeCanvases(
    workspaceId: string,
    projectId: string,
    trustedCanvasIds: readonly string[]
  ): void {
    this.registry.reconcileRuntimeCanvases(workspaceId, projectId, trustedCanvasIds);
  }

  grant(rawInput: unknown): MembershipGrant {
    const input = grantInputSchema.parse(rawInput);
    if (input.role === "owner") throw new Error("project_owner_grant_forbidden");
    this.policy.assertCanManage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      canvasId: input.canvasId ?? undefined,
      actor: input.grantedBy
    });
    const grant = inWriteTransaction(this.database, () => {
      assertNoPendingSnapshotRestore(this.database, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        canvasId: input.canvasId
      });
      const project = this.registry.projectInternal(input.workspaceId, input.projectId);
      if (!project || project.revokedAt !== null) throw new Error("project_registry_not_found");
      if (!activeWorkspacePrincipal(this.database, input.workspaceId, input.humanPrincipalId))
        throw new Error("access_grant_principal_not_active");
      const canvas =
        input.canvasId === null
          ? undefined
          : this.registry.canvasInternal(input.workspaceId, input.projectId, input.canvasId);
      if (input.canvasId !== null && !canvas) throw new Error("canvas_registry_not_found");
      const scopeId = canvas?.canvasRegistryId ?? project.projectRegistryId;
      const currentRevision = canvas?.aclRevision ?? project.aclRevision;
      const revision = currentRevision + 1;
      const at = this.clock().toISOString();
      const grantId = `grant-${createHash("sha256")
        .update(
          [
            input.workspaceId,
            input.projectId,
            input.canvasId ?? "",
            input.humanPrincipalId,
            String(revision)
          ].join("\0")
        )
        .digest("hex")
        .slice(0, 32)}`;
      const updatedScope = this.database
        .prepare(
          `UPDATE ${canvas ? "canvas_registry" : "project_registry"} SET acl_revision=?,updated_at=? WHERE ${canvas ? "canvas_registry_id=?" : "project_registry_id=?"} AND acl_revision=?`
        )
        .run(revision, at, scopeId, currentRevision);
      if (updatedScope.changes !== 1) throw new Error("access_grant_stale_revision");
      this.database
        .prepare(
          `INSERT INTO project_access_grants(grant_id,workspace_id,project_registry_id,project_id,canvas_registry_id,canvas_id,scope_kind,human_principal_id,role,acl_revision,granted_by_kind,granted_by_id,granted_at,revoked_at) VALUES(?,?,?,?,?,?,?, ?,?,?, ?,?,?,NULL)`
        )
        .run(
          grantId,
          input.workspaceId,
          project.projectRegistryId,
          input.projectId,
          canvas?.canvasRegistryId ?? null,
          canvas?.canvasId ?? null,
          canvas ? "canvas" : "project",
          input.humanPrincipalId,
          input.role,
          revision,
          input.grantedBy.kind,
          input.grantedBy.id,
          at
        );
      return membershipGrantSchema.parse({
        schemaVersion: "project-access/v1",
        grantId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        humanPrincipalId: input.humanPrincipalId,
        role: input.role,
        aclRevision: revision,
        grantedBy: input.grantedBy,
        grantedAt: at,
        revokedAt: null,
        scopeKind: canvas ? "canvas" : "project",
        canvasId: canvas?.canvasId ?? null
      });
    });
    this.onAuthorizationChangeAfterCommit?.({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      humanPrincipalId: input.humanPrincipalId
    });
    return grant;
  }

  revoke(rawInput: unknown): MembershipGrant {
    const input = revokeInputSchema.parse(rawInput);
    const id = input.grantId;
    const expected = input.expectedAclRevision;
    const grant = inWriteTransaction(this.database, () => {
      assertNoPendingSnapshotRestore(this.database, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        canvasId: input.canvasId
      });
      this.policy.assertCanManage({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        canvasId: input.canvasId ?? undefined,
        actor: input.actor
      });
      const row = this.database
        .prepare(`
        SELECT * FROM project_access_grants
        WHERE grant_id=? AND workspace_id=? AND project_id=?
          AND ((scope_kind='project' AND canvas_id IS NULL AND ? IS NULL)
            OR (scope_kind='canvas' AND canvas_id=?))
      `)
        .get(id, input.workspaceId, input.projectId, input.canvasId, input.canvasId) as
        | Record<string, unknown>
        | undefined;
      if (!row) throw new Error("access_grant_not_found");
      const scopeColumn =
        row.scope_kind === "canvas" ? "canvas_registry_id" : "project_registry_id";
      const scopeId = row[scopeColumn];
      const scope = this.database
        .prepare(
          `SELECT acl_revision FROM ${row.scope_kind === "canvas" ? "canvas_registry" : "project_registry"} WHERE ${scopeColumn}=?`
        )
        .get(scopeId) as { acl_revision: number } | undefined;
      if (row.revoked_at !== null) {
        if (
          scope &&
          Number(scope.acl_revision) === Number(row.acl_revision) &&
          (expected === Number(row.acl_revision) || expected + 1 === Number(row.acl_revision))
        )
          return this.grantFromRow(row);
        throw new Error("access_grant_stale_revision");
      }
      const pendingSnapshot =
        row.scope_kind === "canvas"
          ? this.database
              .prepare(
                `SELECT snapshot_id FROM package_snapshots
                 WHERE workspace_id=? AND project_id=? AND canvas_id=?
                   AND state='available' AND restore_marker='restore_pending'
                 LIMIT 1`
              )
              .get(input.workspaceId, input.projectId, row.canvas_id)
          : this.database
              .prepare(
                `SELECT snapshot_id FROM package_snapshots
                 WHERE workspace_id=? AND project_id=?
                   AND state='available' AND restore_marker='restore_pending'
                 LIMIT 1`
              )
              .get(input.workspaceId, input.projectId);
      if (pendingSnapshot) throw new Error("snapshot_restore_pending");
      if (!scope || Number(scope.acl_revision) !== expected)
        throw new Error("access_grant_stale_revision");
      const at = this.clock().toISOString();
      const nextRevision = expected + 1;
      const updatedScope = this.database
        .prepare(
          `UPDATE ${row.scope_kind === "canvas" ? "canvas_registry" : "project_registry"} SET acl_revision=?,updated_at=? WHERE ${scopeColumn}=? AND acl_revision=?`
        )
        .run(nextRevision, at, scopeId, expected);
      if (updatedScope.changes !== 1) throw new Error("access_grant_stale_revision");
      const revoked = this.database
        .prepare(
          "UPDATE project_access_grants SET revoked_at=?,acl_revision=? WHERE grant_id=? AND revoked_at IS NULL"
        )
        .run(at, nextRevision, id);
      if (revoked.changes !== 1) throw new Error("access_grant_revision_conflict");
      return this.grantFromRow(
        this.database
          .prepare("SELECT * FROM project_access_grants WHERE grant_id=?")
          .get(id) as Record<string, unknown>
      );
    });
    this.onAuthorizationChangeAfterCommit?.({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      humanPrincipalId: grant.humanPrincipalId
    });
    return grant;
  }

  /**
   * The HTTP/Desktop ACL mutation seam. It consumes the shared B-001 request
   * and result contracts, preserves exact opaque scope identity, and reports
   * stale CAS as a redacted conflict rather than applying a newer write.
   */
  compareAndSetAccess(input: {
    actor: ActorRef;
    request: AccessMutationRequest;
  }): AccessMutationResult {
    const request = accessMutationRequestSchema.parse(input.request);
    const scope = request.scope;
    const canvasId = scope.scopeKind === "canvas" ? scope.canvasId : null;
    try {
      this.policy.assertCapability({
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        ...(canvasId === null ? {} : { canvasId }),
        actor: input.actor,
        capability: requiredCapabilityForAccessMutation(request.operation)
      });
    } catch (error) {
      const current = this.currentAclRevision(scope.workspaceId, scope.projectId, canvasId);
      return {
        status: "denied",
        reason:
          error instanceof Error && error.message.startsWith("access_capability_denied:")
            ? (accessDisabledReasonSchema.safeParse(
                error.message.slice("access_capability_denied:".length)
              ).data ?? "capability_denied")
            : "capability_denied",
        aclRevision: current
      };
    }

    const result: AccessMutationResult = inWriteTransaction(this.database, () => {
      const current = this.currentAclRevision(scope.workspaceId, scope.projectId, canvasId);
      if (current !== request.expectedAclRevision) {
        return { status: "conflict", reason: "acl_revision_conflict", aclRevision: current };
      }
      const at = this.clock().toISOString();
      if (request.operation === "visibility") {
        const table = canvasId === null ? "project_registry" : "canvas_registry";
        const idColumn = canvasId === null ? "project_registry_id" : "canvas_registry_id";
        const projectScope =
          canvasId === null
            ? this.registry.projectInternal(scope.workspaceId, scope.projectId)
            : undefined;
        const canvasScope =
          canvasId === null
            ? undefined
            : this.registry.canvasInternal(scope.workspaceId, scope.projectId, canvasId);
        if (
          (!projectScope && !canvasScope) ||
          (projectScope !== undefined && projectScope.revokedAt !== null) ||
          (canvasScope !== undefined && canvasScope.revokedAt !== null)
        ) {
          return { status: "denied", reason: "scope_private", aclRevision: current };
        }
        const scopeId = projectScope?.projectRegistryId ?? canvasScope!.canvasRegistryId;
        const updated = this.database
          .prepare(
            `UPDATE ${table} SET visibility=?,acl_revision=?,updated_at=? WHERE ${idColumn}=? AND acl_revision=? AND revoked_at IS NULL`
          )
          .run(request.visibility, current + 1, at, scopeId, current);
        if (updated.changes !== 1)
          return {
            status: "conflict",
            reason: "acl_revision_conflict",
            aclRevision: this.currentAclRevision(scope.workspaceId, scope.projectId, canvasId)
          };
        return { status: "applied", aclRevision: current + 1, updatedAt: at };
      }
      if (request.operation === "grant") {
        if (!activeWorkspacePrincipal(this.database, scope.workspaceId, request.humanPrincipalId)) {
          return { status: "denied", reason: "membership_missing", aclRevision: current };
        }
        const project = this.registry.projectInternal(scope.workspaceId, scope.projectId);
        const canvas =
          canvasId === null
            ? undefined
            : this.registry.canvasInternal(scope.workspaceId, scope.projectId, canvasId);
        if (
          !project ||
          project.revokedAt !== null ||
          (canvasId !== null && (!canvas || canvas.revokedAt !== null))
        ) {
          return { status: "denied", reason: "scope_private", aclRevision: current };
        }
        const table = canvas ? "canvas_registry" : "project_registry";
        const idColumn = canvas ? "canvas_registry_id" : "project_registry_id";
        const scopeId = canvas ? canvas.canvasRegistryId : project.projectRegistryId;
        const nextRevision = current + 1;
        const updated = this.database
          .prepare(
            `UPDATE ${table} SET acl_revision=?,updated_at=? WHERE ${idColumn}=? AND acl_revision=? AND revoked_at IS NULL`
          )
          .run(nextRevision, at, scopeId, current);
        if (updated.changes !== 1)
          return {
            status: "conflict",
            reason: "acl_revision_conflict",
            aclRevision: this.currentAclRevision(scope.workspaceId, scope.projectId, canvasId)
          };
        const grantId = `grant-${createHash("sha256")
          .update(
            [
              scope.workspaceId,
              scope.projectId,
              canvasId ?? "",
              request.humanPrincipalId,
              String(nextRevision)
            ].join("\0")
          )
          .digest("hex")
          .slice(0, 32)}`;
        this.database
          .prepare(
            `INSERT INTO project_access_grants(grant_id,workspace_id,project_registry_id,project_id,canvas_registry_id,canvas_id,scope_kind,human_principal_id,role,acl_revision,granted_by_kind,granted_by_id,granted_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`
          )
          .run(
            grantId,
            scope.workspaceId,
            project.projectRegistryId,
            scope.projectId,
            canvas?.canvasRegistryId ?? null,
            canvasId,
            canvas ? "canvas" : "project",
            request.humanPrincipalId,
            request.role,
            nextRevision,
            input.actor.kind,
            input.actor.id,
            at
          );
        return { status: "applied", aclRevision: nextRevision, updatedAt: at };
      }
      const grant = this.database
        .prepare(
          `SELECT grant_id,scope_kind,canvas_id,revoked_at FROM project_access_grants
           WHERE grant_id=? AND workspace_id=? AND project_id=?
             AND ((scope_kind='project' AND ? IS NULL) OR (scope_kind='canvas' AND canvas_id=?))`
        )
        .get(request.grantId, scope.workspaceId, scope.projectId, canvasId, canvasId) as
        | {
            grant_id: string;
            scope_kind: string;
            canvas_id: string | null;
            revoked_at: string | null;
          }
        | undefined;
      if (!grant) return { status: "denied", reason: "scope_private", aclRevision: current };
      if (grant.revoked_at !== null) {
        return { status: "conflict", reason: "acl_revision_conflict", aclRevision: current };
      }
      const updatedScope = this.database
        .prepare(
          `UPDATE ${canvasId === null ? "project_registry" : "canvas_registry"} SET acl_revision=?,updated_at=?
           WHERE workspace_id=? AND project_id=?${canvasId === null ? "" : " AND canvas_id=?"} AND acl_revision=? AND revoked_at IS NULL`
        )
        .run(
          current + 1,
          at,
          scope.workspaceId,
          scope.projectId,
          ...(canvasId === null ? [] : [canvasId]),
          current
        );
      if (updatedScope.changes !== 1) throw new Error("access_scope_revision_race");
      const revoked = this.database
        .prepare(
          "UPDATE project_access_grants SET revoked_at=?,acl_revision=? WHERE grant_id=? AND revoked_at IS NULL"
        )
        .run(at, current + 1, request.grantId);
      if (revoked.changes !== 1) throw new Error("access_grant_revision_race");
      return { status: "applied", aclRevision: current + 1, updatedAt: at };
    });
    if (result.status === "applied") {
      this.onAuthorizationChangeAfterCommit?.({
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        ...(request.operation === "grant" ? { humanPrincipalId: request.humanPrincipalId } : {})
      });
    }
    return result;
  }

  private currentAclRevision(
    workspaceId: string,
    projectId: string,
    canvasId: string | null
  ): number {
    const row =
      canvasId === null
        ? this.registry.projectInternal(workspaceId, projectId)
        : this.registry.canvasInternal(workspaceId, projectId, canvasId);
    return row?.aclRevision ?? 0;
  }

  private grantFromRow(row: Record<string, unknown>): MembershipGrant {
    return membershipGrantSchema.parse({
      schemaVersion: "project-access/v1",
      grantId: row.grant_id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      humanPrincipalId: row.human_principal_id,
      role: row.role,
      aclRevision: Number(row.acl_revision),
      grantedBy: { kind: row.granted_by_kind, id: row.granted_by_id },
      grantedAt: row.granted_at,
      revokedAt: row.revoked_at,
      scopeKind: row.scope_kind,
      canvasId: row.canvas_id
    });
  }
}

export { ProjectAccessPolicy } from "./projectAccessPolicy.js";
export { ProjectRegistryRepository } from "./projectRegistryRepository.js";
export type { InternalCanvasRecord, InternalProjectRecord } from "./projectRegistryRepository.js";
