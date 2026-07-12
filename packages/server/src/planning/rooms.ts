import type { SqliteDatabase } from "../sqlite.js";
import { executeIdempotent, type IdempotentResult } from "../store.js";
import { notFound, stateConflict, forbidden } from "../identity/errors.js";
import { requireProjectRole } from "../identity/authorization.js";
import type { Session } from "../identity/types.js";
import type { Room } from "./types.js";

export type CreateRoomInput = {
  deviceId: string;
  route: string;
  key: string;
  requestFingerprint: string;
  id?: string;
  projectId: string;
  name: string;
};

export function createRoom(database: SqliteDatabase, session: Session, input: CreateRoomInput): IdempotentResult<{ room: Room }> {
  requireProjectRole(database, input.projectId, session.userId, "contributor");
  return executeIdempotent(database, {
    deviceId: input.deviceId,
    route: input.route,
    key: input.key,
    requestFingerprint: input.requestFingerprint,
    execute: (unit) => {
      const id = input.id ?? newId("room");
      const now = new Date().toISOString();
      const existing = unit.database.prepare("SELECT id, project_id, name, created_at, archived_at FROM rooms WHERE id=?").get(id);
      let room: Room;
      if (existing) {
        if (existing.project_id !== input.projectId) throw stateConflict("Room already exists in another project", { roomId: id });
        room = rowToRoom(existing);
      } else {
        const project = unit.database.prepare("SELECT id FROM projects WHERE id=?").get(input.projectId);
        if (!project) throw notFound("Project", input.projectId);
        unit.database.prepare("INSERT INTO rooms(id, project_id, name, created_at, archived_at) VALUES (?,?,?,?,?)").run(id, input.projectId, input.name, now, null);
        room = { id, projectId: input.projectId, name: input.name, createdAt: now, archivedAt: null };
        unit.audit({ projectId: input.projectId, actorId: session.userId, action: "room.create", aggregateType: "room", aggregateId: id, details: { name: input.name } });
        unit.appendEvent({ projectId: input.projectId, aggregateType: "room", aggregateId: id, aggregateVersion: 1, type: "room.created" });
      }
      return { room };
    }
  });
}

export type EnsureDefaultRoomInput = {
  deviceId: string;
  route: string;
  key: string;
  requestFingerprint: string;
  projectId: string;
  name?: string;
};

export function ensureDefaultRoom(database: SqliteDatabase, session: Session, input: EnsureDefaultRoomInput): IdempotentResult<{ room: Room }> {
  requireProjectRole(database, input.projectId, session.userId, "contributor");
  return executeIdempotent(database, {
    deviceId: input.deviceId,
    route: input.route,
    key: input.key,
    requestFingerprint: input.requestFingerprint,
    execute: (unit) => {
      const existing = unit.database.prepare("SELECT id, project_id, name, created_at, archived_at FROM rooms WHERE project_id=? AND archived_at IS NULL ORDER BY created_at ASC LIMIT 1").get(input.projectId);
      if (existing) return { room: rowToRoom(existing) };
      const id = newId("room");
      const now = new Date().toISOString();
      const project = unit.database.prepare("SELECT id FROM projects WHERE id=?").get(input.projectId);
      if (!project) throw notFound("Project", input.projectId);
      unit.database.prepare("INSERT INTO rooms(id, project_id, name, created_at, archived_at) VALUES (?,?,?,?,?)").run(id, input.projectId, input.name ?? "General", now, null);
      const room: Room = { id, projectId: input.projectId, name: input.name ?? "General", createdAt: now, archivedAt: null };
      unit.audit({ projectId: input.projectId, actorId: session.userId, action: "room.create", aggregateType: "room", aggregateId: id, details: { name: room.name, default: true } });
      unit.appendEvent({ projectId: input.projectId, aggregateType: "room", aggregateId: id, aggregateVersion: 1, type: "room.created" });
      return { room };
    }
  });
}

export type ArchiveRoomInput = {
  deviceId: string;
  route: string;
  key: string;
  requestFingerprint: string;
  id: string;
};

export function archiveRoom(database: SqliteDatabase, session: Session, input: ArchiveRoomInput): IdempotentResult<{ room: Room }> {
  return executeIdempotent(database, {
    deviceId: input.deviceId,
    route: input.route,
    key: input.key,
    requestFingerprint: input.requestFingerprint,
    execute: (unit) => {
      const row = unit.database.prepare("SELECT id, project_id, name, created_at, archived_at FROM rooms WHERE id=?").get(input.id);
      if (!row) throw notFound("Room", input.id);
      const projectId = String(row.project_id);
      requireProjectRole(unit.database, projectId, session.userId, "maintainer");
      if (row.archived_at) return { room: rowToRoom(row) };
      const now = new Date().toISOString();
      unit.database.prepare("UPDATE rooms SET archived_at=? WHERE id=?").run(now, input.id);
      const next = unit.database.prepare("SELECT id, project_id, name, created_at, archived_at FROM rooms WHERE id=?").get(input.id)!;
      unit.audit({ projectId, actorId: session.userId, action: "room.archive", aggregateType: "room", aggregateId: input.id, details: {} });
      unit.appendEvent({ projectId, aggregateType: "room", aggregateId: input.id, aggregateVersion: 2, type: "room.archived" });
      return { room: rowToRoom(next) };
    }
  });
}

export function getRoom(database: SqliteDatabase, id: string): Room {
  const row = database.prepare("SELECT id, project_id, name, created_at, archived_at FROM rooms WHERE id=?").get(id);
  if (!row) throw notFound("Room", id);
  return rowToRoom(row);
}

export function requireActiveRoom(database: SqliteDatabase, id: string): Room {
  const room = getRoom(database, id);
  if (room.archivedAt) throw forbidden("Room is archived", { roomId: id });
  return room;
}

function rowToRoom(row: Record<string, unknown>): Room {
  return { id: String(row.id), projectId: String(row.project_id), name: String(row.name), createdAt: String(row.created_at), archivedAt: row.archived_at === null ? null : String(row.archived_at) };
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}
