import type { SqliteDatabase } from "../sqlite.js";
import { executeIdempotent, type IdempotentResult } from "../store.js";
import { notFound } from "./errors.js";
import { IDENTITY_SYSTEM_PROJECT_ID } from "./migrations.js";
import type { User } from "./types.js";

export type EnsureUserInput = {
  deviceId: string;
  route: string;
  key: string;
  requestFingerprint: string;
  userId?: string;
  displayName: string;
  email?: string | null;
};

export function ensureUser(database: SqliteDatabase, input: EnsureUserInput): IdempotentResult<{ user: User }> {
  return executeIdempotent(database, {
    deviceId: input.deviceId,
    route: input.route,
    key: input.key,
    requestFingerprint: input.requestFingerprint,
    execute: (unit) => {
      const id = input.userId ?? newId("user");
      const now = new Date().toISOString();
      const existing = unit.database.prepare("SELECT id, display_name, email, created_at FROM users WHERE id=?").get(id);
      let user: User;
      if (existing) {
        user = { id: String(existing.id), displayName: String(existing.display_name), email: existing.email === null ? null : String(existing.email), createdAt: String(existing.created_at) };
      } else {
        unit.database.prepare("INSERT INTO users(id, display_name, email, created_at) VALUES (?,?,?,?)").run(id, input.displayName, input.email ?? null, now);
        user = { id, displayName: input.displayName, email: input.email ?? null, createdAt: now };
        unit.appendEvent({ projectId: IDENTITY_SYSTEM_PROJECT_ID, aggregateType: "user", aggregateId: id, aggregateVersion: 1, type: "user.created" });
        unit.audit({ projectId: IDENTITY_SYSTEM_PROJECT_ID, actorId: id, action: "user.create", aggregateType: "user", aggregateId: id, details: { displayName: input.displayName } });
      }
      return { user };
    }
  });
}

export function getUser(database: SqliteDatabase, userId: string): User {
  const row = database.prepare("SELECT id, display_name, email, created_at FROM users WHERE id=?").get(userId);
  if (!row) throw notFound("User", userId);
  return { id: String(row.id), displayName: String(row.display_name), email: row.email === null ? null : String(row.email), createdAt: String(row.created_at) };
}

function newId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 12);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}
