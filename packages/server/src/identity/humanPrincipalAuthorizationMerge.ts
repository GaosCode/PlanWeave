import type { SqliteDatabase } from "../sqlite.js";
import { HumanPrincipalIdentity, sqlPlaceholders } from "./humanPrincipalIdentity.js";

/**
 * Same-Workspace merge inheritance:
 * - Membership role: owner beats member. One active membership on canonical.
 * - ACL grants: keep the more permissive role (owner > editor > viewer);
 *   equal roles keep the higher acl_revision.
 * - Project/Canvas owner rows rewrite onto canonical.
 * - Work assignment, Responsibility, and Reviewer current-auth targets rewrite
 *   onto canonical. Authority revisions increment so clients refetch.
 * Alias principals and duplicate memberships/grants are revoked, not deleted.
 */
const GRANT_RANK: Record<string, number> = {
  owner: 3,
  editor: 2,
  viewer: 1
};

type MembershipRow = {
  workspace_id: string;
  membership_id: string;
  human_principal_id: string;
  role: "owner" | "member";
};

type GrantRow = {
  grant_id: string;
  workspace_id: string;
  scope_kind: "project" | "canvas";
  project_registry_id: string | null;
  canvas_registry_id: string | null;
  human_principal_id: string;
  role: string;
  acl_revision: number;
};

export function consolidateCanonicalAuthorization(
  database: SqliteDatabase,
  targetCanonical: string,
  nowIso: string
): void {
  const identity = new HumanPrincipalIdentity(database);
  const ids = identity.equivalentIds(targetCanonical);
  const others = ids.filter((id) => id !== targetCanonical);
  if (others.length === 0) return;
  const inSql = sqlPlaceholders(ids);

  ensureCanonicalPrincipals(database, ids, targetCanonical, nowIso);
  rewriteDeviceSessions(database, ids, targetCanonical);
  rewriteLegacyDeviceCredentials(database, ids, targetCanonical);
  consolidateMemberships(database, ids, inSql, targetCanonical, nowIso);
  consolidateLegacyProjectMemberships(database, ids, inSql, targetCanonical, nowIso);
  rewriteOwners(database, ids, targetCanonical, nowIso);
  consolidateGrants(database, ids, inSql, targetCanonical, nowIso);
  rewriteRemoteAgentOwners(database, ids, targetCanonical, nowIso);
  rewriteWorkAssignmentTargets(database, ids, targetCanonical);
  rewriteAuthorityPrincipals(database, "responsibility_records", ids, targetCanonical, nowIso);
  rewriteAuthorityPrincipals(database, "review_assignment_records", ids, targetCanonical, nowIso);
  revokeAliasPrincipals(database, others, nowIso);
}

function ensureCanonicalPrincipals(
  database: SqliteDatabase,
  ids: readonly string[],
  targetCanonical: string,
  nowIso: string
): void {
  const inSql = sqlPlaceholders(ids);
  const rows = database
    .prepare(
      `SELECT workspace_id, human_principal_id, display_name, revoked_at
       FROM workspace_principals WHERE human_principal_id IN (${inSql})`
    )
    .all(...ids) as Array<{
    workspace_id: string;
    human_principal_id: string;
    display_name: string;
    revoked_at: string | null;
  }>;
  const byWorkspace = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byWorkspace.get(row.workspace_id) ?? [];
    list.push(row);
    byWorkspace.set(row.workspace_id, list);
  }
  for (const [workspaceId, principals] of byWorkspace) {
    const canonical = principals.find((row) => row.human_principal_id === targetCanonical);
    const donor =
      principals.find((row) => row.human_principal_id !== targetCanonical) ?? principals[0];
    if (!donor) continue;
    if (!canonical) {
      database
        .prepare(
          `INSERT INTO workspace_principals(
            workspace_id,human_principal_id,display_name,created_at,revoked_at
          ) VALUES(?,?,?,?,NULL)`
        )
        .run(workspaceId, targetCanonical, donor.display_name, nowIso);
    } else if (canonical.revoked_at !== null) {
      database
        .prepare(
          `UPDATE workspace_principals SET revoked_at=NULL
           WHERE workspace_id=? AND human_principal_id=?`
        )
        .run(workspaceId, targetCanonical);
    }
  }
}

