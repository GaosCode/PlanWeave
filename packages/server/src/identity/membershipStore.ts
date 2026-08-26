import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../sqlite.js";
import { HumanIdentityError, isHumanIdentityUniqueViolation } from "./errors.js";
import { HumanPrincipalIdentity, sqlPlaceholders } from "./humanPrincipalIdentity.js";
import {
  humanDisplayNameSchema,
  humanPrincipalIdSchema,
  humanPrincipalSchema,
  humanProjectIdSchema,
  projectMembershipIdSchema,
  projectMembershipSchema,
  type HumanPrincipal,
  type ProjectMemberRole,
  type ProjectMembership
} from "./schemas.js";

type PrincipalRow = {
  human_principal_id: string;
  display_name: string;
  created_at: string;
};

type MembershipRow = {
  membership_id: string;
  project_id: string;
  human_principal_id: string;
  role: string;
  revision: number;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};

function toPrincipal(row: PrincipalRow): HumanPrincipal {
  return humanPrincipalSchema.parse({
    humanPrincipalId: row.human_principal_id,
    displayName: row.display_name,
    createdAt: row.created_at
  });
}

function toProjectMembership(row: MembershipRow): ProjectMembership {
  return projectMembershipSchema.parse({
    membershipId: row.membership_id,
    projectId: row.project_id,
    humanPrincipalId: row.human_principal_id,
    role: row.role,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at ?? undefined
  });
}

