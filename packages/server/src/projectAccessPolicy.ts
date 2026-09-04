import {
  accessScopeSchema,
  evaluateEffectiveAccess,
  type AccessCapability,
  type AccessDisabledReason,
  type EffectiveAccessView
} from "@planweave-ai/collaboration-protocol/access/control";
import {
  humanPrincipalIdSchema,
  type ActorRef
} from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  membershipGrantSchema,
  projectAccessDecisionSchema,
  type MembershipGrant,
  type ProjectAccessDecision,
  type ProjectAccessRecord,
  type CanvasAccessRecord
} from "@planweave-ai/collaboration-protocol/access/project";
import { workspaceCanvasPublishLocalSourceSchema } from "@planweave-ai/collaboration-protocol/content/version";
import { HumanPrincipalIdentity, sqlPlaceholders } from "./identity/humanPrincipalIdentity.js";
import type { SqliteDatabase } from "./sqlite.js";
import {
  activeWorkspacePrincipal,
  canvasAccessRecord,
  type InternalCanvasRecord,
  type InternalProjectRecord,
  projectAccessRecord,
  ProjectRegistryRepository
} from "./projectRegistryRepository.js";
import { z } from "zod";

const pageLimitSchema = z.number().int().min(1).max(100);
const pageOffsetSchema = z.number().int().nonnegative();

function decision(decisionInput: ProjectAccessDecision): ProjectAccessDecision {
  return projectAccessDecisionSchema.parse(decisionInput);
}

function latestProjectGrant(
  database: SqliteDatabase,
  project: InternalProjectRecord,
  principalId: string
): Record<string, unknown> | undefined {
  const ids = new HumanPrincipalIdentity(database).equivalentIds(principalId);
  return database
    .prepare(
      `SELECT * FROM project_access_grants WHERE workspace_id=? AND project_registry_id=? AND scope_kind='project' AND human_principal_id IN (${sqlPlaceholders(ids)}) ORDER BY acl_revision DESC LIMIT 1`
    )
    .get(project.workspaceId, project.projectRegistryId, ...ids);
}

function latestCanvasGrant(
  database: SqliteDatabase,
  canvas: InternalCanvasRecord,
  principalId: string
): Record<string, unknown> | undefined {
  const ids = new HumanPrincipalIdentity(database).equivalentIds(principalId);
  return database
    .prepare(
      `SELECT * FROM project_access_grants WHERE workspace_id=? AND canvas_registry_id=? AND scope_kind='canvas' AND human_principal_id IN (${sqlPlaceholders(ids)}) ORDER BY acl_revision DESC LIMIT 1`
    )
    .get(canvas.workspaceId, canvas.canvasRegistryId, ...ids);
}