function rewriteDeviceSessions(
  database: SqliteDatabase,
  ids: readonly string[],
  targetCanonical: string
): void {
  const others = ids.filter((id) => id !== targetCanonical);
  if (others.length === 0) return;
  database
    .prepare(
      `UPDATE workspace_device_sessions
       SET human_principal_id=?
       WHERE human_principal_id IN (${sqlPlaceholders(others)})`
    )
    .run(targetCanonical, ...others);
}

function rewriteLegacyDeviceCredentials(
  database: SqliteDatabase,
  ids: readonly string[],
  targetCanonical: string
): void {
  const others = ids.filter((id) => id !== targetCanonical);
  if (others.length === 0) return;
  database
    .prepare(
      `UPDATE human_device_credentials
       SET human_principal_id=?
       WHERE human_principal_id IN (${sqlPlaceholders(others)})`
    )
    .run(targetCanonical, ...others);
}

function consolidateMemberships(
  database: SqliteDatabase,
  ids: readonly string[],
  inSql: string,
  targetCanonical: string,
  nowIso: string
): void {
  const rows = database
    .prepare(
      `SELECT workspace_id, membership_id, human_principal_id, role
       FROM workspace_memberships
       WHERE human_principal_id IN (${inSql}) AND revoked_at IS NULL`
    )
    .all(...ids) as MembershipRow[];
  const byWorkspace = new Map<string, MembershipRow[]>();
  for (const row of rows) {
    const list = byWorkspace.get(row.workspace_id) ?? [];
    list.push(row);
    byWorkspace.set(row.workspace_id, list);
  }
  for (const [workspaceId, memberships] of byWorkspace) {
    const keptRole = memberships.some((row) => row.role === "owner") ? "owner" : "member";
    const canonicalRow = memberships.find((row) => row.human_principal_id === targetCanonical);
    if (canonicalRow) {
      if (canonicalRow.role !== keptRole) {
        database
          .prepare(
            `UPDATE workspace_memberships
             SET role=?, updated_at=?, revision=revision+1
             WHERE workspace_id=? AND membership_id=? AND revoked_at IS NULL`
          )
          .run(keptRole, nowIso, workspaceId, canonicalRow.membership_id);
      }
      for (const row of memberships) {
        if (row.membership_id === canonicalRow.membership_id) continue;
        database
          .prepare(
            `UPDATE workspace_memberships
             SET revoked_at=?, updated_at=?, revision=revision+1
             WHERE workspace_id=? AND membership_id=? AND revoked_at IS NULL`
          )
          .run(nowIso, nowIso, workspaceId, row.membership_id);
      }
      continue;
    }
    const donor = memberships.find((row) => row.role === keptRole) ?? memberships[0];
    if (!donor) continue;
    database
      .prepare(
        `UPDATE workspace_memberships
         SET human_principal_id=?, role=?, updated_at=?, revision=revision+1
         WHERE workspace_id=? AND membership_id=? AND revoked_at IS NULL`
      )
      .run(targetCanonical, keptRole, nowIso, workspaceId, donor.membership_id);
    for (const row of memberships) {
      if (row.membership_id === donor.membership_id) continue;
      database
        .prepare(
          `UPDATE workspace_memberships
           SET revoked_at=?, updated_at=?, revision=revision+1
           WHERE workspace_id=? AND membership_id=? AND revoked_at IS NULL`
        )
        .run(nowIso, nowIso, workspaceId, row.membership_id);
    }
  }
}

