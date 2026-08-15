import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { CANVAS_COMMAND_PROTOCOL_VERSION } from "@planweave-ai/collaboration-protocol/core/limits";
import {
  canvasCommandRejectedSchema,
  canvasCommandServerMessageSchema,
  type CanvasCommandAccepted,
  type CanvasCommandIntent,
  type CanvasJournalEntry
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import {
  CanvasCommandService,
  ContentVersionService,
  createDefaultCanvasRuntimePort,
  canvasCommandOutcomeHttpStatus,
  digestCanvasIntent,
  routeCanvasCommandHttp,
  type CanvasRuntimeMutationPort
} from "../canvas/index.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { latestCentralSchemaVersion } from "../migrations.js";
import { inWriteTransaction } from "../sqlite.js";
import {
  actor,
  canvasCommandServiceFixture as fixture,
  digestOf,
  fakeRuntime,
  submitBody
} from "./support/canvasCommandServiceFixture.js";

describe("canvas command service (OSS-004 B-002)", () => {
  it("publishes one complete journal entry only after a durable non-idempotent accept", async () => {
    const published: CanvasJournalEntry[] = [];
    const { service } = await fixture({
      onAcceptedEntry: (entry) => published.push(entry),
      onAcceptedEntryUnavailable: () => {}
    });

    const accepted = await service.submit(actor("editor"), submitBody("op-live-1", 0));
    expect(accepted).toMatchObject({ type: "canvas.command.accepted", revision: 1 });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      revision: 1,
      previousRevision: 0,
      operationId: "op-live-1",
      scope: { workspaceId: "w", projectId: "p", canvasId: "default" }
    });

    const replay = await service.submit(actor("editor"), submitBody("op-live-1", 0));
    const viewerDenied = await service.submit(actor("viewer"), submitBody("op-live-viewer", 1));
    const stale = await service.submit(actor("editor"), submitBody("op-live-stale", 0));
    expect(replay).toMatchObject({ type: "canvas.command.accepted", idempotentReplay: true });
    expect(viewerDenied).toMatchObject({ type: "canvas.command.rejected", code: "forbidden" });
    expect(stale).toMatchObject({ type: "canvas.command.rejected", code: "stale_revision" });
    expect(published).toHaveLength(1);
  });

  it("publishes strictly increasing revisions for consecutive accepted commits", async () => {
    const published: CanvasJournalEntry[] = [];
    const { service } = await fixture({
      onAcceptedEntry: (entry) => published.push(entry),
      onAcceptedEntryUnavailable: () => {}
    });

    await service.submit(actor("owner"), submitBody("op-live-order-1", 0));
    await service.submit(actor("editor"), submitBody("op-live-order-2", 1));

    expect(published.map((entry) => entry.revision)).toEqual([1, 2]);
    expect(published.map((entry) => entry.previousRevision)).toEqual([0, 1]);
  });

  it("does not publish when the durable journal commit fails", async () => {
    const published: CanvasJournalEntry[] = [];
    const { service, repository } = await fixture({
      onAcceptedEntry: (entry) => published.push(entry),
      onAcceptedEntryUnavailable: () => {},
      onAcceptedInCallerTransaction: () => {
        throw new Error("commit_failed");
      }
    });

    const outcome = await service.submit(actor("owner"), submitBody("op-live-commit-failure", 0));
    expect(outcome).toMatchObject({ type: "canvas.command.rejected", code: "journal_unavailable" });
    expect(published).toEqual([]);
    expect(
      repository.head({ workspaceId: "w", projectId: "p", canvasId: "default" }).revision
    ).toBe(0);
    expect(
      repository.getOperation(
        { workspaceId: "w", projectId: "p", canvasId: "default" },
        "op-live-commit-failure"
      )
    ).toBeUndefined();
  });

  it("keeps accepted responses stable and invalidates live scope when publication fails", async () => {
    const invalidated: Array<{ revision: number; scope: string }> = [];
    const { service, repository } = await fixture({
      onAcceptedEntry: () => {
        throw new Error("live_publish_failed");
      },
      onAcceptedEntryUnavailable: ({ scope, headRevision }) =>
        invalidated.push({
          revision: headRevision,
          scope: `${scope.workspaceId}/${scope.projectId}/${scope.canvasId}`
        })
    });

    const callbackFailure = await service.submit(
      actor("owner"),
      submitBody("op-live-callback-failure", 0)
    );
    expect(callbackFailure).toMatchObject({ type: "canvas.command.accepted", revision: 1 });
    expect(invalidated).toEqual([{ revision: 1, scope: "w/p/default" }]);

    vi.spyOn(repository, "journalEntryAt").mockReturnValue(undefined);
    const entryUnavailable = await service.submit(
      actor("editor"),
      submitBody("op-live-entry-missing", 1)
    );
    expect(entryUnavailable).toMatchObject({ type: "canvas.command.accepted", revision: 2 });
    expect(invalidated).toEqual([
      { revision: 1, scope: "w/p/default" },
      { revision: 2, scope: "w/p/default" }
    ]);
  });

  it("fails fast when only one live publication callback is configured", async () => {
    const { repository, access, database, runtime } = await fixture();
    expect(
      () =>
        new CanvasCommandService({
          repository,
          access,
          workspaceIdentity: new WorkspaceIdentityRepository(database),
          runtime,
          onAcceptedEntry: () => {}
        })
    ).toThrow("canvas_live_sync_publication_callbacks_must_be_paired");
  });

  it("preserves accepted responses when both publish and invalidation fail", async () => {
    const { service } = await fixture({
      onAcceptedEntry: () => {
        throw new Error("live_publish_failed");
      },
      onAcceptedEntryUnavailable: () => {
        throw new Error("live_invalidation_failed");
      }
    });
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    const outcome = await service.submit(actor("owner"), submitBody("op-live-double-failure", 0));

    expect(outcome).toMatchObject({ type: "canvas.command.accepted", revision: 1 });
    expect(warning).toHaveBeenCalledWith("canvas_live_sync_invalidation_failed", {
      code: "PLANWEAVE_CANVAS_LIVE_SYNC_INVALIDATION_FAILED"
    });
  });

  it("migrates v30 and enforces CAS + operationId idempotency", async () => {
    const { service, repository, runtime, database } = await fixture();
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
    expect((runtime as ReturnType<typeof fakeRuntime>).calls).toBe(0);

    const replay = await service.submit(actor("owner"), submitBody("op-1", 0));
    expect(replay.type).toBe("canvas.command.accepted");
    if (replay.type !== "canvas.command.accepted") throw new Error("expected replay");
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.revision).toBe(first.revision);
    expect(replay.journalEntryId).toBe(first.journalEntryId);
    expect((runtime as ReturnType<typeof fakeRuntime>).calls).toBe(0);
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

  it("fails a corrupt receipt closed with a schema-valid repair-required outcome", async () => {
    const { service, database } = await fixture();
    const accepted = await service.submit(actor("owner"), submitBody("op-corrupt-receipt", 0));
    expect(accepted.type).toBe("canvas.command.accepted");
    database
      .prepare(
        `UPDATE canvas_command_operation_receipts SET outcome_json=' ' || outcome_json
          WHERE workspace_id='w' AND project_id='p' AND canvas_id='default'
            AND operation_id='op-corrupt-receipt'`
      )
      .run();

    const repairOutcome = await service.submit(actor("owner"), submitBody("op-corrupt-receipt", 0));
    expect(repairOutcome).toMatchObject({
      type: "canvas.command.rejected",
      code: "server_error",
      detail: "canvas_operation_retention_repair_required"
    });
    expect(canvasCommandOutcomeHttpStatus(repairOutcome)).toBe(500);
    expect(canvasCommandServerMessageSchema.parse(repairOutcome)).toEqual(repairOutcome);
    expect(
      database
        .prepare(
          `SELECT status FROM canvas_command_operation_retention_scopes
            WHERE workspace_id='w' AND project_id='p' AND canvas_id='default'`
        )
        .get()?.status
    ).toBe("repair_required");
  });

  it("rolls an accepted transaction back before independently marking sequence corruption", async () => {
    const { service, repository, database } = await fixture();
    database.exec(`
      CREATE TRIGGER corrupt_canvas_retention_before_receipt
      BEFORE INSERT ON canvas_command_operation_receipts
      BEGIN
        UPDATE canvas_command_operation_retention_scopes
           SET status='repair_required',failure_code='injected_sequence_corruption';
      END
    `);

    await expect(
      service.submit(actor("owner"), submitBody("op-atomic-corruption", 0))
    ).resolves.toMatchObject({
      type: "canvas.command.rejected",
      code: "server_error",
      detail: "canvas_operation_retention_repair_required"
    });
    expect(
      repository.head({ workspaceId: "w", projectId: "p", canvasId: "default" }).revision
    ).toBe(0);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM canvas_command_journal").get()?.count
    ).toBe(0);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM canvas_command_operation_receipts").get()
        ?.count
    ).toBe(0);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM canvas_command_pending_scopes").get()?.count
    ).toBe(1);
    expect(
      database
        .prepare("SELECT status,failure_code FROM canvas_command_operation_retention_scopes")
        .get()
    ).toEqual({
      status: "repair_required",
      failure_code: "canvas_operation_retention_sequence_conflict"
    });
  });

  it("rolls a rejected receipt transaction back without clearing pending on corruption", async () => {
    const { service, database } = await fixture();
    database.exec(`
      CREATE TRIGGER corrupt_canvas_rejection_retention
      BEFORE INSERT ON canvas_command_operation_receipts
      BEGIN
        UPDATE canvas_command_operation_retention_scopes
           SET status='repair_required',failure_code='injected_rejection_corruption';
      END
    `);

    await expect(
      service.submit(
        actor("owner"),
        submitBody("op-rejected-atomic-corruption", 0, {
          kind: "update_task_prompt",
          taskId: "missing-task",
          promptMarkdown: "# invalid"
        })
      )
    ).resolves.toMatchObject({
      type: "canvas.command.rejected",
      code: "server_error",
      detail: "canvas_operation_retention_repair_required"
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM canvas_command_operation_receipts").get()
        ?.count
    ).toBe(0);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM canvas_command_pending_scopes").get()?.count
    ).toBe(1);
  });

  it("marks a malformed new pending row for repair without recovery fallback or clearing", async () => {
    const { service, repository, database } = await fixture();
    const submit = submitBody("op-pending-corrupt", 0);
    repository.reservePending({
      scope: { workspaceId: "w", projectId: "p", canvasId: "default" },
      operationId: submit.operationId,
      expectedRevision: submit.expectedRevision,
      intent: submit.intent,
      intentDigest: digestCanvasIntent(submit.intent),
      actor: { kind: "human", id: "owner", displayName: "Owner" }
    });
    database.exec("PRAGMA ignore_check_constraints=ON");
    database.prepare("UPDATE canvas_command_pending_scopes SET actor_kind='unknown'").run();
    database.exec("PRAGMA ignore_check_constraints=OFF");

    await expect(service.recoverInterrupted(100)).resolves.toEqual({
      cleared: 0,
      recovered: 0,
      deferred: 1
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM canvas_command_pending_scopes").get()?.count
    ).toBe(1);
    expect(
      database.prepare("SELECT status FROM canvas_command_operation_retention_scopes").get()?.status
    ).toBe("repair_required");
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
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let enterCount = 0;
    const runtime: CanvasRuntimeMutationPort = {
      async apply(input) {
        enterCount += 1;
        if (enterCount === 1) await firstGate;
        const digest = digestOf(`apply:${enterCount}:${JSON.stringify(input.intent)}`);
        return {
          ok: true,
          contentDigest: digest,
          digestManifest: {
            manifest: { digestSha256: digest, sizeBytes: 1 },
            prompts: [],
            totalBytes: 1
          },
          packageDir: String(input.projectRoot),
          sizeBytes: 1
        };
      },
      async readDigest(input) {
        const digest = digestOf("head");
        return {
          ok: true,
          contentDigest: digest,
          digestManifest: {
            manifest: { digestSha256: digest, sizeBytes: 1 },
            prompts: [],
            totalBytes: 1
          },
          packageDir: String(input.projectRoot),
          sizeBytes: 1
        };
      }
    };
    const { service } = await fixture({ runtime });
    const firstPromise = service.submit(
      actor("owner"),
      submitBody("op-a", 0, {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "A"
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondPromise = service.submit(
      actor("editor"),
      submitBody("op-b", 0, {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "B"
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(enterCount).toBe(0);
    releaseFirst();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    const accepted = [first, second].filter((item) => item.type === "canvas.command.accepted");
    const rejected = [first, second].filter((item) => item.type === "canvas.command.rejected");
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ code: "stale_revision" });
    expect(enterCount).toBe(0);
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

  it("reconnects via journal delta, snapshots truncated history, and recovers pending rows", async () => {
    const { service, repository } = await fixture({ journalRetention: 2 });
    await service.submit(actor("owner"), submitBody("op-1", 0));
    await service.submit(actor("owner"), submitBody("op-2", 1));
    await service.submit(actor("owner"), submitBody("op-3", 2));

    const delta = await service.reconnect(actor("editor"), {
      type: "canvas.reconnect.request",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      projectId: "p",
      canvasId: "default",
      afterRevision: 2
    });
    expect(delta.type).toBe("canvas.reconnect.delta");
    if (delta.type === "canvas.reconnect.delta") {
      expect(delta.entries).toHaveLength(1);
      expect(delta.entries[0]?.revision).toBe(3);
      expect(delta.headRevision).toBe(3);
    }

    const truncated = await service.reconnect(actor("editor"), {
      type: "canvas.reconnect.request",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      projectId: "p",
      canvasId: "default",
      afterRevision: 0
    });
    expect(
      truncated.type === "canvas.reconnect.snapshot" || truncated.type === "canvas.reconnect.delta"
    ).toBe(true);
    if (truncated.type === "canvas.reconnect.snapshot") {
      expect(["truncated_journal", "retention_gap", "fresh_session"]).toContain(truncated.reason);
      expect(truncated.snapshot.metadata.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    }

    repository.reservePending({
      scope: { workspaceId: "w", projectId: "p", canvasId: "default" },
      operationId: "pending-crash",
      expectedRevision: 3,
      intent: {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "# crash"
      },
      intentDigest: digestCanvasIntent({
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "# crash"
      }),
      actor: { kind: "human", id: "owner" }
    });
    repository.markPendingNeedsRecovery(
      { workspaceId: "w", projectId: "p", canvasId: "default" },
      "pending-crash"
    );
    expect((await service.recoverInterrupted()).cleared).toBe(1);
  });

  it("rejects a revision-zero delta when the client baseline digest differs", async () => {
    const { service } = await fixture();
    const accepted = await service.submit(actor("owner"), submitBody("op-baseline", 0));
    expect(accepted.type).toBe("canvas.command.accepted");

    const response = await service.reconnect(actor("editor"), {
      type: "canvas.reconnect.request",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      projectId: "p",
      canvasId: "default",
      afterRevision: 0,
      afterContentDigest: "f".repeat(64)
    });

    expect(response).toMatchObject({
      type: "canvas.reconnect.snapshot",
      afterRevision: 0
    });
  });

  it("rejects forbidden shared-mode features and ignores presence as mutation authority", async () => {
    const request = { method: "POST" } as IncomingMessage;
    for (const path of [
      "/api/v1/projects/p/upload",
      "/api/v1/projects/p/download",
      "/api/v1/projects/p/sync",
      "/api/v1/projects/p/fs/watch",
      "/api/v1/projects/p/directory",
      "/api/v1/billing/checkout",
      "/api/v1/subscription/status",
      "/api/v1/license/activate",
      "/api/v1/ssh/open",
      "/api/v1/vps/provision"
    ]) {
      expect(routeCanvasCommandHttp(request, path)?.kind, path).toBe("forbidden_feature");
    }
    expect(
      routeCanvasCommandHttp(request, "/api/v1/projects/p/canvases/default/commands")?.kind
    ).toBe("command");
    expect(
      routeCanvasCommandHttp(
        { method: "GET" } as IncomingMessage,
        "/api/v1/projects/p/canvases/default/runtime-status"
      )?.kind
    ).toBe("runtime_status");

    const { service } = await fixture();
    const accepted = await service.submit(actor("owner"), submitBody("op-presence", 0));
    expect(accepted.type).toBe("canvas.command.accepted");
    if (accepted.type === "canvas.command.accepted") {
      // presenceHeadProbe returns 999; CAS revision must stay authoritative.
      expect(accepted.revision).toBe(1);
      expect(accepted.revision).not.toBe(999);
    }
  });

  it("returns a read-only redacted runtime status to an authorized viewer", async () => {
    const { service } = await fixture();

    await expect(
      service.readRuntimeStatus(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).resolves.toMatchObject({
      schemaVersion: "canvas-runtime-status/v2",
      scope: { workspaceId: "w", projectId: "p", canvasId: "default" },
      tasks: [{ taskId: "T-001", status: "implemented", openFeedbackCount: 0 }]
    });
  });

  it("accepts authority commits when server-local materialization is unavailable", async () => {
    const runtime = createDefaultCanvasRuntimePort();
    const materialize = vi
      .spyOn(runtime, "apply")
      .mockRejectedValue(new Error("local_disk_unavailable"));
    const { service } = await fixture({ runtime });
    const outcome = await service.submit(actor("owner"), {
      type: "canvas.command.submit",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      projectId: "p",
      canvasId: "default",
      operationId: "op-real-1",
      expectedRevision: 0,
      intent: {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "# Server authoritative prompt\n"
      }
    });
    if (outcome.type !== "canvas.command.accepted") {
      throw new Error(`expected accept, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.revision).toBe(1);
    expect(outcome.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(materialize).not.toHaveBeenCalled();
  });

  it("clears obsolete pending recovery without reading or promoting owner package state", async () => {
    const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
    let digest = digestOf("empty");
    let applyCalls = 0;
    const runtime: CanvasRuntimeMutationPort = {
      async apply(input) {
        applyCalls += 1;
        digest = digestOf(`${digest}:applied:${JSON.stringify(input.intent)}`);
        return {
          ok: true,
          contentDigest: digest,
          digestManifest: {
            manifest: { digestSha256: digest, sizeBytes: 10 },
            prompts: [],
            totalBytes: 10
          },
          packageDir: String(input.projectRoot),
          sizeBytes: 10
        };
      },
      async readDigest(input) {
        return {
          ok: true,
          contentDigest: digest,
          digestManifest: {
            manifest: { digestSha256: digest, sizeBytes: 10 },
            prompts: [],
            totalBytes: 10
          },
          packageDir: String(input.projectRoot),
          sizeBytes: 10
        };
      }
    };
    const { service, repository } = await fixture({ runtime });

    // Simulate: accept path reserved pending, apply mutated package, commit never ran.
    const intent: CanvasCommandIntent = {
      kind: "update_task_prompt",
      taskId: "T-001",
      promptMarkdown: "# crash recovery\n"
    };
    await runtime.apply({
      projectRoot: "/tmp",
      canvasId: "default",
      intent
    });
    expect(applyCalls).toBe(1);

    repository.reservePending({
      scope,
      operationId: "op-crash-apply",
      expectedRevision: 0,
      intent,
      intentDigest: digestCanvasIntent(intent),
      actor: { kind: "human", id: "owner" }
    });
    repository.markPendingNeedsRecovery(scope, "op-crash-apply");

    const recovery = await service.recoverInterrupted();
    expect(recovery).toEqual({ cleared: 1, recovered: 0, deferred: 0 });
    const head = repository.head(scope);
    expect(head.revision).toBe(0);
    expect(repository.getOperation(scope, "op-crash-apply")).toBeUndefined();
    expect(applyCalls).toBe(1);
  });

  it("commits immutable content and both authority heads in one accepted transaction", async () => {
    const runtime = createDefaultCanvasRuntimePort();
    const acceptedCommits: CanvasCommandAccepted[] = [];
    const { database, access, repository, service, contentVersions } = await fixture({
      runtime,
      onAcceptedInCallerTransaction: (accepted) => acceptedCommits.push(accepted)
    });
    if (!contentVersions || !runtime.captureContent)
      throw new Error("content version fixture unavailable");
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

  it("never reads an owner package to recover an obsolete pending command", async () => {
    const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
    let digest = digestOf("empty");
    const digestReadable = false;
    let applyCalls = 0;
    const runtime: CanvasRuntimeMutationPort = {
      async apply(input) {
        applyCalls += 1;
        digest = digestOf(`${digest}:applied:${JSON.stringify(input.intent)}`);
        return {
          ok: true,
          contentDigest: digest,
          digestManifest: {
            manifest: { digestSha256: digest, sizeBytes: 10 },
            prompts: [],
            totalBytes: 10
          },
          packageDir: String(input.projectRoot),
          sizeBytes: 10
        };
      },
      async readDigest(input) {
        if (!digestReadable) {
          return {
            ok: false,
            code: "mutation_failed",
            detail: "package_temporarily_unavailable"
          };
        }
        return {
          ok: true,
          contentDigest: digest,
          digestManifest: {
            manifest: { digestSha256: digest, sizeBytes: 10 },
            prompts: [],
            totalBytes: 10
          },
          packageDir: String(input.projectRoot),
          sizeBytes: 10
        };
      }
    };
    const { access, database, repository } = await fixture({ runtime });
    const restarted = new CanvasCommandService({
      repository,
      access,
      workspaceIdentity: new WorkspaceIdentityRepository(database),
      runtime
    });
    const intent: CanvasCommandIntent = {
      kind: "update_task_prompt",
      taskId: "T-001",
      promptMarkdown: "# interrupted write\n"
    };

    await runtime.apply({ projectRoot: "/tmp", canvasId: "default", intent });
    repository.reservePending({
      scope,
      operationId: "op-unreadable-recovery",
      expectedRevision: 0,
      intent,
      intentDigest: digestCanvasIntent(intent),
      actor: { kind: "human", id: "owner" }
    });
    repository.markPendingNeedsRecovery(scope, "op-unreadable-recovery");

    expect(await restarted.recoverInterrupted()).toEqual({ cleared: 1, recovered: 0, deferred: 0 });
    expect(
      database
        .prepare(
          `SELECT status FROM canvas_command_pending_scopes
           WHERE workspace_id='w' AND project_id='p' AND canvas_id='default'
             AND operation_id='op-unreadable-recovery'`
        )
        .get()
    ).toBeUndefined();
    expect(applyCalls).toBe(1);
    expect(repository.listNeedsRecovery()).toEqual([]);
    expect(repository.head(scope)).toMatchObject({ revision: 0 });
    void digestReadable;
  });

  it("serves reconnect snapshots from the content head rather than digest-only snapshot rows", async () => {
    const { service, repository } = await fixture();
    const accepted = await service.submit(actor("owner"), submitBody("op-snap-1", 0));
    expect(accepted.type).toBe("canvas.command.accepted");
    const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
    const head = repository.head(scope);
    repository.markSnapshotCorrupt(scope, head.revision);

    const response = await service.reconnect(actor("editor"), {
      type: "canvas.reconnect.request",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      projectId: "p",
      canvasId: "default",
      afterRevision: 0
    });
    // Retention may still return delta for afterRevision 0; force gap path.
    const forced = await service.reconnect(actor("editor"), {
      type: "canvas.reconnect.request",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      projectId: "p",
      canvasId: "default",
      afterRevision: 99
    });
    expect(forced.type).toBe("canvas.reconnect.snapshot");
    if (forced.type === "canvas.reconnect.snapshot") {
      expect(forced.snapshot.content.canonicalDigest).toBe(head.contentDigest);
    }
    void response;
  });

  it("keeps presence probe independent under concurrent command load", async () => {
    const { service } = await fixture();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        service.submit(
          actor("owner"),
          submitBody(`op-presence-load-${index}`, 0, {
            kind: "update_task_prompt",
            taskId: "T-001",
            promptMarkdown: `# presence load ${index}\n`
          })
        )
      )
    );
    const accepted = results.filter((item) => item.type === "canvas.command.accepted");
    const rejected = results.filter((item) => item.type === "canvas.command.rejected");
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    expect(accepted.length + rejected.length).toBe(8);
    for (const item of accepted) {
      if (item.type === "canvas.command.accepted") {
        // presenceHeadProbe returns 999; durable revision never uses presence.
        expect(item.revision).not.toBe(999);
        expect(item.revision).toBeGreaterThanOrEqual(1);
      }
    }
    for (const item of rejected) {
      if (item.type === "canvas.command.rejected") {
        expect(["stale_revision", "operation_conflict"]).toContain(item.code);
      }
    }
  });
});
