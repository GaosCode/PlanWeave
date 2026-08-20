import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityRepository } from "../comments/activityRepository.js";
import { buildCommentActivity, buildMembershipActivity } from "../comments/activityProjection.js";
import { CommentRepository, CommentRepositoryError } from "../comments/repository.js";
import type { CommentRecord } from "../comments/schemas.js";
import {
  applyMigrations,
  centralSchemaVersion,
  latestCentralSchemaVersion
} from "../migrations.js";
import { migrations } from "../migrations/registry.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import type { WorkItemRef } from "../work/schemas.js";

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
  const directory = await mkdtemp(join(tmpdir(), "planweave-comment-persist-"));
  directories.push(directory);
  const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
  databases.push(database);
  applyMigrations(database);
  return {
    directory,
    database,
    comments: new CommentRepository(database),
    activity: new ActivityRepository(database)
  };
}

const taskItem: WorkItemRef = {
  kind: "task",
  canvasId: "default",
  taskId: "T-001"
};

function commentRecord(
  overrides: Partial<CommentRecord> & { commentId: string; revision?: number } = {
    commentId: "comment-1"
  }
): CommentRecord {
  return {
    commentId: overrides.commentId,
    projectId: "project-a",
    workItem: taskItem,
    authorHumanPrincipalId: "human-1",
    body: "hello world",
    bodyFormat: "markdown",
    revision: overrides.revision ?? 1,
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
    attachments: [],
    ...overrides
  } as CommentRecord;
}

function uniqueIndexColumns(database: SqliteDatabase, table: string): string[][] {
  const indexes = database.prepare(`PRAGMA index_list(${table})`).all() as Array<{
    name: string;
    unique: number;
  }>;
  return indexes
    .filter((index) => index.unique === 1)
    .map((index) =>
      (
        database.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{
          name: string;
          seqno: number;
        }>
      )
        .sort((left, right) => left.seqno - right.seqno)
        .map((column) => column.name)
    );
}

describe("comment/activity migration v20", () => {
  it("creates comments, activity_records, and outbox on upgrade", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-comment-mig-"));
    directories.push(directory);
    const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
    databases.push(database);

    prepareHistoricalSchema(database, 19);
    applyMigrations(database);
    expect(centralSchemaVersion(database)).toBe(latestCentralSchemaVersion);
    expect(latestCentralSchemaVersion).toBe(51);

    for (const table of ["comments", "activity_records", "activity_projection_outbox"]) {
      expect(
        database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
      ).toBeDefined();
    }
    expect(
      database
        .prepare(
          "SELECT 1 FROM pragma_table_info('activity_projection_outbox') WHERE name='activity_occurred_at'"
        )
        .get()
    ).toBeDefined();
    for (const index of ["idx_activity_records_retention", "idx_activity_outbox_retention"]) {
      expect(
        database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(index)
      ).toBeDefined();
    }
    expect(uniqueIndexColumns(database, "activity_records")).toContainEqual([
      "workspace_id",
      "project_id",
      "source_kind",
      "source_id"
    ]);
    expect(uniqueIndexColumns(database, "activity_projection_outbox")).toContainEqual([
      "workspace_id",
      "project_id",
      "source_kind",
      "source_id"
    ]);
  });
});

