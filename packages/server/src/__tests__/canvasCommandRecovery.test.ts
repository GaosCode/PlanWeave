import { describe, expect, it } from "vitest";
import { CANVAS_COMMAND_PROTOCOL_VERSION } from "@planweave-ai/collaboration-protocol/core/limits";
import {
  canvasCommandServerMessageSchema,
  type CanvasCommandIntent
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import {
  CanvasCommandService,
  canvasCommandOutcomeHttpStatus,
  digestCanvasIntent,
  type CanvasRuntimeMutationPort
} from "../canvas/index.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import {
  actor,
  canvasCommandServiceFixture as fixture,
  digestOf,
  submitBody
} from "./support/canvasCommandServiceFixture.js";

describe("canvas command service (OSS-004 B-002)", () => {
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
});
