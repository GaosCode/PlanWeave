import { mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import { join } from "node:path";
import { applyAgentsMigrations, agentsSchemaVersion } from "./agents/migrations.js";
import { applyAttachmentsMigrations } from "./attachments/migrations.js";
import type { ServerConfig } from "./config.js";
import { applyEventsMigrations, eventsSchemaVersion } from "./events/migrations.js";
import { applyMergeQueueMigrations, mergeQueueSchemaVersion } from "./git/migrations.js";
import { applyIdentityMigrations } from "./identity/migrations.js";
import { applyMigrations, centralSchemaVersion } from "./migrations.js";
import { applyPlanningMigrations } from "./planning/migrations.js";
import { applyProposalsMigrations } from "./proposals/migrations.js";
import { openServerDatabase, type SqliteDatabase } from "./sqlite.js";
import { applyWorkMigrations, workSchemaVersion } from "./work/migrations.js";
import { createCollaborationHttpServer } from "./collaborationApi.js";

export type StartupReconciliationHook = (database: SqliteDatabase) => void | Promise<void>;
export type SubsystemVersions = {
  central: number;
  work: number;
  identity: number;
  planning: number;
  proposals: number;
  attachments: number;
  agents: number;
  events: number;
  mergeQueue: number;
};
export type PlanweaveServer = {
  config: ServerConfig;
  database: SqliteDatabase;
  readiness(): { status: "ready"; schemaVersion: number; subsystems: SubsystemVersions };
  backupPath(): string;
  createBackup(name: string): Promise<string>;
  createHttpServer(): Server;
  close(): void;
};

function readCentralSubsystemVersion(database: SqliteDatabase, minVersion: number): number {
  // Identity / planning / proposals / attachments all share the central
  // `schema_migrations` table in A3. The reported value is `max(central) - minVersion + 1`
  // so each subsystem appears as version 1 once its migration is applied, but only
  // once all prior central migrations are also applied.
  const central = centralSchemaVersion(database);
  return Math.max(0, central - minVersion + 1);
}

export async function startPlanweaveServer(config: ServerConfig, reconciliationHooks: readonly StartupReconciliationHook[] = []): Promise<PlanweaveServer> {
  await mkdir(config.dataDirectory, { recursive: true });
  const database = await openServerDatabase(config.databasePath, config.busyTimeoutMs);
  applyMigrations(database);
  applyWorkMigrations(database);
  applyIdentityMigrations(database);
  applyPlanningMigrations(database);
  applyProposalsMigrations(database);
  applyAttachmentsMigrations(database);
  applyAgentsMigrations(database);
  applyEventsMigrations(database);
  applyMergeQueueMigrations(database);
  for (const hook of reconciliationHooks) await hook(database);
  const backupPath = () => join(config.dataDirectory, "backups");
  const computeReadiness = () => {
    // A3's identity/planning/proposals/attachments all share the central
    // `schema_migrations` table at versions 2/3/4/5 respectively. We report each
    // subsystem's effective version as `1` once the corresponding central
    // migration has been applied (so v2 central → identity=1, v3 central → planning=1, ...).
    // A pre-2 central value means none of A3 is applied yet.
    const central = centralSchemaVersion(database);
    const subsystems: SubsystemVersions = {
      central,
      work: workSchemaVersion(database),
      identity: central >= 2 ? 1 : 0,
      planning: central >= 3 ? 1 : 0,
      proposals: central >= 4 ? 1 : 0,
      attachments: central >= 5 ? 1 : 0,
      agents: agentsSchemaVersion(database),
      events: eventsSchemaVersion(database),
      mergeQueue: mergeQueueSchemaVersion(database)
    };
    return { status: "ready" as const, schemaVersion: Math.max(...Object.values(subsystems)), subsystems };
  };
  return {
    config,
    database,
    readiness: computeReadiness,
    backupPath,
    createBackup: async (name) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) throw new Error("Backup name must be a safe filename.");
      const directory = backupPath();
      await mkdir(directory, { recursive: true });
      const target = join(directory, name);
      database.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
      return target;
    },
    createHttpServer: () => createCollaborationHttpServer({ database, config, readiness: computeReadiness }),
    close: () => database.close()
  };
}