describe("comment repository", () => {
  it("inserts, CAS edits, tombstones, and paginates deterministically", async () => {
    const { comments } = await openMigrated();

    const first = comments.insert(
      commentRecord({
        commentId: "comment-1",
        createdAt: "2026-07-24T12:00:00.000Z",
        updatedAt: "2026-07-24T12:00:00.000Z"
      })
    );
    const second = comments.insert(
      commentRecord({
        commentId: "comment-2",
        body: "second",
        createdAt: "2026-07-24T12:00:01.000Z",
        updatedAt: "2026-07-24T12:00:01.000Z"
      })
    );
    expect(first.revision).toBe(1);
    expect(second.commentId).toBe("comment-2");

    const edited = comments.applyCasUpdate({
      record: {
        ...first,
        body: "edited",
        revision: 2,
        updatedAt: "2026-07-24T12:05:00.000Z"
      },
      expectedRevision: 1
    });
    expect(edited.body).toBe("edited");
    expect(edited.revision).toBe(2);

    expect(() =>
      comments.applyCasUpdate({
        record: { ...edited, body: "race", revision: 3, updatedAt: "2026-07-24T12:06:00.000Z" },
        expectedRevision: 1
      })
    ).toThrow(CommentRepositoryError);

    const tombstoned = comments.applyCasUpdate({
      record: {
        ...edited,
        revision: 3,
        updatedAt: "2026-07-24T12:07:00.000Z",
        tombstonedAt: "2026-07-24T12:07:00.000Z",
        tombstonedBy: { kind: "human", id: "human-1", displayName: "Ada" },
        tombstoneReason: "noise"
      },
      expectedRevision: 2
    });
    expect(tombstoned.tombstonedAt).toBeDefined();
    // Durable body retained for audit.
    expect(tombstoned.body).toBe("edited");

    const activeOnly = comments.listByWorkItem({
      projectId: "project-a",
      workItem: taskItem,
      limit: 10,
      includeTombstoned: false
    });
    expect(activeOnly.map((c) => c.commentId)).toEqual(["comment-2"]);

    const withTombstones = comments.listByWorkItem({
      projectId: "project-a",
      workItem: taskItem,
      limit: 10,
      includeTombstoned: true
    });
    expect(withTombstones.map((c) => c.commentId)).toEqual(["comment-1", "comment-2"]);

    const page1 = comments.listByWorkItem({
      projectId: "project-a",
      workItem: taskItem,
      limit: 1,
      includeTombstoned: true
    });
    expect(page1).toHaveLength(1);
    const page2 = comments.listByWorkItem({
      projectId: "project-a",
      workItem: taskItem,
      limit: 1,
      cursor: { createdAt: page1[0]!.createdAt, commentId: page1[0]!.commentId },
      includeTombstoned: true
    });
    expect(page2.map((c) => c.commentId)).toEqual(["comment-2"]);
  });

  it("isolates projects and work items", async () => {
    const { comments } = await openMigrated();
    comments.insert(commentRecord({ commentId: "c-a", projectId: "project-a" }));
    comments.insert(
      commentRecord({
        commentId: "c-b",
        projectId: "project-b",
        authorHumanPrincipalId: "human-2"
      })
    );
    comments.insert(
      commentRecord({
        commentId: "c-other-task",
        projectId: "project-a",
        workItem: { kind: "task", canvasId: "default", taskId: "T-002" }
      })
    );

    const listed = comments.listByWorkItem({
      projectId: "project-a",
      workItem: taskItem,
      limit: 10,
      includeTombstoned: true
    });
    expect(listed.map((c) => c.commentId)).toEqual(["c-a"]);
    expect(comments.get("project-b", "c-a")).toBeUndefined();
  });
});

