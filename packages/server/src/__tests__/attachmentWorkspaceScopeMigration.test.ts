import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { attachmentWorkspaceScopeMigration } from "../migrations/attachmentWorkspaceScope.js";
import { CommentAttachmentRepository } from "../attachments/repository.js";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { applyMigrationsThroughVersion } from "./support/migrationFixture.js";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function openDatabase(): Promise<SqliteDatabase> {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  database.exec(`
    DROP TABLE comment_pending_uploads;
    DROP TABLE comment_attachment_bindings;
    DROP TABLE comment_pending_uploads_unscoped_legacy;
    DROP TABLE comment_attachment_bindings_unscoped_legacy;
    CREATE TABLE comment_pending_uploads (
      pending_upload_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      uploader_human_principal_id TEXT NOT NULL,
      expected_digest_sha256 TEXT,
      expected_size_bytes INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      file_name TEXT,
      comment_id TEXT,
      status TEXT NOT NULL,
      digest_sha256 TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      uploaded_at TEXT,
      finalized_at TEXT
    );
    CREATE TABLE comment_attachment_bindings (
      project_id TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      digest_sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      file_name TEXT,
      created_at TEXT NOT NULL,
      comment_tombstoned_at TEXT,
      PRIMARY KEY(project_id,comment_id,digest_sha256)
    );
  `);
  return database;
}

