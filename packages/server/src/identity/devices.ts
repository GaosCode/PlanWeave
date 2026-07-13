import type { SqliteDatabase } from "../sqlite.js";
import { executeIdempotent, type IdempotentResult } from "../store.js";
import { notFound, stateConflict } from "./errors.js";
import { IDENTITY_SYSTEM_PROJECT_ID } from "./migrations.js";
import type { Device } from "./types.js";

export type CreateDeviceInput = {
  deviceId: string;
  route: string;
  key: string;
  requestFingerprint: string;
  userId: string;
  id?: string;
  deviceName: string;
  publicKeyFingerprint?: string | null;
};

export function createDevice(database: SqliteDatabase, input: CreateDeviceInput): IdempotentResult<{ device: Device }> {
  return executeIdempotent(database, {
    deviceId: input.deviceId,
    route: input.route,
    key: input.key,
    requestFingerprint: input.requestFingerprint,
    execute: (unit) => {
      const id = input.id ?? newId("device");
      const now = new Date().toISOString();
      const existing = unit.database.prepare("SELECT id, user_id, device_name, public_key_fingerprint, last_seen_at, status, created_at FROM devices WHERE id=?").get(id);
      let device: Device;
      if (existing) {
        if (existing.user_id !== input.userId) throw stateConflict("Device is already bound to a different user", { deviceId: id });
        device = rowToDevice(existing);
      } else {
        unit.database.prepare("INSERT INTO devices(id, user_id, device_name, public_key_fingerprint, last_seen_at, status, created_at) VALUES (?,?,?,?,?,?,?)").run(id, input.userId, input.deviceName, input.publicKeyFingerprint ?? null, null, "active", now);
        device = { id, userId: input.userId, deviceName: input.deviceName, publicKeyFingerprint: input.publicKeyFingerprint ?? null, lastSeenAt: null, status: "active", createdAt: now };
        unit.audit({ projectId: IDENTITY_SYSTEM_PROJECT_ID, actorId: input.userId, action: "device.create", aggregateType: "device", aggregateId: id, details: { deviceName: input.deviceName } });
        unit.appendEvent({ projectId: IDENTITY_SYSTEM_PROJECT_ID, aggregateType: "device", aggregateId: id, aggregateVersion: 1, type: "device.created" });
      }
      return { device };
    }
  });
}

export type RevokeDeviceInput = {
  deviceId: string;
  route: string;
  key: string;
  requestFingerprint: string;
  actorUserId: string;
  id: string;
};

export function revokeDevice(database: SqliteDatabase, input: RevokeDeviceInput): IdempotentResult<{ device: Device }> {
  return executeIdempotent(database, {
    deviceId: input.deviceId,
    route: input.route,
    key: input.key,
    requestFingerprint: input.requestFingerprint,
    execute: (unit) => {
      const row = unit.database.prepare("SELECT id, user_id, device_name, public_key_fingerprint, last_seen_at, status, created_at FROM devices WHERE id=?").get(input.id);
      if (!row) throw notFound("Device", input.id);
      if (row.user_id !== input.actorUserId) throw stateConflict("Device does not belong to actor", { deviceId: input.id });
      if (row.status === "revoked") return { device: rowToDevice(row) };
      const currentVersion = currentAggregateVersion(unit.database, "device", input.id);
      unit.database.prepare("UPDATE devices SET status='revoked' WHERE id=?").run(input.id);
      const next = unit.database.prepare("SELECT id, user_id, device_name, public_key_fingerprint, last_seen_at, status, created_at FROM devices WHERE id=?").get(input.id)!;
      unit.audit({ projectId: IDENTITY_SYSTEM_PROJECT_ID, actorId: input.actorUserId, action: "device.revoke", aggregateType: "device", aggregateId: input.id, details: { previousStatus: "active" } });
      unit.appendEvent({ projectId: IDENTITY_SYSTEM_PROJECT_ID, aggregateType: "device", aggregateId: input.id, aggregateVersion: currentVersion + 1, type: "device.revoked" });
      return { device: rowToDevice(next) };
    }
  });
}

export function getDevice(database: SqliteDatabase, id: string): Device {
  const row = database.prepare("SELECT id, user_id, device_name, public_key_fingerprint, last_seen_at, status, created_at FROM devices WHERE id=?").get(id);
  if (!row) throw notFound("Device", id);
  return rowToDevice(row);
}

function rowToDevice(row: Record<string, unknown>): Device {
  return { id: String(row.id), userId: String(row.user_id), deviceName: String(row.device_name), publicKeyFingerprint: row.public_key_fingerprint === null ? null : String(row.public_key_fingerprint), lastSeenAt: row.last_seen_at === null ? null : String(row.last_seen_at), status: row.status === "revoked" ? "revoked" : "active", createdAt: String(row.created_at) };
}

function currentAggregateVersion(database: SqliteDatabase, aggregateType: string, aggregateId: string): number {
  const row = database.prepare("SELECT COALESCE(MAX(aggregate_version), 0) AS v FROM domain_events WHERE aggregate_type=? AND aggregate_id=?").get(aggregateType, aggregateId);
  return Number(row?.v ?? 0);
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}