export class MembershipStore {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date
  ) {}

  getPrincipal(humanPrincipalId: string): HumanPrincipal | undefined {
    const id = humanPrincipalIdSchema.parse(humanPrincipalId);
    const row = this.database
      .prepare("SELECT * FROM human_principals WHERE human_principal_id=?")
      .get(id) as PrincipalRow | undefined;
    return row ? toPrincipal(row) : undefined;
  }

  getMembership(membershipId: string): ProjectMembership | undefined {
    const id = projectMembershipIdSchema.parse(membershipId);
    const row = this.database
      .prepare("SELECT * FROM project_memberships WHERE membership_id=?")
      .get(id) as MembershipRow | undefined;
    return row ? toProjectMembership(row) : undefined;
  }

  getActiveMembership(projectId: string, humanPrincipalId: string): ProjectMembership | undefined {
    const pid = humanProjectIdSchema.parse(projectId);
    const hid = humanPrincipalIdSchema.parse(humanPrincipalId);
    const ids = new HumanPrincipalIdentity(this.database).equivalentIds(hid);
    const rows = this.database
      .prepare(
        `SELECT * FROM project_memberships
         WHERE project_id=? AND human_principal_id IN (${sqlPlaceholders(ids)}) AND revoked_at IS NULL`
      )
      .all(pid, ...ids) as MembershipRow[];
    const canonical = new HumanPrincipalIdentity(this.database).resolveCanonical(hid);
    const row =
      rows.find((candidate) => candidate.human_principal_id === canonical) ??
      rows.find((candidate) => candidate.role === "owner") ??
      rows[0];
    return row ? toProjectMembership(row) : undefined;
  }

  countActiveOwners(projectId: string): number {
    const pid = humanProjectIdSchema.parse(projectId);
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM project_memberships
         WHERE project_id=? AND role='owner' AND revoked_at IS NULL`
      )
      .get(pid) as { count: number };
    return Number(row.count);
  }

  countActiveMembers(projectId: string): number {
    const pid = humanProjectIdSchema.parse(projectId);
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM project_memberships
         WHERE project_id=? AND revoked_at IS NULL`
      )
      .get(pid) as { count: number };
    return Number(row.count);
  }

  listActiveMembers(projectId: string, limit = 100, offset = 0): ProjectMembership[] {
    const pid = humanProjectIdSchema.parse(projectId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new HumanIdentityError("human_input_invalid");
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new HumanIdentityError("human_input_invalid");
    }
    return (
      this.database
        .prepare(
          `SELECT * FROM project_memberships
           WHERE project_id=? AND revoked_at IS NULL
           ORDER BY created_at ASC, membership_id ASC
           LIMIT ? OFFSET ?`
        )
        .all(pid, limit, offset) as MembershipRow[]
    ).map(toProjectMembership);
  }

  listActiveOwners(projectId: string): ProjectMembership[] {
    const pid = humanProjectIdSchema.parse(projectId);
    return (
      this.database
        .prepare(
          `SELECT * FROM project_memberships
           WHERE project_id=? AND role='owner' AND revoked_at IS NULL
           ORDER BY created_at ASC, membership_id ASC`
        )
        .all(pid) as MembershipRow[]
    ).map(toProjectMembership);
  }

  insertPrincipal(humanPrincipalId: string, displayName: string): HumanPrincipal {
    const id = humanPrincipalIdSchema.parse(humanPrincipalId);
    const name = humanDisplayNameSchema.parse(displayName);
    const createdAt = this.clock().toISOString();
    try {
      this.database
        .prepare(
          `INSERT INTO human_principals(human_principal_id,display_name,created_at)
           VALUES (?,?,?)`
        )
        .run(id, name, createdAt);
    } catch (error) {
      if (isHumanIdentityUniqueViolation(error)) {
        const existing = this.getPrincipal(id);
        if (existing) return existing;
        throw new HumanIdentityError("human_input_invalid");
      }
      throw error;
    }
    return this.getPrincipal(id)!;
  }

  updatePrincipalDisplayName(humanPrincipalId: string, displayName: string): HumanPrincipal {
    const id = humanPrincipalIdSchema.parse(humanPrincipalId);
    const name = humanDisplayNameSchema.parse(displayName);
    const updated = this.database
      .prepare("UPDATE human_principals SET display_name=? WHERE human_principal_id=?")
      .run(name, id);
    if (updated.changes !== 1) throw new HumanIdentityError("human_input_invalid");
    return this.getPrincipal(id)!;
  }

  insertMembership(input: {
    projectId: string;
    humanPrincipalId: string;
    role: ProjectMemberRole;
  }): ProjectMembership {
    const membershipId = projectMembershipIdSchema.parse(randomUUID());
    const now = this.clock().toISOString();
    try {
      this.database
        .prepare(
          `INSERT INTO project_memberships(
            membership_id,project_id,human_principal_id,role,revision,created_at,updated_at
          ) VALUES (?,?,?,?,1,?,?)`
        )
        .run(membershipId, input.projectId, input.humanPrincipalId, input.role, now, now);
    } catch (error) {
      if (isHumanIdentityUniqueViolation(error)) {
        throw new HumanIdentityError("human_input_invalid", "Active membership already exists.");
      }
      throw error;
    }
    return this.getMembership(membershipId)!;
  }

  removeMember(
    projectId: string,
    targetHumanPrincipalId: string
  ): {
    membership: ProjectMembership;
    revokedAt: string;
  } {
    const pid = humanProjectIdSchema.parse(projectId);
    const target = humanPrincipalIdSchema.parse(targetHumanPrincipalId);
    const membership = this.getActiveMembership(pid, target);
    if (!membership) throw new HumanIdentityError("human_membership_required");
    if (membership.role === "owner" && this.countActiveOwners(pid) <= 1) {
      throw new HumanIdentityError("human_last_owner_protected");
    }

    const revokedAt = this.clock().toISOString();
    const updated = this.database
      .prepare(
        `UPDATE project_memberships SET revoked_at=?, updated_at=?, revision=revision+1
         WHERE membership_id=? AND revoked_at IS NULL`
      )
      .run(revokedAt, revokedAt, membership.membershipId);
    if (updated.changes !== 1) throw new HumanIdentityError("human_membership_required");
    return { membership: this.getMembership(membership.membershipId)!, revokedAt };
  }

  promoteToOwner(projectId: string, targetHumanPrincipalId: string): ProjectMembership {
    const pid = humanProjectIdSchema.parse(projectId);
    const target = humanPrincipalIdSchema.parse(targetHumanPrincipalId);
    const membership = this.getActiveMembership(pid, target);
    if (!membership) throw new HumanIdentityError("human_membership_required");
    if (membership.role === "owner") return membership;
    const updated = this.database
      .prepare(
        `UPDATE project_memberships SET role='owner', updated_at=?, revision=revision+1
         WHERE membership_id=? AND revoked_at IS NULL AND role='member'`
      )
      .run(this.clock().toISOString(), membership.membershipId);
    if (updated.changes !== 1) throw new HumanIdentityError("human_membership_required");
    return this.getMembership(membership.membershipId)!;
  }

  demoteOwner(projectId: string, targetHumanPrincipalId: string): ProjectMembership {
    const pid = humanProjectIdSchema.parse(projectId);
    const target = humanPrincipalIdSchema.parse(targetHumanPrincipalId);
    const membership = this.getActiveMembership(pid, target);
    if (!membership) throw new HumanIdentityError("human_membership_required");
    if (membership.role !== "owner") throw new HumanIdentityError("human_input_invalid");
    if (this.countActiveOwners(pid) <= 1) {
      throw new HumanIdentityError("human_last_owner_protected");
    }
    const updated = this.database
      .prepare(
        `UPDATE project_memberships SET role='member', updated_at=?, revision=revision+1
         WHERE membership_id=? AND revoked_at IS NULL AND role='owner'`
      )
      .run(this.clock().toISOString(), membership.membershipId);
    if (updated.changes !== 1) throw new HumanIdentityError("human_last_owner_protected");
    return this.getMembership(membership.membershipId)!;
  }
}