function grantFromRow(row: Record<string, unknown> | undefined): MembershipGrant | null {
  if (!row) return null;
  return membershipGrantSchema.parse({
    schemaVersion: "project-access/v1",
    grantId: String(row.grant_id),
    workspaceId: String(row.workspace_id),
    projectId: String(row.project_id),
    humanPrincipalId: String(row.human_principal_id),
    role: row.role === "editor" ? "editor" : row.role === "viewer" ? "viewer" : "owner",
    aclRevision: Number(row.acl_revision),
    grantedBy: { kind: row.granted_by_kind, id: String(row.granted_by_id) },
    grantedAt: String(row.granted_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
    scopeKind: row.scope_kind === "canvas" ? "canvas" : "project",
    canvasId: row.scope_kind === "canvas" ? String(row.canvas_id) : null
  });
}

function legacyDeniedReason(reason: AccessDisabledReason): "missing" | "revoked" {
  return reason === "membership_revoked" ||
    reason === "session_revoked" ||
    reason === "grant_revoked"
    ? "revoked"
    : "missing";
}

/** ACL decisions are evaluated before the registry exposes any internal path. */
export class ProjectAccessPolicy {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly registry: ProjectRegistryRepository
  ) {}

  evaluate(input: {
    workspaceId: string;
    projectId: string;
    canvasId?: string;
    actor: ActorRef;
    /** Authentication callers have already resolved a live human device session. */
    session?: "active" | "missing" | "expired" | "revoked";
  }): EffectiveAccessView {
    const project = this.registry.projectInternal(input.workspaceId, input.projectId);
    const canvas =
      input.canvasId === undefined
        ? undefined
        : this.registry.canvasInternal(input.workspaceId, input.projectId, input.canvasId);
    if (
      !project ||
      project.revokedAt !== null ||
      (input.canvasId !== undefined && (!canvas || canvas.revokedAt !== null))
    ) {
      throw new Error("access_scope_not_found");
    }
    if (!project.ownerHumanPrincipalId || (canvas && !canvas.ownerHumanPrincipalId)) {
      throw new Error("access_scope_owner_missing");
    }
    const humanPrincipalId = humanPrincipalIdSchema.parse(
      input.actor.kind === "human" ? input.actor.id : "non-human"
    );
    const membership =
      input.actor.kind === "human" &&
      activeWorkspacePrincipal(this.database, input.workspaceId, humanPrincipalId)
        ? "active"
        : "missing";
    return evaluateEffectiveAccess({
      scope: accessScopeSchema.parse(
        input.canvasId === undefined
          ? {
              scopeKind: "project",
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              canvasId: null
            }
          : {
              scopeKind: "canvas",
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              canvasId: input.canvasId
            }
      ),
      humanPrincipalId,
      membership,
      session: input.session ?? "active",
      project: projectAccessRecord(project),
      canvas: canvas ? canvasAccessRecord(canvas) : null,
      projectGrant: grantFromRow(latestProjectGrant(this.database, project, humanPrincipalId)),
      canvasGrant: canvas
        ? grantFromRow(latestCanvasGrant(this.database, canvas, humanPrincipalId))
        : null
    });
  }

  assertCapability(input: {
    workspaceId: string;
    projectId: string;
    canvasId?: string;
    actor: ActorRef;
    capability: AccessCapability;
    session?: "active" | "missing" | "expired" | "revoked";
    bootstrap?: boolean;
  }): EffectiveAccessView {
    if (input.actor.kind === "local_admin") {
      if (input.bootstrap === true)
        return this.evaluate({ ...input, actor: { kind: "human", id: "bootstrap" } });
      throw new Error("local_admin_bootstrap_only");
    }
    const access = this.evaluate(input);
    if (!access.capabilities[input.capability]) {
      throw new Error(`access_capability_denied:${access.disabledReason ?? "capability_denied"}`);
    }
    return access;
  }

  decideProject(input: {
    workspaceId: string;
    projectId: string;
    actor: ActorRef;
  }): ProjectAccessDecision {
    try {
      const access = this.evaluate(input);
      return access.capabilities.read
        ? decision({ decision: "allow", aclRevision: access.aclRevision })
        : decision({
            decision: "deny",
            reason: legacyDeniedReason(access.disabledReason ?? "capability_denied"),
            aclRevision: access.aclRevision
          });
    } catch {
      return decision({ decision: "deny", reason: "missing", aclRevision: 0 });
    }
  }

  decideCanvas(input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    actor: ActorRef;
  }): ProjectAccessDecision {
    try {
      const access = this.evaluate(input);
      return access.capabilities.read
        ? decision({ decision: "allow", aclRevision: access.aclRevision })
        : decision({
            decision: "deny",
            reason: legacyDeniedReason(access.disabledReason ?? "capability_denied"),
            aclRevision: access.aclRevision
          });
    } catch {
      return decision({ decision: "deny", reason: "missing", aclRevision: 0 });
    }
  }

  listProjects(input: {
    workspaceId: string;
    actor: ActorRef;
    limit?: number;
    offset?: number;
  }): ProjectAccessRecord[] {
    const limit = pageLimitSchema.parse(input.limit ?? 100);
    const offset = pageOffsetSchema.parse(input.offset ?? 0);
    if (input.actor.kind !== "human") return [];
    const ids = new HumanPrincipalIdentity(this.database).equivalentIds(input.actor.id);
    const inSql = sqlPlaceholders(ids);
    const rows = this.database
      .prepare(`
      SELECT p.*
      FROM project_registry p
      WHERE p.workspace_id=?
        AND p.revoked_at IS NULL
        AND p.owner_human_principal_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM workspace_principals wp
          JOIN workspace_memberships wm
            ON wm.workspace_id=wp.workspace_id
           AND wm.human_principal_id=wp.human_principal_id
          WHERE wp.workspace_id=p.workspace_id
            AND wp.human_principal_id IN (${inSql})
            AND wp.revoked_at IS NULL
            AND wm.revoked_at IS NULL
        )
        AND (
          p.owner_human_principal_id IN (${inSql})
          OR p.visibility='shared'
          OR EXISTS (
            SELECT 1 FROM project_access_grants g
            WHERE g.workspace_id=p.workspace_id
              AND g.project_registry_id=p.project_registry_id
              AND g.scope_kind='project'
              AND g.human_principal_id IN (${inSql})
              AND g.revoked_at IS NULL
          )
          OR EXISTS (
            SELECT 1 FROM canvas_registry c
            WHERE c.workspace_id=p.workspace_id
              AND c.project_registry_id=p.project_registry_id
              AND c.revoked_at IS NULL
              AND (
                c.owner_human_principal_id IN (${inSql})
                OR c.visibility='shared'
                OR EXISTS (
                  SELECT 1 FROM project_access_grants g
                  WHERE g.workspace_id=c.workspace_id
                    AND g.canvas_registry_id=c.canvas_registry_id
                    AND g.scope_kind='canvas'
                    AND g.human_principal_id IN (${inSql})
                    AND g.revoked_at IS NULL
                )
              )
          )
        )
      ORDER BY p.project_registry_id
      LIMIT ? OFFSET ?
    `)
      .all(input.workspaceId, ...ids, ...ids, ...ids, ...ids, ...ids, limit, offset) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => projectAccessRecord(rowToProject(row)));
  }

  listCanvases(input: {
    workspaceId: string;
    projectId: string;
    actor: ActorRef;
    limit?: number;
    offset?: number;
  }): CanvasAccessRecord[] {
    const limit = pageLimitSchema.parse(input.limit ?? 100);
    const offset = pageOffsetSchema.parse(input.offset ?? 0);
    if (input.actor.kind !== "human") return [];
    const ids = new HumanPrincipalIdentity(this.database).equivalentIds(input.actor.id);
    const inSql = sqlPlaceholders(ids);
    const rows = this.database
      .prepare(`
      SELECT c.*,
             publish.local_project_id AS publish_local_project_id,
             publish.local_canvas_id AS publish_local_canvas_id
      FROM canvas_registry c
      JOIN project_registry p
        ON p.workspace_id=c.workspace_id
       AND p.project_id=c.project_id
       AND p.project_registry_id=c.project_registry_id
      LEFT JOIN canvas_workspace_publish_operations publish
        ON publish.workspace_id=c.workspace_id
       AND publish.project_id=c.project_id
       AND publish.canvas_id=c.canvas_id
      WHERE c.workspace_id=?
        AND c.project_id=?
        AND c.revoked_at IS NULL
        AND p.revoked_at IS NULL
        AND c.owner_human_principal_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM workspace_principals wp
          JOIN workspace_memberships wm
            ON wm.workspace_id=wp.workspace_id
           AND wm.human_principal_id=wp.human_principal_id
          WHERE wp.workspace_id=c.workspace_id
            AND wp.human_principal_id IN (${inSql})
            AND wp.revoked_at IS NULL
            AND wm.revoked_at IS NULL
        )
        AND (
          c.owner_human_principal_id IN (${inSql})
          OR c.visibility='shared'
          OR EXISTS (
            SELECT 1 FROM project_access_grants g
            WHERE g.workspace_id=c.workspace_id
              AND g.canvas_registry_id=c.canvas_registry_id
              AND g.scope_kind='canvas'
              AND g.human_principal_id IN (${inSql})
              AND g.revoked_at IS NULL
          )
          OR EXISTS (
            SELECT 1 FROM project_access_grants g
            WHERE g.workspace_id=c.workspace_id
              AND g.project_registry_id=p.project_registry_id
              AND g.scope_kind='project'
              AND g.human_principal_id IN (${inSql})
              AND g.revoked_at IS NULL
          )
        )
      ORDER BY c.canvas_registry_id
      LIMIT ? OFFSET ?
    `)
      .all(
        input.workspaceId,
        input.projectId,
        ...ids,
        ...ids,
        ...ids,
        ...ids,
        limit,
        offset
      ) as Array<Record<string, unknown>>;
    return rows.map((row) =>
      canvasAccessRecord(
        rowToCanvas(row),
        row.publish_local_project_id === null && row.publish_local_canvas_id === null
          ? null
          : workspaceCanvasPublishLocalSourceSchema.parse({
              localProjectId: row.publish_local_project_id,
              localCanvasId: row.publish_local_canvas_id
            })
      )
    );
  }

  assertCanManage(input: {
    workspaceId: string;
    projectId: string;
    canvasId?: string;
    actor: ActorRef;
    bootstrap?: boolean;
  }): void {
    this.assertCapability({ ...input, capability: "administration" });
  }
}

function rowToProject(row: Record<string, unknown>): InternalProjectRecord {
  return {
    projectRegistryId: String(row.project_registry_id),
    workspaceId: String(row.workspace_id),
    projectId: String(row.project_id),
    projectRoot: row.project_root_internal === null ? null : String(row.project_root_internal),
    visibility: row.visibility as InternalProjectRecord["visibility"],
    ownerHumanPrincipalId:
      row.owner_human_principal_id === null ? null : String(row.owner_human_principal_id),
    aclRevision: Number(row.acl_revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at)
  };
}

function rowToCanvas(row: Record<string, unknown>): InternalCanvasRecord {
  return {
    canvasRegistryId: String(row.canvas_registry_id),
    projectRegistryId: String(row.project_registry_id),
    workspaceId: String(row.workspace_id),
    projectId: String(row.project_id),
    canvasId: String(row.canvas_id),
    packageDir: row.package_dir_internal === null ? null : String(row.package_dir_internal),
    visibility: row.visibility as InternalCanvasRecord["visibility"],
    ownerHumanPrincipalId:
      row.owner_human_principal_id === null ? null : String(row.owner_human_principal_id),
    aclRevision: Number(row.acl_revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at)
  };
}