describe("activity repository", () => {
  it("keeps identical project and source keys independent across workspaces", async () => {
    const { database } = await openMigrated();
    const workspaceA = new ActivityRepository(database, { workspaceId: "workspace-a" });
    const workspaceB = new ActivityRepository(database, { workspaceId: "workspace-b" });
    const base = {
      projectId: "shared-project",
      type: "member_joined" as const,
      membershipId: "membership-1",
      transitionRevision: 1,
      humanPrincipalId: "human-1",
      displayName: "Ada",
      membershipRole: "member" as const,
      occurredAt: "2026-07-24T12:00:00.000Z"
    };
    const recordA = buildMembershipActivity({ activityId: "activity-a", ...base });
    const recordB = buildMembershipActivity({ activityId: "activity-b", ...base });

    expect(workspaceA.enqueueAndProject(recordA, recordA.occurredAt).inserted).toBe(true);
    expect(workspaceB.enqueueAndProject(recordB, recordB.occurredAt).inserted).toBe(true);
    expect(
      workspaceA.enqueueAndProject(
        { ...recordA, activityId: "activity-a-duplicate" },
        recordA.occurredAt
      )
    ).toMatchObject({ inserted: false, record: { activityId: "activity-a" } });

    expect(workspaceA.list({ projectId: base.projectId, limit: 10 })).toEqual([recordA]);
    expect(workspaceB.list({ projectId: base.projectId, limit: 10 })).toEqual([recordB]);
    expect(
      database
        .prepare(
          `SELECT workspace_id FROM activity_projection_outbox
           WHERE project_id=? AND source_kind='membership' AND source_id=?
           ORDER BY workspace_id`
        )
        .all(base.projectId, recordA.source.sourceId)
    ).toEqual([{ workspace_id: "workspace-a" }, { workspace_id: "workspace-b" }]);
  });

  it("purges expired records and outbox rows in bounded batches without reviving them", async () => {
    const { activity } = await openMigrated();
    const cutoff = "2025-07-26T12:00:00.000Z";
    for (const [activityId, commentId, occurredAt] of [
      ["act-expired-1", "comment-expired-1", "2025-07-25T12:00:00.000Z"],
      ["act-expired-2", "comment-expired-2", "2025-07-26T11:59:59.999Z"],
      ["act-boundary", "comment-boundary", cutoff]
    ] as const) {
      const record = buildCommentActivity({
        activityId,
        projectId: "project-a",
        type: "comment_created",
        commentId,
        workItem: taskItem,
        authorHumanPrincipalId: "human-1",
        revision: 1,
        occurredAt
      });
      activity.enqueueAndProject(record, occurredAt);
    }
    activity.database
      .prepare(
        "UPDATE activity_projection_outbox SET projected_at=NULL WHERE activity_occurred_at < ?"
      )
      .run(cutoff);

    expect(activity.purgeExpired(cutoff, 1)).toEqual({ records: 1, outbox: 1 });
    expect(activity.reconcileOutbox(10, cutoff)).toEqual({
      processed: 0,
      inserted: 0,
      duplicates: 0
    });
    expect(activity.purgeExpired(cutoff, 1)).toEqual({ records: 1, outbox: 1 });
    expect(activity.list({ projectId: "project-a", limit: 10 })).toHaveLength(1);
    expect(activity.getBySource("project-a", "comment", "comment-boundary")?.activityId).toBe(
      "act-boundary"
    );
  });

  it("inserts idempotently by source and supports outbox reconciliation", async () => {
    const { activity } = await openMigrated();
    const record = buildMembershipActivity({
      activityId: "act-1",
      projectId: "project-a",
      type: "member_joined",
      membershipId: "membership-1",
      transitionRevision: 1,
      humanPrincipalId: "human-1",
      displayName: "Ada",
      membershipRole: "member",
      occurredAt: "2026-07-24T12:00:00.000Z"
    });

    const first = activity.insertIdempotent(record);
    expect(first.inserted).toBe(true);
    const second = activity.insertIdempotent({
      ...record,
      activityId: "act-duplicate"
    });
    expect(second.inserted).toBe(false);
    expect(second.record.activityId).toBe("act-1");

    // Simulate outbox gap: insert outbox without projected_at, activity already present.
    const gap = buildCommentActivity({
      activityId: "act-gap",
      projectId: "project-a",
      type: "comment_created",
      commentId: "comment-gap",
      workItem: taskItem,
      authorHumanPrincipalId: "human-1",
      revision: 1,
      occurredAt: "2026-07-24T12:10:00.000Z"
    });
    activity.database
      .prepare(
        `INSERT INTO activity_projection_outbox(
          outbox_id,workspace_id,project_id,source_kind,source_id,activity_json,activity_occurred_at,
          created_at,projected_at
        ) VALUES (?,?,?,?,?,?,?,?, NULL)`
      )
      .run(
        "outbox-gap",
        "legacy",
        gap.projectId,
        gap.source.kind,
        gap.source.sourceId,
        JSON.stringify(gap),
        gap.occurredAt,
        gap.occurredAt
      );

    const recon = activity.reconcileOutbox(10);
    expect(recon.processed).toBe(1);
    expect(recon.inserted).toBe(1);
    expect(activity.getBySource("project-a", "comment", gap.source.sourceId)?.activityId).toBe(
      "act-gap"
    );

    // Re-reconcile is a no-op.
    expect(activity.reconcileOutbox(10).processed).toBe(0);
  });

  it("lists activity newest-first with keyset pagination and work-item filter", async () => {
    const { activity } = await openMigrated();
    const a1 = buildCommentActivity({
      activityId: "act-old",
      projectId: "project-a",
      type: "comment_created",
      commentId: "c1",
      workItem: taskItem,
      authorHumanPrincipalId: "human-1",
      revision: 1,
      occurredAt: "2026-07-24T12:00:00.000Z"
    });
    const a2 = buildCommentActivity({
      activityId: "act-new",
      projectId: "project-a",
      type: "comment_edited",
      commentId: "c1",
      workItem: taskItem,
      authorHumanPrincipalId: "human-1",
      revision: 2,
      occurredAt: "2026-07-24T13:00:00.000Z"
    });
    const other = buildCommentActivity({
      activityId: "act-other",
      projectId: "project-a",
      type: "comment_created",
      commentId: "c2",
      workItem: { kind: "task", canvasId: "default", taskId: "T-002" },
      authorHumanPrincipalId: "human-1",
      revision: 1,
      occurredAt: "2026-07-24T14:00:00.000Z"
    });
    activity.enqueueAndProject(a1, a1.occurredAt);
    activity.enqueueAndProject(a2, a2.occurredAt);
    activity.enqueueAndProject(other, other.occurredAt);

    const page = activity.list({ projectId: "project-a", limit: 2 });
    expect(page.map((r) => r.activityId)).toEqual(["act-other", "act-new"]);

    const next = activity.list({
      projectId: "project-a",
      limit: 2,
      cursor: { occurredAt: page[1]!.occurredAt, activityId: page[1]!.activityId }
    });
    expect(next.map((r) => r.activityId)).toEqual(["act-old"]);

    const filtered = activity.list({
      projectId: "project-a",
      workItem: taskItem,
      limit: 10
    });
    expect(filtered.map((r) => r.activityId)).toEqual(["act-new", "act-old"]);
  });
});