function consolidateLegacyProjectMemberships(
  database: SqliteDatabase,
  ids: readonly string[],
  inSql: string,
  targetCanonical: string,
  nowIso: string
): void {
  const rows = database
    .prepare(
      `SELECT membership_id, project_id, human_principal_id, role
       FROM project_memberships
       WHERE human_principal_id IN (${inSql}) AND revoked_at IS NULL`
    )
    .all(...ids) as Array<{
    membership_id: string;
    project_id: string;
    human_principal_id: string;
    role: "owner" | "member";
  }>;
  const byProject = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byProject.get(row.project_id) ?? [];
    list.push(row);
    byProject.set(row.project_id, list);
  }
  for (const memberships of byProject.values()) {
    const keptRole = memberships.some((row) => row.role === "owner") ? "owner" : "member";
    const canonicalRow = memberships.find((row) => row.human_principal_id === targetCanonical);
    if (canonicalRow) {
      if (canonicalRow.role !== keptRole) {
        database
          .prepare(
            `UPDATE project_memberships
             SET role=?, updated_at=?, revision=revision+1
             WHERE membership_id=? AND revoked_at IS NULL`
          )
          .run(keptRole, nowIso, canonicalRow.membership_id);
      }
      for (const row of memberships) {
        if (row.membership_id === canonicalRow.membership_id) continue;
        database
          .prepare(
            `UPDATE project_memberships
             SET revoked_at=?, updated_at=?, revision=revision+1
             WHERE membership_id=? AND revoked_at IS NULL`
          )
          .run(nowIso, nowIso, row.membership_id);
      }
      continue;
    }
    const donor = memberships.find((row) => row.role === keptRole) ?? memberships[0];
    if (!donor) continue;
    database
      .prepare(
        `UPDATE project_memberships
         SET human_principal_id=?, role=?, updated_at=?, revision=revision+1
         WHERE membership_id=? AND revoked_at IS NULL`
      )
      .run(targetCanonical, keptRole, nowIso, donor.membership_id);
    for (const row of memberships) {
      if (row.membership_id === donor.membership_id) continue;
      database
        .prepare(
          `UPDATE project_memberships
           SET revoked_at=?, updated_at=?, revision=revision+1
           WHERE membership_id=? AND revoked_at IS NULL`
        )
        .run(nowIso, nowIso, row.membership_id);
    }
  }
}

function rewriteOwners(
  database: SqliteDatabase,
  ids: readonly string[],
  targetCanonical: string,
  nowIso: string
): void {
  const others = ids.filter((id) => id !== targetCanonical);
  if (others.length === 0) return;
  const otherSql = sqlPlaceholders(others);
  database
    .prepare(
      `UPDATE project_registry SET owner_human_principal_id=?, updated_at=?
       WHERE owner_human_principal_id IN (${otherSql})`
    )
    .run(targetCanonical, nowIso, ...others);
  database
    .prepare(
      `UPDATE canvas_registry SET owner_human_principal_id=?, updated_at=?
       WHERE owner_human_principal_id IN (${otherSql})`
    )
    .run(targetCanonical, nowIso, ...others);
}

