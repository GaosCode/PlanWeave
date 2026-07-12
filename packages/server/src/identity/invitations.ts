import type { SqliteDatabase } from "../sqlite.js";
import { executeIdempotent, type IdempotentResult } from "../store.js";
import { notFound, stateConflict, validationFailed, forbidden } from "./errors.js";
import type { Invitation, Membership, Role } from "./types.js";
import { isRole } from "./types.js";

export type CreateInvitationInput = {
  deviceId: string;
  route: string;
  key: string;
  requestFingerprint: string;
  actorUserId: string;
  projectId: string;
  code: string;
  role: Role;
  expiresAt: string;
};

export function createInvitation(database: SqliteDatabase, input: CreateInvitationInput): IdempotentResult<{ invitation: Invitation }> {
  if (!isRole(input.role)) throw validationFailed("Role is invalid", { role: input.role });
  return executeIdempotent(database, {
    deviceId: input.deviceId,
    route: input.route,
    key: input.key,
    requestFingerprint: input.requestFingerprint,
    execute: (unit) => {
      const id = newId("inv");
      const now = new Date().toISOString();
      const existing = unit.database.prepare("SELECT id FROM invitations WHERE code=?").get(input.code);
      if (existing) throw stateConflict("Invitation code already exists", { code: input.code });
      unit.database.prepare("INSERT INTO invitations(id, project_id, code, role, expires_at, redeemed_by_user_id, redeemed_at, created_by_user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, input.projectId, input.code, input.role, input.expiresAt, null, null, input.actorUserId, now);
      const invitation: Invitation = { id, projectId: input.projectId, code: input.code, role: input.role, expiresAt: input.expiresAt, redeemedByUserId: null, redeemedAt: null, createdByUserId: input.actorUserId, createdAt: now };
      unit.audit({ projectId: input.projectId, actorId: input.actorUserId, action: "invitation.create", aggregateType: "invitation", aggregateId: id, details: { code: input.code, role: input.role } });
      unit.appendEvent({ projectId: input.projectId, aggregateType: "invitation", aggregateId: id, aggregateVersion: 1, type: "invitation.created" });
      return { invitation };
    }
  });
}

export type RedeemInvitationInput = {
  deviceId: string;
  route: string;
  key: string;
  requestFingerprint: string;
  userId: string;
  code: string;
};

export type RedeemInvitationResult = { invitation: Invitation; membership: Membership };

export function redeemInvitation(database: SqliteDatabase, input: RedeemInvitationInput): IdempotentResult<RedeemInvitationResult> {
  return executeIdempotent(database, {
    deviceId: input.deviceId,
    route: input.route,
    key: input.key,
    requestFingerprint: input.requestFingerprint,
    execute: (unit) => {
      const row = unit.database.prepare("SELECT id, project_id, code, role, expires_at, redeemed_by_user_id, redeemed_at, created_by_user_id, created_at FROM invitations WHERE code=?").get(input.code);
      if (!row) throw notFound("Invitation", input.code);
      const invitation = rowToInvitation(row);
      if (invitation.redeemedByUserId) throw stateConflict("Invitation has already been redeemed", { code: input.code, redeemedByUserId: invitation.redeemedByUserId });
      if (Date.parse(invitation.expiresAt) <= Date.now()) throw stateConflict("Invitation has expired", { code: input.code, expiresAt: invitation.expiresAt });
      const now = new Date().toISOString();
      unit.database.prepare("UPDATE invitations SET redeemed_by_user_id=?, redeemed_at=? WHERE id=?").run(input.userId, now, invitation.id);
      unit.database.prepare("INSERT OR REPLACE INTO memberships(project_id, user_id, role, created_at) VALUES (?,?,?,?)").run(invitation.projectId, input.userId, invitation.role, now);
      const membership: Membership = { projectId: invitation.projectId, userId: input.userId, role: invitation.role, createdAt: now };
      unit.audit({ projectId: invitation.projectId, actorId: input.userId, action: "invitation.redeem", aggregateType: "invitation", aggregateId: invitation.id, details: { code: input.code, role: invitation.role } });
      unit.appendEvent({ projectId: invitation.projectId, aggregateType: "invitation", aggregateId: invitation.id, aggregateVersion: 2, type: "invitation.redeemed" });
      unit.appendEvent({ projectId: invitation.projectId, aggregateType: "membership", aggregateId: input.userId, aggregateVersion: 1, type: "membership.added" });
      return { invitation: { ...invitation, redeemedByUserId: input.userId, redeemedAt: now }, membership };
    }
  });
}

export type AddMembershipInput = {
  deviceId: string;
  route: string;
  key: string;
  requestFingerprint: string;
  actorUserId: string;
  projectId: string;
  userId: string;
  role: Role;
};

export function addMembership(database: SqliteDatabase, input: AddMembershipInput): IdempotentResult<{ membership: Membership }> {
  if (!isRole(input.role)) throw validationFailed("Role is invalid", { role: input.role });
  return executeIdempotent(database, {
    deviceId: input.deviceId,
    route: input.route,
    key: input.key,
    requestFingerprint: input.requestFingerprint,
    execute: (unit) => {
      const project = unit.database.prepare("SELECT id FROM projects WHERE id=?").get(input.projectId);
      if (!project) throw notFound("Project", input.projectId);
      const now = new Date().toISOString();
      const existing = unit.database.prepare("SELECT role, created_at FROM memberships WHERE project_id=? AND user_id=?").get(input.projectId, input.userId);
      if (existing) {
        const role = String(existing.role);
        if (!isRole(role)) throw stateConflict("Existing membership role is invalid", { projectId: input.projectId, userId: input.userId, role });
        const membership: Membership = { projectId: input.projectId, userId: input.userId, role, createdAt: String(existing.created_at) };
        return { membership };
      }
      unit.database.prepare("INSERT INTO memberships(project_id, user_id, role, created_at) VALUES (?,?,?,?)").run(input.projectId, input.userId, input.role, now);
      const membership: Membership = { projectId: input.projectId, userId: input.userId, role: input.role, createdAt: now };
      unit.audit({ projectId: input.projectId, actorId: input.actorUserId, action: "membership.add", aggregateType: "membership", aggregateId: input.userId, details: { role: input.role } });
      unit.appendEvent({ projectId: input.projectId, aggregateType: "membership", aggregateId: input.userId, aggregateVersion: 1, type: "membership.added" });
      return { membership };
    }
  });
}

export function getInvitation(database: SqliteDatabase, code: string): Invitation {
  const row = database.prepare("SELECT id, project_id, code, role, expires_at, redeemed_by_user_id, redeemed_at, created_by_user_id, created_at FROM invitations WHERE code=?").get(code);
  if (!row) throw notFound("Invitation", code);
  return rowToInvitation(row);
}

export function requireMembership(database: SqliteDatabase, projectId: string, userId: string): Membership {
  const row = database.prepare("SELECT project_id, user_id, role, created_at FROM memberships WHERE project_id=? AND user_id=?").get(projectId, userId);
  if (!row) throw forbidden("User is not a member of the project", { projectId, userId });
  const role = String(row.role);
  if (!isRole(role)) throw stateConflict("Membership role is invalid", { projectId, userId, role });
  return { projectId: String(row.project_id), userId: String(row.user_id), role, createdAt: String(row.created_at) };
}

function rowToInvitation(row: Record<string, unknown>): Invitation {
  const role = String(row.role);
  if (!isRole(role)) throw stateConflict("Invitation role is invalid", { role });
  return { id: String(row.id), projectId: String(row.project_id), code: String(row.code), role, expiresAt: String(row.expires_at), redeemedByUserId: row.redeemed_by_user_id === null ? null : String(row.redeemed_by_user_id), redeemedAt: row.redeemed_at === null ? null : String(row.redeemed_at), createdByUserId: String(row.created_by_user_id), createdAt: String(row.created_at) };
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}
