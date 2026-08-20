import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityRepository } from "../comments/activityRepository.js";
import { ActivityProjectionService } from "../comments/service.js";
import {
  applyMigrations,
  centralSchemaVersion,
  latestCentralSchemaVersion
} from "../migrations.js";
import { migrations } from "../migrations/registry.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { WorkAssignmentError, WorkAssignmentRepository } from "../work/repository.js";
import type { AssignmentRecord, WorkItemRef } from "../work/schemas.js";

const directories: string[] = [];
const databases: SqliteDatabase[] = [];

function prepareHistoricalSchema(database: SqliteDatabase, throughVersion: number): void {
  database.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  for (const migration of migrations) {
    if (migration.version > throughVersion) break;
    if (migration.disableForeignKeys) database.exec("PRAGMA foreign_keys = OFF");
    try {
      database.exec("BEGIN IMMEDIATE");
      migration.before?.(database);
      database.exec(migration.sql);
      migration.after?.(database);
      database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(migration.version, "2020-01-01T00:00:00.000Z");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      if (migration.disableForeignKeys) database.exec("PRAGMA foreign_keys = ON");
    }
  }
}

afterEach(async () => {
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {
      // already closed
    }
  }
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function openMigrated() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-work-assign-"));
  directories.push(directory);
  const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
  databases.push(database);
  applyMigrations(database);
  return {
    directory,
    database,
    repo: new WorkAssignmentRepository(database)
  };
}

const taskItem: WorkItemRef = {
  kind: "task",
  canvasId: "default",
  taskId: "T-001"
};

const blockItem: WorkItemRef = {
  kind: "block",
  canvasId: "default",
  blockRef: "T-001#B-001"
};
const workspaceId = "workspace-a";

function humanRecord(
  overrides: Partial<AssignmentRecord> & { revision: number; workItem?: WorkItemRef } = {
    revision: 1
  }
): AssignmentRecord {
  return {
    workspaceId,
    projectId: "project-a",
    workItem: overrides.workItem ?? taskItem,
    target: { kind: "human", humanPrincipalId: "human-2" },
    revision: overrides.revision,
    updatedBy: { kind: "human", id: "human-1", displayName: "Ada" },
    updatedAt: overrides.updatedAt ?? "2026-07-24T12:00:00.000Z",
    reason: overrides.reason,
    ...overrides
  } as AssignmentRecord;
}

