import type { SqliteDatabase } from "../sqlite.js";
import { forbidden } from "./errors.js";
import type { Role } from "./types.js";
import { isRole, meetsRole } from "./types.js";

export function requireProjectRole(database: SqliteDatabase, projectId: string, userId: string, minimum: Role): Role {
  if (!isRole(minimum)) throw new Error(`Unknown role: ${String(minimum)}`);
  const row = database.prepare("SELECT role FROM memberships WHERE project_id=? AND user_id=?").get(projectId, userId);
  if (!row) throw forbidden("User is not a member of the project", { projectId, userId, minimum });
  const actual = String(row.role);
  if (!isRole(actual)) throw forbidden("Membership role is invalid", { projectId, userId, role: actual });
  if (!meetsRole(actual, minimum)) throw forbidden("Insufficient project role", { projectId, userId, actual, minimum });
  return actual;
}

export function lookupProjectRole(database: SqliteDatabase, projectId: string, userId: string): Role | null {
  const row = database.prepare("SELECT role FROM memberships WHERE project_id=? AND user_id=?").get(projectId, userId);
  if (!row) return null;
  const role = String(row.role);
  return isRole(role) ? role : null;
}