function registerProject(database: SqliteDatabase, workspaceId: string, projectId: string): void {
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO project_registry(
        project_registry_id,workspace_id,project_id,project_root_internal,visibility,
        owner_human_principal_id,acl_revision,created_at,updated_at,revoked_at
      ) VALUES(?,?,?,NULL,'private',NULL,0,?,?,NULL)`
    )
    .run(`registry-${workspaceId}-${projectId}`, workspaceId, projectId, now, now);
}

function insertLegacyPending(
  database: SqliteDatabase,
  pendingUploadId: string,
  projectId: string
): void {
  database
    .prepare(
      `INSERT INTO comment_pending_uploads(
        pending_upload_id,project_id,uploader_human_principal_id,expected_digest_sha256,
        expected_size_bytes,media_type,file_name,comment_id,status,digest_sha256,created_at,
        expires_at,uploaded_at,finalized_at
      ) VALUES(?,?,?,NULL,1,'text/plain',NULL,NULL,'pending',NULL,?,?,NULL,NULL)`
    )
    .run(
      pendingUploadId,
      projectId,
      "human-owner",
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z"
    );
}

function insertLegacyBinding(
  database: SqliteDatabase,
  projectId: string,
  commentId: string,
  digest = "a".repeat(64)
): void {
  database
    .prepare(
      `INSERT INTO comment_attachment_bindings(
        project_id,comment_id,digest_sha256,size_bytes,media_type,file_name,created_at,
        comment_tombstoned_at
      ) VALUES(?,?,?,1,'text/plain',NULL,'2026-01-01T00:00:00.000Z',NULL)`
    )
    .run(projectId, commentId, digest);
}

describe("attachment workspace scope migration", () => {
  it("preserves historical uploads and bindings without inventing their pending provenance", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrationsThroughVersion(database, 73);
    database
      .prepare(`INSERT INTO comment_pending_uploads(
      pending_upload_id,workspace_id,project_id,uploader_human_principal_id,
      expected_size_bytes,media_type,file_name,status,digest_sha256,created_at,expires_at,finalized_at
    ) VALUES('historical-pending','historical-workspace','historical-project','historical-uploader',
      1,'text/plain','historical.txt','finalized',?,'2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z','2026-01-01T00:00:00.000Z')`)
      .run("a".repeat(64));
    database
      .prepare(`INSERT INTO comment_attachment_bindings(
      workspace_id,project_id,comment_id,digest_sha256,size_bytes,media_type,file_name,created_at
    ) VALUES('historical-workspace','historical-project','historical-comment',?,1,
      'text/plain','historical.txt','2026-01-01T00:00:00.000Z')`)
      .run("a".repeat(64));
    database.exec(`INSERT INTO comment_pending_uploads(
      pending_upload_id,workspace_id,project_id,uploader_human_principal_id,
      expected_size_bytes,media_type,status,digest_sha256,created_at,expires_at,finalized_at)
      SELECT 'historical-unbound',workspace_id,project_id,uploader_human_principal_id,
      expected_size_bytes,media_type,status,'${"b".repeat(64)}',created_at,expires_at,finalized_at
      FROM comment_pending_uploads;
      INSERT INTO comment_pending_uploads(
      pending_upload_id,workspace_id,project_id,uploader_human_principal_id,
      expected_size_bytes,media_type,status,digest_sha256,created_at,expires_at,finalized_at)
      SELECT 'historical-fresh',workspace_id,project_id,uploader_human_principal_id,
      expected_size_bytes,media_type,status,'${"c".repeat(64)}','2026-01-03T00:00:00.000Z',
      '2026-01-03T01:00:00.000Z','2026-01-03T00:30:00.000Z'
      FROM comment_pending_uploads WHERE pending_upload_id='historical-pending';
      UPDATE comment_attachment_bindings SET comment_tombstoned_at='2026-01-02T12:00:00.000Z';`);
    applyMigrations(database);
    applyMigrations(database);
    const attachments = new CommentAttachmentRepository(database);
    const expired = attachments.listExpiredStagedForCleanup(
      "historical-workspace",
      "historical-project",
      "2026-01-03T00:59:59.999Z"
    );
    expect(expired.map((record) => record.pendingUploadId)).toEqual(["historical-unbound"]);
    expect(
      attachments.markExpired(
        "historical-workspace",
        "historical-project",
        "historical-pending",
        "2026-01-03T00:59:59.999Z",
        "a".repeat(64)
      )
    ).toBe(false);
    expect(
      attachments.markExpired(
        "historical-workspace",
        "historical-project",
        "historical-unbound",
        "2026-01-03T00:59:59.999Z",
        "b".repeat(64)
      )
    ).toBe(true);
    expect(
      database
        .prepare(
          "SELECT * FROM comment_pending_uploads WHERE pending_upload_id='historical-pending'"
        )
        .get()
    ).toMatchObject({
      pending_upload_id: "historical-pending",
      status: "finalized",
      file_name: "historical.txt",
      comment_id: null,
      digest_sha256: "a".repeat(64),
      binding_provenance_version: 0
    });
    expect(database.prepare("SELECT * FROM comment_attachment_bindings").get()).toMatchObject({
      comment_id: "historical-comment",
      digest_sha256: "a".repeat(64),
      file_name: "historical.txt",
      pending_upload_ids_json: "[]"
    });
  });

  it("migrates uniquely mapped rows and quarantines ambiguous project-only rows", async () => {
    const database = await openDatabase();
    const workspaces = new WorkspaceIdentityRepository(database);
    workspaces.ensureConfiguredWorkspace("workspace-one");
    workspaces.ensureConfiguredWorkspace("workspace-two");
    workspaces.ensureConfiguredWorkspace("workspace-three");
    registerProject(database, "workspace-one", "project-unique");
    registerProject(database, "workspace-two", "project-ambiguous");
    registerProject(database, "workspace-three", "project-ambiguous");
    insertLegacyPending(database, "pending-unique", "project-unique");
    insertLegacyPending(database, "pending-ambiguous", "project-ambiguous");
    insertLegacyBinding(database, "project-unique", "comment-unique");
    insertLegacyBinding(database, "project-ambiguous", "comment-ambiguous", "b".repeat(64));

    database.exec(`UPDATE comment_pending_uploads SET status='finalized',digest_sha256='${"c".repeat(64)}',finalized_at='2026-01-01T00:30:00.000Z' WHERE pending_upload_id='pending-ambiguous';
      INSERT INTO comment_attachment_blobs(digest_sha256,size_bytes,media_type,relative_path,created_at) VALUES
      ('${"b".repeat(64)}',1,'text/plain','bb/${"b".repeat(64)}','2026-01-01T00:00:00.000Z'),
      ('${"c".repeat(64)}',1,'text/plain','cc/${"c".repeat(64)}','2026-01-01T00:00:00.000Z');`);
    attachmentWorkspaceScopeMigration.before?.(database);
    const attachments = new CommentAttachmentRepository(database);
    expect(attachments.listUnreferencedBlobDigests(100, "2026-01-01T23:59:59.999Z")).toEqual([]);
    expect(attachments.listUnreferencedBlobDigests(100, "2026-01-02T00:00:00.000Z")).toEqual([
      "c".repeat(64)
    ]);
    expect(attachments.canDeleteBlob("b".repeat(64), "2026-01-03T00:00:00.000Z")).toBe(false);
    expect(attachments.canDeleteBlob("c".repeat(64), "2026-01-02T00:00:00.000Z")).toBe(true);
    database.exec(`UPDATE comment_pending_uploads_unscoped_legacy
      SET payload_json=json_remove(payload_json,'$.expiresAt') WHERE pending_upload_id='pending-ambiguous'`);
    expect(() => attachments.canDeleteBlob("c".repeat(64), "2026-01-02T00:00:00.000Z")).toThrow();

    expect(
      database
        .prepare(
          "SELECT workspace_id FROM comment_pending_uploads WHERE project_id=? AND pending_upload_id=?"
        )
        .get("project-unique", "pending-unique")
    ).toMatchObject({ workspace_id: "workspace-one" });
    expect(
      database
        .prepare("SELECT 1 FROM comment_pending_uploads WHERE pending_upload_id=?")
        .get("pending-ambiguous")
    ).toBeUndefined();
    expect(
      database
        .prepare(
          "SELECT project_id FROM comment_pending_uploads_unscoped_legacy WHERE pending_upload_id=?"
        )
        .get("pending-ambiguous")
    ).toMatchObject({ project_id: "project-ambiguous" });
    expect(
      database
        .prepare(
          "SELECT workspace_id FROM comment_attachment_bindings WHERE project_id=? AND comment_id=?"
        )
        .get("project-unique", "comment-unique")
    ).toMatchObject({ workspace_id: "workspace-one" });
    expect(
      database
        .prepare("SELECT 1 FROM comment_attachment_bindings WHERE comment_id=?")
        .get("comment-ambiguous")
    ).toBeUndefined();
    expect(
      database
        .prepare(
          "SELECT project_id FROM comment_attachment_bindings_unscoped_legacy WHERE comment_id=?"
        )
        .get("comment-ambiguous")
    ).toMatchObject({ project_id: "project-ambiguous" });
  });
});