describe("work assignment migration v17", () => {
  it("creates work_assignments on upgrade from v16", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-work-mig-"));
    directories.push(directory);
    const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
    databases.push(database);

    prepareHistoricalSchema(database, 16);
    applyMigrations(database);
    expect(centralSchemaVersion(database)).toBe(latestCentralSchemaVersion);
    expect(latestCentralSchemaVersion).toBe(51);

    expect(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get("work_assignments")
    ).toBeDefined();

    const indexes = database
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_work_assignments%'`
      )
      .all()
      .map((row) => String(row.name));
    expect(indexes).toEqual(
      expect.arrayContaining([
        "idx_work_assignments_project_canvas",
        "idx_work_assignments_project_target_human",
        "idx_work_assignments_project_target_host"
      ])
    );
  });

  it("enforces uniqueness and target CHECK constraints", async () => {
    const { database, repo } = await openMigrated();
    repo.applyCasUpdate({
      record: humanRecord({ revision: 1 }),
      expectedRevision: 0
    });

    expect(() =>
      repo.applyCasUpdate({
        record: humanRecord({ revision: 1, updatedAt: "2026-07-24T12:01:00.000Z" }),
        expectedRevision: 0
      })
    ).toThrow(WorkAssignmentError);

    // Task cannot target Host at the SQL layer.
    expect(() =>
      database
        .prepare(
          `INSERT INTO work_assignments(
            workspace_id,project_id,canvas_id,work_item_kind,work_item_key,
            target_kind,target_human_principal_id,target_host_id,
            revision,updated_by_kind,updated_by_id,updated_by_display_name,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          workspaceId,
          "project-a",
          "default",
          "task",
          "T-HOST",
          "exact_host",
          null,
          "host-1",
          1,
          "human",
          "human-1",
          "Ada",
          "2026-07-24T12:00:00.000Z"
        )
    ).toThrow(/CHECK/i);
  });
});

describe("work assignment repository CAS", () => {
  it("rolls back assignment CAS when transactional activity projection fails", async () => {
    const { database } = await openMigrated();
    const activity = new ActivityRepository(database);
    const projection = new ActivityProjectionService({ activity });
    const repo = new WorkAssignmentRepository(database, {
      onAssignmentUpdatedInTransaction: (record) => {
        projection.projectAssignmentEventInCallerTransaction({
          projectId: record.projectId,
          workItem: record.workItem,
          assignmentRevision: record.revision,
          targetHeadline: "Assignment updated",
          occurredAt: record.updatedAt
        });
        throw new Error("activity_projection_failed");
      }
    });
    expect(() =>
      repo.applyCasUpdate({ record: humanRecord({ revision: 1 }), expectedRevision: 0 })
    ).toThrow("activity_projection_failed");
    expect(repo.get(workspaceId, "project-a", taskItem)).toBeUndefined();
    expect(database.prepare("SELECT COUNT(*) AS count FROM activity_records").get()).toEqual({
      count: 0
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM activity_projection_outbox").get()
    ).toEqual({ count: 0 });
  });

  it("inserts first revision and compare-and-sets subsequent updates", async () => {
    const { repo } = await openMigrated();
    const first = repo.applyCasUpdate({
      record: humanRecord({ revision: 1 }),
      expectedRevision: 0
    });
    expect(first.revision).toBe(1);
    expect(repo.getConcurrency(workspaceId, "project-a", taskItem).currentRevision).toBe(1);

    const second = repo.applyCasUpdate({
      record: humanRecord({
        revision: 2,
        target: { kind: "unassigned" },
        updatedAt: "2026-07-24T12:05:00.000Z"
      }),
      expectedRevision: 1
    });
    expect(second.target).toEqual({ kind: "unassigned" });
    expect(second.revision).toBe(2);

    try {
      // Input revision is consistent with expectedRevision+1, but DB already advanced past expected.
      repo.applyCasUpdate({
        record: humanRecord({
          revision: 2,
          target: { kind: "human", humanPrincipalId: "human-3" },
          updatedAt: "2026-07-24T12:06:00.000Z"
        }),
        expectedRevision: 1
      });
      expect.fail("expected revision conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkAssignmentError);
      expect((error as WorkAssignmentError).code).toBe("work_revision_conflict");
    }
  });

  it("rejects concurrent first writers with revision conflict", async () => {
    const { repo } = await openMigrated();
    repo.applyCasUpdate({
      record: humanRecord({ revision: 1 }),
      expectedRevision: 0
    });
    try {
      repo.applyCasUpdate({
        record: humanRecord({
          revision: 1,
          target: { kind: "human", humanPrincipalId: "human-9" },
          updatedAt: "2026-07-24T12:02:00.000Z"
        }),
        expectedRevision: 0
      });
      expect.fail("expected conflict");
    } catch (error) {
      expect((error as WorkAssignmentError).code).toBe("work_revision_conflict");
    }
  });

  it("batches exact refs and pages by canvas without cross-project leakage", async () => {
    const { repo } = await openMigrated();
    const otherTask: WorkItemRef = { kind: "task", canvasId: "default", taskId: "T-002" };
    const otherCanvas: WorkItemRef = { kind: "task", canvasId: "canvas-b", taskId: "T-001" };
    const otherProject: WorkItemRef = taskItem;

    repo.applyCasUpdate({
      record: humanRecord({ revision: 1, workItem: taskItem }),
      expectedRevision: 0
    });
    repo.applyCasUpdate({
      record: humanRecord({
        revision: 1,
        workItem: otherTask,
        target: { kind: "human", humanPrincipalId: "human-3" },
        updatedAt: "2026-07-24T12:01:00.000Z"
      }),
      expectedRevision: 0
    });
    repo.applyCasUpdate({
      record: humanRecord({
        revision: 1,
        workItem: otherCanvas,
        updatedAt: "2026-07-24T12:02:00.000Z"
      }),
      expectedRevision: 0
    });
    repo.applyCasUpdate({
      record: humanRecord({
        revision: 1,
        projectId: "project-b",
        workItem: otherProject,
        updatedAt: "2026-07-24T12:03:00.000Z"
      }),
      expectedRevision: 0
    });

    const batch = repo.getMany(workspaceId, "project-a", [taskItem, otherTask, blockItem]);
    expect(batch.map((row) => row.workItem)).toEqual(expect.arrayContaining([taskItem, otherTask]));
    expect(batch).toHaveLength(2);

    const canvasDefault = repo.listByProject(workspaceId, "project-a", {
      canvasId: "default",
      limit: 10
    });
    expect(canvasDefault).toHaveLength(2);
    expect(canvasDefault.every((row) => row.workItem.canvasId === "default")).toBe(true);

    const page = repo.listByProject(workspaceId, "project-a", { limit: 1, offset: 0 });
    expect(page).toHaveLength(1);
    const page2 = repo.listByProject(workspaceId, "project-a", { limit: 1, offset: 1 });
    expect(page2).toHaveLength(1);
    expect(page[0]!.workItem).not.toEqual(page2[0]!.workItem);

    expect(repo.get(workspaceId, "project-a", otherProject)?.projectId).toBe("project-a");
    expect(repo.get(workspaceId, "project-b", otherProject)?.projectId).toBe("project-b");
  });

  it("persists block exact_host and automatic_host targets without capability columns", async () => {
    const { database, repo } = await openMigrated();
    const exact = repo.applyCasUpdate({
      record: {
        workspaceId,
        projectId: "project-a",
        workItem: blockItem,
        target: { kind: "exact_host", hostId: "host-1" },
        revision: 1,
        updatedBy: { kind: "human", id: "human-1", displayName: "Ada" },
        updatedAt: "2026-07-24T12:00:00.000Z"
      },
      expectedRevision: 0
    });
    expect(exact.target).toEqual({ kind: "exact_host", hostId: "host-1" });

    const auto = repo.applyCasUpdate({
      record: {
        workspaceId,
        projectId: "project-a",
        workItem: blockItem,
        target: { kind: "automatic_host" },
        revision: 2,
        updatedBy: { kind: "human", id: "human-1", displayName: "Ada" },
        updatedAt: "2026-07-24T12:01:00.000Z"
      },
      expectedRevision: 1
    });
    expect(auto.target).toEqual({ kind: "automatic_host" });

    const columns = (
      database.prepare("PRAGMA table_info(work_assignments)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(columns).not.toEqual(expect.arrayContaining(["capabilities_json", "title", "prompt"]));
    expect(columns).toEqual(
      expect.arrayContaining([
        "project_id",
        "canvas_id",
        "work_item_kind",
        "work_item_key",
        "target_kind",
        "revision"
      ])
    );
  });
});
