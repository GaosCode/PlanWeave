import type { SqliteDatabase } from "../sqlite.js";
import { executeIdempotent, type IdempotentResult } from "../store.js";
import { notFound, stateConflict, unauthenticated, forbidden } from "./errors.js";
import { IDENTITY_SYSTEM_PROJECT_ID } from "./migrations.js";
import type { Device, Session, User } from "./types.js";

export type CreateSessionInput = {
  deviceId: string;
  route: string;
  key: string;
  requestFingerprint: string;
  userId: string;
  id?: string;
  deviceRefId: string;
  expiresAt: string;
};

export function createSession(database: SqliteDatabase, input: CreateSessionInput): IdempotentResult<{ session: Session }> {
  return executeIdempotent(database, {
    deviceId: input.deviceId,
    route: input.route,
    key: input.key,
    requestFingerprint: input.requestFingerprint,
    execute: (unit) => {
      const id = input.id ?? newId("session");
      const now = new Date().toISOString();
      const device = unit.database.prepare("SELECT id, user_id, status FROM devices WHERE id=?").get(input.deviceRefId);
      if (!device) throw notFound("Device", input.deviceRefId);
      if (device.user_id !== input.userId) throw stateConflict("Device does not belong to user", { deviceId: input.deviceRefId });
      if (device.status === "revoked") throw stateConflict("Device is revoked", { deviceId: input.deviceRefId });
      const existing = unit.database.prepare("SELECT id, user_id, device_id, issued_at, expires_at, revoked_at FROM sessions WHERE id=?").get(id);
      let session: Session;
      if (existing) {
        session = rowToSession(existing);
      } else {
        unit.database.prepare("INSERT INTO sessions(id, user_id, device_id, issued_at, expires_at, revoked_at) VALUES (?,?,?,?,?,?)").run(id, input.userId, input.deviceRefId, now, input.expiresAt, null);
        session = { id, userId: input.userId, deviceId: input.deviceRefId, issuedAt: now, expiresAt: input.expiresAt, revokedAt: null };
        unit.audit({ projectId: IDENTITY_SYSTEM_PROJECT_ID, actorId: input.userId, action: "session.create", aggregateType: "session", aggregateId: id, details: { deviceId: input.deviceRefId } });
        unit.appendEvent({ projectId: IDENTITY_SYSTEM_PROJECT_ID, aggregateType: "session", aggregateId: id, aggregateVersion: 1, type: "session.issued" });
      }
      return { session };
    }
  });
}

export type RevokeSessionInput = {
  deviceId: string;
  route: string;
  key: string;
  requestFingerprint: string;
  actorUserId: string;
  id: string;
};

export function revokeSession(database: SqliteDatabase, input: RevokeSessionInput): IdempotentResult<{ session: Session }> {
  return executeIdempotent(database, {
    deviceId: input.deviceId,
    route: input.route,
    key: input.key,
    requestFingerprint: input.requestFingerprint,
    execute: (unit) => {
      const row = unit.database.prepare("SELECT id, user_id, device_id, issued_at, expires_at, revoked_at FROM sessions WHERE id=?").get(input.id);
      if (!row) throw notFound("Session", input.id);
      if (row.user_id !== input.actorUserId) throw stateConflict("Session does not belong to actor", { sessionId: input.id });
      if (row.revoked_at) return { session: rowToSession(row) };
      const currentVersion = currentAggregateVersion(unit.database, "session", input.id);
      unit.database.prepare("UPDATE sessions SET revoked_at=? WHERE id=?").run(new Date().toISOString(), input.id);
      const next = unit.database.prepare("SELECT id, user_id, device_id, issued_at, expires_at, revoked_at FROM sessions WHERE id=?").get(input.id)!;
      unit.audit({ projectId: IDENTITY_SYSTEM_PROJECT_ID, actorId: input.actorUserId, action: "session.revoke", aggregateType: "session", aggregateId: input.id, details: {} });
      unit.appendEvent({ projectId: IDENTITY_SYSTEM_PROJECT_ID, aggregateType: "session", aggregateId: input.id, aggregateVersion: currentVersion + 1, type: "session.revoked" });
      return { session: rowToSession(next) };
    }
  });
}

export type ResolvedSession = { session: Session; user: User; device: Device };

export function resolveActiveSession(database: SqliteDatabase, sessionId: string): ResolvedSession {
  const row = database.prepare("SELECT id, user_id, device_id, issued_at, expires_at, revoked_at FROM sessions WHERE id=?").get(sessionId);
  if (!row) throw unauthenticated("Session not found");
  const session = rowToSession(row);
  if (session.revokedAt !== null) throw forbidden("Session has been revoked", { sessionId });
  if (Date.parse(session.expiresAt) <= Date.now()) throw forbidden("Session has expired", { sessionId, expiresAt: session.expiresAt });
  const user = database.prepare("SELECT id, display_name, email, created_at FROM users WHERE id=?").get(session.userId);
  if (!user) throw unauthenticated("Session user no longer exists");
  const device = database.prepare("SELECT id, user_id, device_name, public_key_fingerprint, last_seen_at, status, created_at FROM devices WHERE id=?").get(session.deviceId);
  if (!device) throw unauthenticated("Session device no longer exists");
  if (device.status === "revoked") throw forbidden("Session device has been revoked", { sessionId, deviceId: session.deviceId });
  return { session, user: { id: String(user.id), displayName: String(user.display_name), email: user.email === null ? null : String(user.email), createdAt: String(user.created_at) }, device: { id: String(device.id), userId: String(device.user_id), deviceName: String(device.device_name), publicKeyFingerprint: device.public_key_fingerprint === null ? null : String(device.public_key_fingerprint), lastSeenAt: device.last_seen_at === null ? null : String(device.last_seen_at), status: device.status === "revoked" ? "revoked" : "active", createdAt: String(device.created_at) } };
}

export function getSession(database: SqliteDatabase, id: string): Session {
  const row = database.prepare("SELECT id, user_id, device_id, issued_at, expires_at, revoked_at FROM sessions WHERE id=?").get(id);
  if (!row) throw notFound("Session", id);
  return rowToSession(row);
}

function rowToSession(row: Record<string, unknown>): Session {
  return { id: String(row.id), userId: String(row.user_id), deviceId: String(row.device_id), issuedAt: String(row.issued_at), expiresAt: String(row.expires_at), revokedAt: row.revoked_at === null ? null : String(row.revoked_at) };
}

function currentAggregateVersion(database: SqliteDatabase, aggregateType: string, aggregateId: string): number {
  const row = database.prepare("SELECT COALESCE(MAX(aggregate_version), 0) AS v FROM domain_events WHERE aggregate_type=? AND aggregate_id=?").get(aggregateType, aggregateId);
  return Number(row?.v ?? 0);
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}