function consolidateGrants(
  database: SqliteDatabase,
  ids: readonly string[],
  inSql: string,
  targetCanonical: string,
  nowIso: string
): void {
  const rows = database
    .prepare(
      `SELECT grant_id, workspace_id, scope_kind, project_registry_id, canvas_registry_id,
              human_principal_id, role, acl_revision
       FROM project_access_grants
       WHERE human_principal_id IN (${inSql}) AND revoked_at IS NULL`
    )
    .all(...ids) as GrantRow[];
  const groups = new Map<string, GrantRow[]>();
  for (const row of rows) {
    const key =
      row.scope_kind === "canvas"
        ? `${row.workspace_id}\0canvas\0${row.canvas_registry_id}`
        : `${row.workspace_id}\0project\0${row.project_registry_id}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  for (const grants of groups.values()) {
    const kept = grants.reduce((best, row) => (grantBetter(row, best) ? row : best));
    const canonicalGrant = grants.find((row) => row.human_principal_id === targetCanonical);
    if (canonicalGrant && canonicalGrant.grant_id === kept.grant_id) {
      revokeOtherGrants(database, grants, canonicalGrant.grant_id, nowIso);
      continue;
    }
    if (canonicalGrant) {
      if (grantBetter(kept, canonicalGrant)) {
        database
          .prepare(
            `UPDATE project_access_grants SET role=?, acl_revision=?, revoked_at=NULL
             WHERE grant_id=?`
          )
          .run(
            kept.role,
            Math.max(kept.acl_revision, canonicalGrant.acl_revision),
            canonicalGrant.grant_id
          );
      }
      revokeOtherGrants(database, grants, canonicalGrant.grant_id, nowIso);
      continue;
    }
    database
      .prepare(`UPDATE project_access_grants SET human_principal_id=? WHERE grant_id=?`)
      .run(targetCanonical, kept.grant_id);
    revokeOtherGrants(database, grants, kept.grant_id, nowIso);
  }
}

function grantBetter(left: GrantRow, right: GrantRow): boolean {
  const leftRank = GRANT_RANK[left.role] ?? 0;
  const rightRank = GRANT_RANK[right.role] ?? 0;
  if (leftRank !== rightRank) return leftRank > rightRank;
  return left.acl_revision > right.acl_revision;
}

function revokeOtherGrants(
  database: SqliteDatabase,
  grants: readonly GrantRow[],
  keepGrantId: string,
  nowIso: string
): void {
  for (const row of grants) {
    if (row.grant_id === keepGrantId) continue;
    database
      .prepare(
        `UPDATE project_access_grants SET revoked_at=? WHERE grant_id=? AND revoked_at IS NULL`
      )
      .run(nowIso, row.grant_id);
  }
}

function rewriteRemoteAgentOwners(
  database: SqliteDatabase,
  ids: readonly string[],
  targetCanonical: string,
  nowIso: string
): void {
  const others = ids.filter((id) => id !== targetCanonical);
  if (others.length === 0) return;
  database
    .prepare(
      `UPDATE remote_agents SET owner_human_principal_id=?, updated_at=?
       WHERE owner_human_principal_id IN (${sqlPlaceholders(others)})`
    )
    .run(targetCanonical, nowIso, ...others);
}

function rewriteWorkAssignmentTargets(
  database: SqliteDatabase,
  ids: readonly string[],
  targetCanonical: string
): void {
  const others = ids.filter((id) => id !== targetCanonical);
  if (others.length === 0) return;
  database
    .prepare(
      `UPDATE work_assignments SET target_human_principal_id=?
       WHERE target_kind='human' AND target_human_principal_id IN (${sqlPlaceholders(others)})`
    )
    .run(targetCanonical, ...others);
}

function rewriteAuthorityPrincipals(
  database: SqliteDatabase,
  table: "responsibility_records" | "review_assignment_records",
  ids: readonly string[],
  targetCanonical: string,
  nowIso: string
): void {
  const others = ids.filter((id) => id !== targetCanonical);
  if (others.length === 0) return;
  database
    .prepare(
      `UPDATE ${table}
       SET principal_id=?, revision=revision+1, updated_at=?
       WHERE principal_id IN (${sqlPlaceholders(others)})`
    )
    .run(targetCanonical, nowIso, ...others);
}

function revokeAliasPrincipals(
  database: SqliteDatabase,
  others: readonly string[],
  nowIso: string
): void {
  if (others.length === 0) return;
  database
    .prepare(
      `UPDATE workspace_principals SET revoked_at=?
       WHERE human_principal_id IN (${sqlPlaceholders(others)}) AND revoked_at IS NULL`
    )
    .run(nowIso, ...others);
}
