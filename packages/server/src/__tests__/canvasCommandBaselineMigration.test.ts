import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CANVAS_COMMAND_PROTOCOL_VERSION } from "@planweave-ai/collaboration-protocol/core/limits";
import {
  exampleAuthoritativeContentVersion,
  exampleCompleteContentVersion
} from "@planweave-ai/collaboration-protocol/fixtures/content-version";
import { type AuthoritativeContentHead } from "@planweave-ai/collaboration-protocol/content/version";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { applyMigrations, latestCentralSchemaVersion } from "../migrations.js";
import { migrations } from "../migrations/registry.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { CanvasCommandRepository } from "../canvas/repository.js";
import { createDefaultCanvasRuntimePort } from "../canvas/runtimePort.js";
import { ContentVersionRepository } from "../canvas/contentVersionRepository.js";
import { CanvasCommandService } from "../canvas/service.js";
import type { ContentAuthorityStore } from "../canvas/contentAuthorityStore.js";
import type { CanvasRuntimeMutationPort } from "../canvas/runtimePort.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";

function applyThrough(database: SqliteDatabase, throughVersion: number): void {
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
        .run(migration.version, "2026-08-01T00:00:00.000Z");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      if (migration.disableForeignKeys) database.exec("PRAGMA foreign_keys = ON");
    }
  }
}

