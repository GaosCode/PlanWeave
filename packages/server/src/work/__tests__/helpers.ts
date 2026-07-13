/**
 * Test helper: build a fully-migrated SQLite + work services bundle in a
 * scratch directory. Each call returns a fresh database so tests cannot
 * leak state.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../../migrations.js";
import type { SqliteDatabase } from "../../sqlite.js";
import { openServerDatabase } from "../../sqlite.js";
import { applyWorkMigrations, createWorkRepository, createWorkServices, type WorkServices } from "../ids.js";
import { serverTaskId as makeServerTaskId } from "../taskIds.js";

export type WorkTestHarness = {
  dataDirectory: string;
  database: SqliteDatabase;
  services: WorkServices;
  seedProject(projectId: string): void;
  seedTask(input: { projectId: string; taskId: string; title?: string; parallel?: boolean; locks?: string[]; dependencyIds?: string[] }): { serverTaskId: string };
  close(): void;
};

export async function createWorkHarness(): Promise<WorkTestHarness> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-work-"));
  const databasePath = join(dataDirectory, "server.sqlite");
  const database = await openServerDatabase(databasePath, 5000);
  applyMigrations(database);
  applyWorkMigrations(database);
  const repository = createWorkRepository({ database });
  const services = createWorkServices({ repository });

  const seedProject = (projectId: string) => {
    database.prepare("INSERT INTO projects(id,name,created_at) VALUES (?,?,?)").run(projectId, `Project ${projectId}`, new Date().toISOString());
  };

  const seedTask = (input: { projectId: string; taskId: string; title?: string; parallel?: boolean; locks?: string[]; dependencyIds?: string[] }) => {
    const serverTaskId = makeServerTaskId(input.projectId, input.taskId);
    const policy = { parallel: input.parallel ?? false, locks: input.locks ?? [] };
    const now = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare("INSERT INTO work_tasks(id,project_id,task_id,title,parallel,locks_json,version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(serverTaskId, input.projectId, input.taskId, input.title ?? input.taskId, policy.parallel ? 1 : 0, JSON.stringify(policy.locks), 1, "ready", now, now);
      for (const depTaskId of input.dependencyIds ?? []) {
        const depServerId = depTaskId.startsWith("task_") ? depTaskId : makeServerTaskId(input.projectId, depTaskId);
        database.prepare("INSERT INTO work_task_dependencies(project_id,task_id,depends_on_task_id) VALUES (?,?,?)").run(input.projectId, serverTaskId, depServerId);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return { serverTaskId };
  };

  return {
    dataDirectory,
    database,
    services,
    seedProject,
    seedTask,
    close: () => database.close()
  };
}

export async function cleanupHarness(harness: WorkTestHarness): Promise<void> {
  harness.close();
  await rm(harness.dataDirectory, { recursive: true, force: true });
}
