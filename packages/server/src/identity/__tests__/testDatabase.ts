import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteDatabase } from "../../sqlite.js";
import { openServerDatabase } from "../../sqlite.js";
import { applyMigrations } from "../../migrations.js";
import { applyIdentityMigrations } from "../migrations.js";
import { applyPlanningMigrations } from "../../planning/migrations.js";
import { applyProposalsMigrations } from "../../proposals/migrations.js";
import { applyAttachmentsMigrations } from "../../attachments/migrations.js";

export type TestHarness = { dataDirectory: string; database: SqliteDatabase };

export async function createTestDatabase(): Promise<TestHarness> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-a3-"));
  const database = await openServerDatabase(join(dataDirectory, "server.sqlite"), 5000);
  applyMigrations(database);
  applyIdentityMigrations(database);
  applyPlanningMigrations(database);
  applyProposalsMigrations(database);
  applyAttachmentsMigrations(database);
  return { dataDirectory, database };
}

export async function cleanupTestHarness(harness: TestHarness): Promise<void> {
  harness.database.close();
  await rm(harness.dataDirectory, { recursive: true, force: true });
}

export async function seedProject(database: SqliteDatabase, projectId: string, name: string): Promise<void> {
  database.prepare("INSERT INTO projects(id, version, name, created_at) VALUES (?,?,?,?)").run(projectId, 1, name, new Date().toISOString());
}

export async function seedMembership(database: SqliteDatabase, projectId: string, userId: string, role: "owner" | "maintainer" | "contributor" | "viewer"): Promise<void> {
  database.prepare("INSERT INTO memberships(project_id, user_id, role, created_at) VALUES (?,?,?,?)").run(projectId, userId, role, new Date().toISOString());
}