describe("canvas command baseline migration", () => {
  it("upgrades v41 snapshots only when their immutable content reference is recoverable", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    const workspace = await createTestWorkspace();
    try {
      applyThrough(database, 41);
      const scope = { workspaceId: "workspace", projectId: "project", canvasId: "default" };
      const contentVersions = new ContentVersionRepository(
        database,
        () => new Date("2026-08-02T00:00:00.000Z")
      );
      const runtime = createDefaultCanvasRuntimePort();
      if (!runtime.captureContent) throw new Error("capture unavailable");
      const captured = await runtime.captureContent({
        projectRoot: workspace.root,
        canvasId: "default",
        expectedPackageDir: workspace.init.workspace.packageDir,
        authorityProjectId: scope.projectId
      });
      if (!captured.ok) throw new Error(captured.detail);
      const version = contentVersions.persistImmutable({
        scope,
        content: captured.content,
        createdBy: { kind: "human", id: "owner" }
      });
      const insert = database.prepare(
        `INSERT INTO canvas_command_snapshots(
           workspace_id,project_id,canvas_id,revision,content_digest,created_at,
           package_snapshot_id,digest_manifest_json,size_bytes,encoding,integrity
         ) VALUES(?,?,?,?,?,?,NULL,NULL,?,'digest_manifest_only','verified')`
      );
      insert.run(
        ...Object.values(scope),
        1,
        version.completed.canonicalDigest,
        "2026-08-02T00:00:00.000Z",
        version.content.totalBytes
      );
      insert.run(...Object.values(scope), 2, "d".repeat(64), "2026-08-02T00:00:00.000Z", 1);
      applyMigrations(database);
      expect(
        database
          .prepare(
            `SELECT revision,content_digest,encoding FROM canvas_command_snapshots
             WHERE workspace_id=? AND project_id=? AND canvas_id=? ORDER BY revision`
          )
          .all(...Object.values(scope))
      ).toEqual([
        {
          revision: 1,
          content_digest: version.completed.canonicalDigest,
          encoding: "content_version_ref"
        }
      ]);
    } finally {
      database.close();
      await rm(workspace.home, { recursive: true, force: true });
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it("marks legacy nondeterministic layout journals for an authoritative baseline rebuild", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    try {
      applyThrough(database, 40);
      const scope = ["workspace", "project", "default"] as const;
      const digest = "a".repeat(64);
      const intent = { kind: "update_layout", nodes: [{ nodeId: "T-001", x: 1, y: 2 }] };
      const entry = {
        schemaVersion: "canvas-journal/v1",
        entryId: "journal-legacy",
        scope: { workspaceId: scope[0], projectId: scope[1], canvasId: scope[2] },
        revision: 1,
        previousRevision: 0,
        operationId: "op-legacy",
        intent,
        intentDigest: "b".repeat(64),
        contentDigest: digest,
        actor: { kind: "human", id: "owner" },
        acceptedAt: "2026-08-01T15:44:27.373Z"
      };
      database
        .prepare(
          `INSERT INTO canvas_command_heads(
             workspace_id,project_id,canvas_id,revision,content_digest,updated_at
           ) VALUES(?,?,?,?,?,?)`
        )
        .run(...scope, 1, digest, entry.acceptedAt);
      database
        .prepare(
          `INSERT INTO canvas_command_journal(
             workspace_id,project_id,canvas_id,entry_id,revision,previous_revision,operation_id,
             intent_json,intent_digest,content_digest,actor_kind,actor_id,actor_display_name,
             accepted_at,entry_json
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          ...scope,
          entry.entryId,
          entry.revision,
          entry.previousRevision,
          entry.operationId,
          JSON.stringify(intent),
          entry.intentDigest,
          entry.contentDigest,
          entry.actor.kind,
          entry.actor.id,
          null,
          entry.acceptedAt,
          JSON.stringify(entry)
        );

      applyMigrations(database);

      expect(latestCentralSchemaVersion).toBe(50);
      expect(
        database
          .prepare(
            `SELECT source_revision,status,reason FROM canvas_command_baseline_rebases
             WHERE workspace_id=? AND project_id=? AND canvas_id=?`
          )
          .get(...scope)
      ).toEqual({
        source_revision: 1,
        status: "pending",
        reason: "legacy_nondeterministic_layout"
      });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM canvas_command_journal
             WHERE workspace_id=? AND project_id=? AND canvas_id=?`
          )
          .get(...scope)?.count
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it("atomically archives the legacy replay chain and installs a verified replacement baseline", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    try {
      applyMigrations(database);
      const scope = {
        workspaceId: "workspace",
        projectId: "project",
        canvasId: "default"
      };
      const oldDigest = "a".repeat(64);
      const replacementDigest = "c".repeat(64);
      const at = "2026-08-01T15:44:27.373Z";
      const intent = { kind: "update_layout", nodes: [{ nodeId: "T-001", x: 1, y: 2 }] };
      const entry = {
        schemaVersion: "canvas-journal/v1",
        entryId: "journal-legacy",
        scope,
        revision: 1,
        previousRevision: 0,
        operationId: "op-legacy",
        intent,
        intentDigest: "b".repeat(64),
        contentDigest: oldDigest,
        actor: { kind: "human", id: "owner" },
        acceptedAt: at
      };
      database
        .prepare(
          `INSERT INTO canvas_command_heads(
             workspace_id,project_id,canvas_id,revision,content_digest,updated_at
           ) VALUES(?,?,?,?,?,?)`
        )
        .run(scope.workspaceId, scope.projectId, scope.canvasId, 1, oldDigest, at);
      database
        .prepare(
          `INSERT INTO canvas_command_journal(
             workspace_id,project_id,canvas_id,entry_id,revision,previous_revision,operation_id,
             intent_json,intent_digest,content_digest,actor_kind,actor_id,actor_display_name,
             accepted_at,entry_json
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          scope.workspaceId,
          scope.projectId,
          scope.canvasId,
          entry.entryId,
          1,
          0,
          entry.operationId,
          JSON.stringify(intent),
          entry.intentDigest,
          oldDigest,
          "human",
          "owner",
          null,
          at,
          JSON.stringify(entry)
        );
      database
        .prepare(
          `INSERT INTO canvas_command_operations(
             workspace_id,project_id,canvas_id,operation_id,intent_digest,intent_json,outcome_json,
             accepted,revision,journal_entry_id,created_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          scope.workspaceId,
          scope.projectId,
          scope.canvasId,
          entry.operationId,
          entry.intentDigest,
          JSON.stringify(intent),
          JSON.stringify({ legacy: true }),
          1,
          1,
          entry.entryId,
          at
        );
      database
        .prepare(
          `INSERT INTO canvas_command_snapshots(
             workspace_id,project_id,canvas_id,revision,content_digest,created_at,
             package_snapshot_id,digest_manifest_json,size_bytes,encoding,integrity
           ) VALUES(?,?,?,?,?,?,NULL,?,?,?,?)`
        )
        .run(
          scope.workspaceId,
          scope.projectId,
          scope.canvasId,
          1,
          oldDigest,
          at,
          JSON.stringify({
            manifest: { digestSha256: oldDigest, sizeBytes: 10 },
            prompts: [],
            totalBytes: 10
          }),
          10,
          "content_version_ref",
          "verified"
        );
      database
        .prepare(
          `INSERT INTO canvas_command_pending(
             workspace_id,project_id,canvas_id,operation_id,expected_revision,intent_json,
             intent_digest,actor_kind,actor_id,actor_display_name,reserved_at,status
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          scope.workspaceId,
          scope.projectId,
          scope.canvasId,
          "op-pending",
          1,
          JSON.stringify(intent),
          entry.intentDigest,
          "human",
          "owner",
          null,
          at,
          "needs_recovery"
        );
      database
        .prepare(
          `INSERT INTO canvas_command_baseline_rebases(
             workspace_id,project_id,canvas_id,source_revision,source_content_digest,
             status,reason,detected_at
           ) VALUES(?,?,?,?,?,'pending','legacy_nondeterministic_layout',?)`
        )
        .run(scope.workspaceId, scope.projectId, scope.canvasId, 1, oldDigest, at);
      database
        .prepare(
          `INSERT INTO canvas_command_operation_retention_scopes(
             workspace_id,project_id,canvas_id,high_water_sequence,retained_from_sequence,
             status,failure_code,updated_at
           ) VALUES(?,?,?,5,1,'reconciling',NULL,?)`
        )
        .run(scope.workspaceId, scope.projectId, scope.canvasId, at);

      const repository = new CanvasCommandRepository(database, {
        clock: () => new Date("2026-08-02T00:00:00.000Z")
      });
      const digestManifest = {
        manifest: { digestSha256: replacementDigest, sizeBytes: 12 },
        prompts: [],
        totalBytes: 12
      };
      const first = repository.completeLegacyBaselineRebase(scope, {
        contentDigest: replacementDigest,
        digestManifest,
        sizeBytes: 12
      });
      const replay = repository.completeLegacyBaselineRebase(scope, {
        contentDigest: replacementDigest,
        digestManifest,
        sizeBytes: 12
      });

      expect(first).toEqual(replay);
      expect(first).toMatchObject({ revision: 1, contentDigest: replacementDigest });
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM canvas_command_journal").get()?.count
      ).toBe(0);
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM canvas_command_operations").get()?.count
      ).toBe(0);
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM canvas_command_pending").get()?.count
      ).toBe(0);
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM canvas_command_legacy_archive").get()?.count
      ).toBe(4);
      expect(repository.isLegacyOperationArchived(scope, entry.operationId)).toBe(true);
      expect(repository.getOperation(scope, entry.operationId)).toBeUndefined();
      expect(
        database
          .prepare(
            `SELECT high_water_sequence,retained_from_sequence,status
               FROM canvas_command_operation_retention_scopes
              WHERE workspace_id=? AND project_id=? AND canvas_id=?`
          )
          .get(scope.workspaceId, scope.projectId, scope.canvasId)
      ).toEqual({ high_water_sequence: 5, retained_from_sequence: 6, status: "ready" });
      expect(
        database
          .prepare(
            `SELECT revision,content_digest,integrity FROM canvas_command_snapshots
             WHERE workspace_id=? AND project_id=? AND canvas_id=?`
          )
          .get(scope.workspaceId, scope.projectId, scope.canvasId)
      ).toEqual({ revision: 1, content_digest: replacementDigest, integrity: "verified" });
      expect(
        database
          .prepare(
            `SELECT status,replacement_content_digest
             FROM canvas_command_baseline_rebases
             WHERE workspace_id=? AND project_id=? AND canvas_id=?`
          )
          .get(scope.workspaceId, scope.projectId, scope.canvasId)
      ).toEqual({
        status: "completed",
        replacement_content_digest: replacementDigest
      });
    } finally {
      database.close();
    }
  });

  it.each([
    {
      name: "rebuilds from authoritative content before reconnect despite local digest drift",
      action: "reconnect",
      authorityAvailable: true
    },
    {
      name: "rebuilds from authoritative content before submit despite local digest drift",
      action: "submit",
      authorityAvailable: true
    },
    {
      name: "preserves the legacy journal when authoritative content is unavailable",
      action: "reconnect",
      authorityAvailable: false
    }
  ])("$name", async ({ action, authorityAvailable }) => {
    const workspace = await createTestWorkspace();
    const database = await openServerDatabase(":memory:", 5_000);
    try {
      applyMigrations(database);
      database.exec(`
        INSERT INTO workspaces(workspace_id,display_name,created_at)
          VALUES ('workspace','Workspace','2026-08-01T00:00:00.000Z');
        INSERT INTO workspace_principals(
          workspace_id,human_principal_id,display_name,created_at,revoked_at
        ) VALUES ('workspace','owner','Owner','2026-08-01T00:00:00.000Z',NULL);
        INSERT INTO workspace_memberships(
          workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at
        ) VALUES (
          'workspace','membership-owner','owner','owner',1,
          '2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z',NULL
        );
        INSERT INTO legacy_project_workspace_mappings(
          legacy_project_id,normalized_legacy_project_identity,workspace_id,mapped_at
        ) VALUES ('project','legacy-project:project','workspace','2026-08-01T00:00:00.000Z');
      `);
      const access = new ProjectAccessRepository(database);
      access.registerProjectInternal({
        workspaceId: "workspace",
        projectId: "project",
        projectRoot: workspace.root,
        ownerHumanPrincipalId: "owner"
      });
      access.registerCanvasInternal({
        workspaceId: "workspace",
        projectId: "project",
        canvasId: "default",
        packageDir: workspace.init.workspace.packageDir,
        visibility: "private",
        ownerHumanPrincipalId: "owner"
      });
      access.markCanvasCutover("workspace", "project", "default");
      access.finalizeProjectCutover("workspace", "project");

      const scope = { workspaceId: "workspace", projectId: "project", canvasId: "default" };
      const oldDigest = "a".repeat(64);
      const replacementDigest = exampleCompleteContentVersion.canonicalDigest;
      const acceptedAt = "2026-08-01T15:44:27.373Z";
      const intent = { kind: "update_layout", nodes: [{ nodeId: "T-001", x: 1, y: 2 }] };
      const intentDigest = "b".repeat(64);
      const entry = {
        schemaVersion: "canvas-journal/v1",
        entryId: "journal-legacy",
        scope,
        revision: 1,
        previousRevision: 0,
        operationId: "op-legacy",
        intent,
        intentDigest,
        contentDigest: oldDigest,
        actor: { kind: "human", id: "owner" },
        acceptedAt
      };
      database
        .prepare(
          `INSERT INTO canvas_command_heads(
             workspace_id,project_id,canvas_id,revision,content_digest,updated_at
           ) VALUES(?,?,?,?,?,?)`
        )
        .run(scope.workspaceId, scope.projectId, scope.canvasId, 1, oldDigest, acceptedAt);
      database
        .prepare(
          `INSERT INTO canvas_command_operations(
             workspace_id,project_id,canvas_id,operation_id,intent_digest,intent_json,outcome_json,
             accepted,revision,journal_entry_id,created_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          scope.workspaceId,
          scope.projectId,
          scope.canvasId,
          entry.operationId,
          intentDigest,
          JSON.stringify(intent),
          JSON.stringify({ legacy: true }),
          1,
          1,
          entry.entryId,
          acceptedAt
        );
      database
        .prepare(
          `INSERT INTO canvas_command_journal(
             workspace_id,project_id,canvas_id,entry_id,revision,previous_revision,operation_id,
             intent_json,intent_digest,content_digest,actor_kind,actor_id,actor_display_name,
             accepted_at,entry_json
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          scope.workspaceId,
          scope.projectId,
          scope.canvasId,
          entry.entryId,
          1,
          0,
          entry.operationId,
          JSON.stringify(intent),
          intentDigest,
          oldDigest,
          "human",
          "owner",
          null,
          acceptedAt,
          JSON.stringify(entry)
        );
      database
        .prepare(
          `INSERT INTO canvas_command_baseline_rebases(
             workspace_id,project_id,canvas_id,source_revision,source_content_digest,
             status,reason,detected_at
           ) VALUES(?,?,?,?,?,'pending','legacy_nondeterministic_layout',?)`
        )
        .run(scope.workspaceId, scope.projectId, scope.canvasId, 1, oldDigest, acceptedAt);

      const runtime: CanvasRuntimeMutationPort = {
        async apply() {
          throw new Error("not called");
        },
        async readDigest() {
          throw new Error("local runtime digest must not gate authoritative baseline migration");
        }
      };
      const authorityHead: AuthoritativeContentHead = {
        schemaVersion: "content-version/v1",
        scope,
        revision: 1,
        content: {
          versionId: `version-${replacementDigest}`,
          canonicalDigest: replacementDigest,
          verification: "complete"
        },
        advancedAt: acceptedAt
      };
      const contentVersions: ContentAuthorityStore = {
        head: () => authorityHead,
        persistImmutable: () => {
          throw new Error("not called");
        },
        readVersion: () => {
          if (!authorityAvailable) throw new Error("content_version_not_found");
          return {
            ...exampleAuthoritativeContentVersion,
            scope,
            content: exampleCompleteContentVersion,
            completed: authorityHead.content
          };
        },
        publishInitial: () => {
          throw new Error("not called");
        },
        acknowledge: () => {
          throw new Error("not called");
        },
        discoverAuthority: () => {
          throw new Error("not called");
        }
      };
      const repository = new CanvasCommandRepository(database, {
        clock: () => new Date("2026-08-02T00:00:00.000Z")
      });
      const service = new CanvasCommandService({
        repository,
        access,
        workspaceIdentity: new WorkspaceIdentityRepository(database),
        runtime,
        contentVersions
      });

      const actor = {
        humanPrincipalId: "owner",
        displayName: "Owner",
        deviceCredentialId: "device-owner",
        projectId: "project",
        role: "owner" as const,
        membershipId: "membership-owner"
      };
      const response =
        action === "reconnect"
          ? await service.reconnect(actor, {
              type: "canvas.reconnect.request",
              protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
              schemaVersion: "canvas-command/v1",
              projectId: "project",
              canvasId: "default",
              afterRevision: 1,
              afterContentDigest: oldDigest
            })
          : await service.submit(actor, {
              type: "canvas.command.submit",
              protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
              schemaVersion: "canvas-command/v1",
              projectId: "project",
              canvasId: "default",
              operationId: "op-legacy",
              expectedRevision: 0,
              intent: {
                kind: "update_task_prompt",
                taskId: "T-001",
                promptMarkdown: "# changed"
              }
            });

      if (authorityAvailable) {
        expect(response).toMatchObject(
          action === "reconnect"
            ? {
                type: "canvas.reconnect.snapshot",
                reason: "digest_mismatch",
                snapshot: { metadata: { revision: 1, contentDigest: replacementDigest } }
              }
            : {
                type: "canvas.command.rejected",
                code: "stale_revision",
                conflict: { expectedRevision: 0, authoritativeRevision: 1 }
              }
        );
        expect(repository.legacyBaselineRebase(scope)).toMatchObject({
          status: "completed",
          replacementContentDigest: replacementDigest
        });
      } else {
        expect(response).toMatchObject({
          type: "canvas.reconnect.error",
          code: "server_error",
          detail: "canvas_baseline_rebase_authority_unavailable"
        });
        expect(repository.legacyBaselineRebase(scope)).toMatchObject({
          status: "pending",
          replacementContentDigest: null
        });
        expect(repository.head(scope)).toMatchObject({ revision: 1, contentDigest: oldDigest });
        expect(repository.listJournalAfter(scope, 0)).toHaveLength(1);
      }
    } finally {
      database.close();
      await rm(workspace.home, { recursive: true, force: true });
      await rm(workspace.root, { recursive: true, force: true });
    }
  });
});
