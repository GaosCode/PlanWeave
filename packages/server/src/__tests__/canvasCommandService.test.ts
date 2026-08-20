import { describe, expect, it } from "vitest";
import { CANVAS_COMMAND_PROTOCOL_VERSION } from "@planweave-ai/collaboration-protocol/core/limits";
import {
  canvasCommandRejectedSchema,
  type CanvasCommandAccepted,
  type CanvasCommandIntent,
  type CanvasJournalEntry
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import { ContentVersionService } from "../canvas/index.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { latestCentralSchemaVersion } from "../migrations.js";
import { inWriteTransaction } from "../sqlite.js";
import {
  actor,
  canvasCommandServiceFixture as fixture,
  submitBody
} from "./support/canvasCommandServiceFixture.js";

describe("canvas command service (OSS-004 B-002)", () => {
  it("submits and reconnects without resolving a bound package path", async () => {
    const { service, database } = await fixture();
    database.exec(
      "UPDATE project_registry SET project_root_internal=NULL; UPDATE canvas_registry SET package_dir_internal=NULL"
    );

    const accepted = await service.submit(actor("owner"), submitBody("op-no-package-path", 0));
    expect(accepted).toMatchObject({ type: "canvas.command.accepted", revision: 1 });

    const reconnect = await service.reconnect(actor("editor"), {
      type: "canvas.reconnect.request",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      projectId: "p",
      canvasId: "default",
      afterRevision: 0
    });
    expect(reconnect.type).toBe("canvas.reconnect.snapshot");
  });

  it("migrates v30 and enforces CAS + operationId idempotency", async () => {
    const { service, repository, database } = await fixture();
    expect(latestCentralSchemaVersion).toBe(50);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='canvas_command_journal'"
        )
        .get()?.name
    ).toBe("canvas_command_journal");

    const first = await service.submit(actor("owner"), submitBody("op-1", 0));
    expect(first.type).toBe("canvas.command.accepted");
    if (first.type !== "canvas.command.accepted") throw new Error("expected accept");
    expect(first).toMatchObject({
      revision: 1,
      previousRevision: 0,
      idempotentReplay: false
    });

    const replay = await service.submit(actor("owner"), submitBody("op-1", 0));
    expect(replay.type).toBe("canvas.command.accepted");
    if (replay.type !== "canvas.command.accepted") throw new Error("expected replay");
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.revision).toBe(first.revision);
    expect(replay.journalEntryId).toBe(first.journalEntryId);
    expect(
      database
        .prepare(
          `SELECT high_water_sequence FROM canvas_command_operation_retention_scopes
            WHERE workspace_id='w' AND project_id='p' AND canvas_id='default'`
        )
        .get()?.high_water_sequence
    ).toBe(1);

    const conflict = await service.submit(
      actor("owner"),
      submitBody("op-1", 1, {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "# different intent"
      })
    );
    expect(conflict).toMatchObject({ type: "canvas.command.rejected", code: "operation_conflict" });

    const stale = await service.submit(actor("owner"), submitBody("op-2", 0));
    expect(stale).toMatchObject({
      type: "canvas.command.rejected",
      code: "stale_revision",
      conflict: { expectedRevision: 0, authoritativeRevision: 1 }
    });

    const second = await service.submit(actor("editor"), submitBody("op-2", 1));
    expect(second.type).toBe("canvas.command.accepted");
    expect(
      repository.head({ workspaceId: "w", projectId: "p", canvasId: "default" }).revision
    ).toBe(2);
  });

  it("treats an evicted operation as unseen and re-runs CAS before possible execution", async () => {
    const { service, repository, database } = await fixture();
    const first = await service.submit(actor("owner"), submitBody("op-evicted", 0));
    expect(first).toMatchObject({ type: "canvas.command.accepted", revision: 1 });
    const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
    inWriteTransaction(database, () => {
      for (let index = 0; index < 10_000; index += 1) {
        const operationId = `filler-${index}`;
        repository.operationRetention.recordTerminalInCallerTransaction({
          scope,
          operationId,
          intentDigest: "f".repeat(64),
          outcome: canvasCommandRejectedSchema.parse({
            type: "canvas.command.rejected",
            protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
            schemaVersion: "canvas-command/v1",
            projectId: "p",
            canvasId: "default",
            operationId,
            code: "invalid_command"
          }),
          createdAt: "2026-08-15T00:00:00.000Z"
        });
      }
    });

    await expect(
      service.submit(
        actor("owner"),
        submitBody("op-evicted", 0, {
          kind: "update_task_prompt",
          taskId: "T-001",
          promptMarkdown: "# different after eviction"
        })
      )
    ).resolves.toMatchObject({
      type: "canvas.command.rejected",
      code: "stale_revision",
      conflict: { expectedRevision: 0, authoritativeRevision: 1 }
    });
    const reconsidered = await service.submit(actor("owner"), submitBody("op-evicted", 1));
    expect(reconsidered).toMatchObject({ type: "canvas.command.rejected" });
    if (reconsidered.type !== "canvas.command.rejected") throw new Error("expected validation");
    expect(reconsidered.code).toBe("journal_unavailable");
  });

  it("replays a cached terminal rejection and conflicts on a different digest", async () => {
    const { service, database } = await fixture();
    const invalid = submitBody("op-invalid-replay", 0, {
      kind: "update_task_prompt",
      taskId: "missing-task",
      promptMarkdown: "# invalid"
    });
    const first = await service.submit(actor("owner"), invalid);
    const replay = await service.submit(actor("owner"), invalid);
    const conflict = await service.submit(
      actor("owner"),
      submitBody("op-invalid-replay", 0, {
        kind: "update_task_prompt",
        taskId: "another-missing-task",
        promptMarkdown: "# invalid"
      })
    );

    expect(first).toMatchObject({ type: "canvas.command.rejected", code: "invalid_command" });
    expect(replay).toEqual(first);
    expect(conflict).toMatchObject({
      type: "canvas.command.rejected",
      code: "operation_conflict"
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM canvas_command_operation_receipts").get()
        ?.count
    ).toBe(1);
  });

  it("rejects a stale intent base content digest before it can advance authority", async () => {
    const { service, repository } = await fixture();
    const outcome = await service.submit(
      actor("owner"),
      submitBody("op-base-digest", 0, {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "# stale base\n",
        baseContentDigest: "f".repeat(64)
      })
    );
    expect(outcome).toMatchObject({
      type: "canvas.command.rejected",
      code: "operation_conflict",
      detail: "base_content_digest_mismatch"
    });
    expect(
      repository.head({ workspaceId: "w", projectId: "p", canvasId: "default" }).revision
    ).toBe(0);
  });

  it("rejects mixed bulk base content digests without advancing either head", async () => {
    const { service, repository, contentVersions } = await fixture();
    const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
    const current = contentVersions.head(scope);
    if (!current) throw new Error("expected initial content head");
    const outcome = await service.submit(
      actor("owner"),
      submitBody("op-bulk-mixed-digest", 0, {
        kind: "bulk_update_blocks",
        updates: [
          {
            blockRef: "T-001#B-001",
            fields: { title: "Current", baseContentDigest: current.content.canonicalDigest }
          },
          {
            blockRef: "T-001#B-001",
            fields: { title: "Stale", baseContentDigest: "f".repeat(64) }
          }
        ]
      })
    );
    expect(outcome).toMatchObject({
      type: "canvas.command.rejected",
      code: "operation_conflict",
      detail: "base_content_digest_mismatch"
    });
    expect(repository.head(scope).revision).toBe(0);
    expect(contentVersions.head(scope)?.revision).toBe(1);
  });

  it("rolls back content and canvas visibility when the atomic commit fails after content head advance", async () => {
    const published: CanvasJournalEntry[] = [];
    const { database, service, repository, contentVersions } = await fixture({
      onAcceptedInCallerTransaction: () => {
        throw new Error("forced_commit_failure");
      },
      onAcceptedEntry: (entry) => published.push(entry),
      onAcceptedEntryUnavailable: () => {
        throw new Error("observer must not publish a rolled back command");
      }
    });
    const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
    const beforeContent = contentVersions.head(scope);
    const outcome = await service.submit(
      actor("owner"),
      submitBody("op-rollback-after-content", 0)
    );
    expect(outcome).toMatchObject({ type: "canvas.command.rejected", code: "journal_unavailable" });
    expect(contentVersions.head(scope)).toEqual(beforeContent);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM canvas_content_journal").get()?.count
    ).toBe(1);
    expect(repository.head(scope).revision).toBe(0);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM canvas_command_journal").get()?.count
    ).toBe(0);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM canvas_command_operation_receipts").get()
        ?.count
    ).toBe(0);
    expect(published).toEqual([]);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM canvas_content_versions").get()?.count
    ).toBe(2);
  });

  it("serializes concurrent writers so only one CAS winner advances revision", async () => {
    const { service } = await fixture();
    const firstPromise = service.submit(
      actor("owner"),
      submitBody("op-a", 0, {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "A"
      })
    );
    const secondPromise = service.submit(
      actor("editor"),
      submitBody("op-b", 0, {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "B"
      })
    );
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    const accepted = [first, second].filter((item) => item.type === "canvas.command.accepted");
    const rejected = [first, second].filter((item) => item.type === "canvas.command.rejected");
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ code: "stale_revision" });
  });

  it("rejects viewer writes and ACL-revoked editors", async () => {
    const { service, access, database } = await fixture();
    const viewerDenied = await service.submit(actor("viewer"), submitBody("op-viewer", 0));
    expect(viewerDenied).toMatchObject({
      type: "canvas.command.rejected",
      code: "forbidden",
      detail: "canvas_write_denied"
    });

    const row = database
      .prepare(
        `SELECT grant_id FROM project_access_grants
         WHERE human_principal_id='editor' AND scope_kind='canvas' AND revoked_at IS NULL`
      )
      .get() as { grant_id: string };
    const canvasAcl = database
      .prepare(
        `SELECT acl_revision FROM canvas_registry WHERE workspace_id='w' AND project_id='p' AND canvas_id='default'`
      )
      .get() as { acl_revision: number };
    access.revoke({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      grantId: row.grant_id,
      actor: { kind: "human", id: "owner" },
      expectedAclRevision: Number(canvasAcl.acl_revision)
    });
    const afterRevoke = await service.submit(actor("editor"), submitBody("op-revoked", 0));
    expect(afterRevoke).toMatchObject({ type: "canvas.command.rejected", code: "forbidden" });
  });

  it("commits immutable content and both authority heads in one accepted transaction", async () => {
    const acceptedCommits: CanvasCommandAccepted[] = [];
    const { database, access, repository, service, contentVersions } = await fixture({
      onAcceptedInCallerTransaction: (accepted) => acceptedCommits.push(accepted)
    });
    if (!contentVersions) throw new Error("content version fixture unavailable");
    const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
    const intent: CanvasCommandIntent = {
      kind: "update_task_prompt",
      taskId: "T-001",
      promptMarkdown: "# recovered authoritative prompt\n"
    };
    const accepted = await service.submit(
      actor("owner"),
      submitBody("op-content-authority", 0, intent)
    );
    expect(accepted).toMatchObject({ type: "canvas.command.accepted", revision: 1 });
    const canvasHead = repository.head(scope);
    const contentHead = contentVersions.head(scope);
    expect(canvasHead).toMatchObject({ revision: 1 });
    expect(contentHead).toMatchObject({ revision: 2 });
    if (!contentHead) throw new Error("content head missing");
    expect(canvasHead.contentDigest).toBe(contentHead.content.canonicalDigest);
    expect(contentVersions.journalAfter(scope, 1)).toEqual([
      expect.objectContaining({ revision: 2, content: contentHead.content })
    ]);
    expect(repository.getOperation(scope, "op-content-authority")?.outcome).toMatchObject({
      type: "canvas.command.accepted",
      contentDigest: contentHead.content.canonicalDigest
    });
    expect(acceptedCommits).toEqual([
      expect.objectContaining({
        scope,
        operationId: "op-content-authority",
        revision: 1,
        contentDigest: contentHead.content.canonicalDigest
      })
    ]);

    const fetched = new ContentVersionService({
      repository: contentVersions,
      access,
      workspaceIdentity: new WorkspaceIdentityRepository(database)
    }).fetch(actor("editor"), {
      projectId: "p",
      canvasId: "default",
      content: contentHead.content
    });
    expect(fetched.completed).toEqual(contentHead.content);
  });
});
