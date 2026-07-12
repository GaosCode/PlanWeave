import type { SqliteDatabase } from "../sqlite.js";
import { executeIdempotent, type IdempotentResult } from "../store.js";
import { notFound, validationFailed, DomainError } from "../identity/errors.js";
import { requireProjectRole } from "../identity/authorization.js";
import type { Session } from "../identity/types.js";
import type { Message, MessageKind } from "./types.js";
import { isMessageKind } from "./types.js";

export type AppendMessageInput = {
  deviceId: string;
  route: string;
  key: string;
  requestFingerprint: string;
  roomId: string;
  body: string;
  kind?: MessageKind;
  supersedesMessageId?: string | null;
};

export function appendMessage(database: SqliteDatabase, session: Session, input: AppendMessageInput): IdempotentResult<{ message: Message }> {
  if (typeof input.body !== "string" || input.body.length === 0) throw validationFailed("Message body is required", {});
  if (input.body.length > 8000) throw validationFailed("Message body exceeds 8000 characters", { length: input.body.length });
  const kind: MessageKind = input.kind ?? "text";
  if (!isMessageKind(kind)) throw validationFailed("Message kind is invalid", { kind: input.kind });
  return executeIdempotent(database, {
    deviceId: input.deviceId,
    route: input.route,
    key: input.key,
    requestFingerprint: input.requestFingerprint,
    execute: (unit) => {
      const room = unit.database.prepare("SELECT id, project_id, archived_at FROM rooms WHERE id=?").get(input.roomId);
      if (!room) throw notFound("Room", input.roomId);
      if (room.archived_at) throw validationFailed("Cannot append to archived room", { roomId: input.roomId });
      const projectId = String(room.project_id);
      requireProjectRole(unit.database, projectId, session.userId, "contributor");
      if (input.supersedesMessageId) {
        const prior = unit.database.prepare("SELECT id, room_id FROM messages WHERE id=?").get(input.supersedesMessageId);
        if (!prior) throw notFound("Message", input.supersedesMessageId);
        if (prior.room_id !== input.roomId) throw validationFailed("Superseded message is in a different room", { roomId: input.roomId, supersededRoomId: prior.room_id });
      }
      const id = newId("msg");
      const now = new Date().toISOString();
      unit.database.prepare("INSERT INTO messages(id, room_id, author_user_id, body, kind, created_at, supersedes_message_id) VALUES (?,?,?,?,?,?,?)").run(id, input.roomId, session.userId, input.body, kind, now, input.supersedesMessageId ?? null);
      const message: Message = { id, roomId: input.roomId, authorUserId: session.userId, body: input.body, kind, createdAt: now, supersedesMessageId: input.supersedesMessageId ?? null };
      unit.audit({ projectId, actorId: session.userId, action: "message.append", aggregateType: "message", aggregateId: id, details: { roomId: input.roomId, kind, supersedes: input.supersedesMessageId ?? null } });
      unit.appendEvent({ projectId, aggregateType: "message", aggregateId: id, aggregateVersion: 1, type: "room.message_appended" });
      return { message };
    }
  });
}

export type ListMessagesInput = { roomId: string; limit: number; cursor?: string | null };
export type ListMessagesResult = { items: Message[]; nextCursor: string | null };

export function listMessages(database: SqliteDatabase, session: Session, input: ListMessagesInput): ListMessagesResult {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw validationFailed("Limit must be an integer between 1 and 100", { limit: input.limit });
  const room = database.prepare("SELECT id, project_id FROM rooms WHERE id=?").get(input.roomId);
  if (!room) throw notFound("Room", input.roomId);
  requireProjectRole(database, String(room.project_id), session.userId, "viewer");
  const cursor = decodeCursor(input.cursor ?? null);
  const params: unknown[] = [input.roomId];
  let where = "WHERE room_id = ?";
  if (cursor) {
    where += " AND (created_at > ? OR (created_at = ? AND id > ?))";
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  params.push(input.limit + 1);
  const rows = database.prepare(`SELECT id, room_id, author_user_id, body, kind, created_at, supersedes_message_id FROM messages ${where} ORDER BY created_at, id LIMIT ?`).all(...params);
  const hasMore = rows.length > input.limit;
  const slice = hasMore ? rows.slice(0, input.limit) : rows;
  const items = slice.map(rowToMessage);
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;
  return { items, nextCursor };
}

export function getMessage(database: SqliteDatabase, session: Session, id: string): Message {
  const row = database.prepare("SELECT id, room_id, author_user_id, body, kind, created_at, supersedes_message_id FROM messages WHERE id=?").get(id);
  if (!row) throw notFound("Message", id);
  const message = rowToMessage(row);
  const room = database.prepare("SELECT project_id FROM rooms WHERE id=?").get(message.roomId);
  if (!room) throw notFound("Room", message.roomId);
  requireProjectRole(database, String(room.project_id), session.userId, "viewer");
  return message;
}

function rowToMessage(row: Record<string, unknown>): Message {
  const kind = String(row.kind);
  if (!isMessageKind(kind)) throw validationFailed("Stored message kind is invalid", { kind });
  return { id: String(row.id), roomId: String(row.room_id), authorUserId: String(row.author_user_id), body: String(row.body), kind, createdAt: String(row.created_at), supersedesMessageId: row.supersedes_message_id === null ? null : String(row.supersedes_message_id) };
}

type Cursor = { createdAt: string; id: string };

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ c: createdAt, i: id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null): Cursor | null {
  if (!cursor) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new DomainError("cursor_invalid", "Cursor is not a valid opaque token", { cursor }); }
  if (typeof parsed !== "object" || parsed === null) throw new DomainError("cursor_invalid", "Cursor payload is invalid", { cursor });
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.c !== "string" || typeof obj.i !== "string") throw new DomainError("cursor_invalid", "Cursor payload is missing fields", { cursor });
  return { createdAt: obj.c, id: obj.i };
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}
