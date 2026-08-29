import { rm } from "node:fs/promises";
import { captureAuthorizedCanvasContent } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { readStableCanvasRuntimeContentTarget } from "../canvas/contentFingerprint.js";
import { ContentVersionRepository } from "../canvas/contentVersionRepository.js";
import { ensureRuntimeAttachmentForOperation } from "../canvas/runtimeAttachment.js";
import { CanvasRuntimeOperationAttachmentRepository } from "../canvas/runtimeOperationAttachmentRepository.js";
import { AgentHostRepository } from "../hosts.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const scope = {
  workspaceId: "workspace-attach",
  projectId: "project-attach",
  canvasId: "default"
};
const graphFingerprint = `pkg-${"a".repeat(64)}`;

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function setup() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  new WorkspaceIdentityRepository(database).ensureConfiguredWorkspace(scope.workspaceId);
  const projectAccess = new ProjectAccessRepository(database);
  projectAccess.registerProjectInternal({
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    projectRoot: "/runtime/project"
  });
  projectAccess.registerCanvasInternal({ ...scope, packageDir: "/runtime/project/package" });
  const hosts = new AgentHostRepository(database, () => new Date("2026-08-26T00:00:00.000Z"));
  const contentTargets = new Map([
    [scope.canvasId, { revision: 7, graphFingerprint }],
    ["secondary", { revision: 9, graphFingerprint }]
  ]);
  const attachments = new CanvasRuntimeOperationAttachmentRepository(
    database,
    hosts,
    () => new Date("2026-08-26T00:00:00.000Z"),
    {
      read: (targetScope) => {
        const target = contentTargets.get(targetScope.canvasId);
        if (!target) throw new Error("test_content_target_missing");
        return target;
      }
    }
  );
  const attach = (input: Parameters<typeof ensureRuntimeAttachmentForOperation>[1]) =>
    ensureRuntimeAttachmentForOperation(
      {
        attachments,
        database,
        clock: () => new Date("2026-08-26T00:00:00.000Z")
      },
      input
    );
  const registerCanvas = (canvasId: string) =>
    projectAccess.registerCanvasInternal({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      canvasId,
      packageDir: `/runtime/project/${canvasId}/package`
    });
  const seedAcceptedOperation = (input: {
    operationId: string;
    executionAttemptId: string;
    reservationLeaseId: string;
    hostId: string;
    canvasId?: string;
    sourceFingerprint?: string;
  }) => {
    const canvasId = input.canvasId ?? scope.canvasId;
    const now = "2026-08-26T00:00:00.000Z";
    const dispatchId = `dispatch-${input.executionAttemptId}`;
    database
      .prepare(
        `INSERT INTO remote_operations(
          id,workspace_id,project_id,canvas_id,block_ref,ownership_generation,idempotency_key,
          request_fingerprint,source_fingerprint,required_capabilities_json,state,
          dispatch_id,execution_attempt_id,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,'reserved',?,?,?,?)`
      )
      .run(
        input.operationId,
        scope.workspaceId,
        scope.projectId,
        canvasId,
        `T-${input.operationId}#B-1`,
        `generation-${input.operationId}`,
        `key-${input.operationId}`,
        "a".repeat(64),
        input.sourceFingerprint ?? graphFingerprint,
        "[]",
        dispatchId,
        input.executionAttemptId,
        now,
        now
      );
    database
      .prepare(
        `INSERT INTO remote_execution_attempts(
          execution_attempt_id,operation_id,dispatch_id,workspace_id,project_id,canvas_id,
          block_ref,ownership_generation,status,host_id,lease_id,lease_fencing_token,
          lease_expires_at,state_version,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,'reserved',?,?,1,?,1,?,?)`
      )
      .run(
        input.executionAttemptId,
        input.operationId,
        dispatchId,
        scope.workspaceId,
        scope.projectId,
        canvasId,
        `T-${input.operationId}#B-1`,
        `generation-${input.operationId}`,
        input.hostId,
        input.reservationLeaseId,
        "2026-08-26T00:01:00.000Z",
        now,
        now
      );
    database
      .prepare(
        `INSERT INTO host_capacity_reservations(
          lease_id,execution_attempt_id,host_id,fencing_token,status,lease_expires_at,created_at
        ) VALUES (?,?,?,1,'active',?,?)`
      )
      .run(
        input.reservationLeaseId,
        input.executionAttemptId,
        input.hostId,
        "2026-08-26T00:01:00.000Z",
        now
      );
  };
  return {
    attach,
    attachments,
    contentTargets,
    database,
    hosts,
    registerCanvas,
    seedAcceptedOperation
  };
}

function downgradeToLegacyRuntimeBindingSchema(database: SqliteDatabase): void {
  database.exec(`
    DROP TABLE canvas_runtime_operation_attachments;
    DROP INDEX idx_canvas_runtime_host_binding_selected_route;
    ALTER TABLE canvas_runtime_host_bindings DROP COLUMN route_selected;
    ALTER TABLE canvas_runtime_host_bindings ADD COLUMN operation_id TEXT;
    ALTER TABLE canvas_runtime_host_bindings ADD COLUMN execution_attempt_id TEXT;
    ALTER TABLE canvas_runtime_host_bindings ADD COLUMN host_generation TEXT;
    ALTER TABLE canvas_runtime_host_bindings ADD COLUMN content_revision INTEGER;
    ALTER TABLE canvas_runtime_host_bindings ADD COLUMN graph_fingerprint TEXT;
    DELETE FROM schema_migrations WHERE version=64;
  `);
}

describe("ensureRuntimeAttachmentForOperation", () => {
  it("strictly backfills only fully joined v62 evidence and replays idempotently", async () => {
    const fixture = await setup();
    const workspace = await createTestWorkspace();
    const host = fixture.hosts.register("Legacy Evidence Host").host;
    const unverifiableHost = fixture.hosts.register("Unverifiable Legacy Host").host;
    const mismatchedSourceHost = fixture.hosts.register("Mismatched Source Host").host;
    try {
      const captured = await captureAuthorizedCanvasContent({
        projectRoot: workspace.root,
        canvasId: scope.canvasId,
        expectedPackageDir: workspace.init.workspace.packageDir,
        authorityProjectId: scope.projectId
      });
      const contentVersions = new ContentVersionRepository(fixture.database);
      contentVersions.publishInitial({
        scope,
        content: captured.content,
        createdBy: { kind: "system", id: "runtime-attachment-migration-test" }
      });
      const contentTarget = readStableCanvasRuntimeContentTarget(contentVersions, scope);
      fixture.seedAcceptedOperation({
        operationId: "operation-backfill",
        executionAttemptId: "attempt-backfill",
        reservationLeaseId: "lease-backfill",
        hostId: host.id,
        sourceFingerprint: contentTarget.graphFingerprint
      });
      fixture.seedAcceptedOperation({
        operationId: "operation-unverifiable",
        executionAttemptId: "attempt-unverifiable",
        reservationLeaseId: "lease-unverifiable",
        hostId: unverifiableHost.id,
        sourceFingerprint: contentTarget.graphFingerprint
      });
      fixture.seedAcceptedOperation({
        operationId: "operation-source-mismatch",
        executionAttemptId: "attempt-source-mismatch",
        reservationLeaseId: "lease-source-mismatch",
        hostId: mismatchedSourceHost.id,
        sourceFingerprint: `pkg-${"b".repeat(64)}`
      });
      downgradeToLegacyRuntimeBindingSchema(fixture.database);
      const insertLegacyBinding = fixture.database.prepare(
        `INSERT INTO canvas_runtime_host_bindings(
           workspace_id,project_id,host_id,readiness_status,first_observed_at,last_observed_at,
           operation_id,execution_attempt_id,host_generation,content_revision,graph_fingerprint
         ) VALUES (?,?,?,'ready',?,?,?,?,?,?,?)`
      );
      insertLegacyBinding.run(
        scope.workspaceId,
        scope.projectId,
        host.id,
        "2026-08-26T00:00:00.000Z",
        "2026-08-26T00:00:00.000Z",
        "operation-backfill",
        "attempt-backfill",
        host.id,
        contentTarget.revision,
        contentTarget.graphFingerprint
      );
      insertLegacyBinding.run(
        scope.workspaceId,
        scope.projectId,
        mismatchedSourceHost.id,
        "2026-08-26T00:00:00.000Z",
        "2026-08-26T00:00:00.000Z",
        "operation-source-mismatch",
        "attempt-source-mismatch",
        mismatchedSourceHost.id,
        contentTarget.revision,
        contentTarget.graphFingerprint
      );
      insertLegacyBinding.run(
        scope.workspaceId,
        scope.projectId,
        unverifiableHost.id,
        "2026-08-26T00:00:00.000Z",
        "2026-08-26T00:00:00.000Z",
        "operation-unverifiable",
        "attempt-unverifiable",
        unverifiableHost.id,
        contentTarget.revision + 1,
        contentTarget.graphFingerprint
      );

      applyMigrations(fixture.database);
      expect(fixture.attachments.listForOperation("operation-backfill")).toEqual([
        expect.objectContaining({
          canvasId: scope.canvasId,
          hostId: host.id,
          reservationLeaseId: "lease-backfill",
          contentRevision: contentTarget.revision,
          graphFingerprint: contentTarget.graphFingerprint
        })
      ]);
      expect(fixture.attachments.listForOperation("operation-unverifiable")).toEqual([]);
      expect(fixture.attachments.listForOperation("operation-source-mismatch")).toEqual([]);
      expect(
        fixture.database
          .prepare("PRAGMA table_info(canvas_runtime_host_bindings)")
          .all()
          .map((column) => (column as { name: string }).name)
      ).toEqual([
        "workspace_id",
        "project_id",
        "host_id",
        "readiness_status",
        "route_selected",
        "first_observed_at",
        "last_observed_at"
      ]);
      expect(() => applyMigrations(fixture.database)).not.toThrow();
      expect(fixture.attachments.listForOperation("operation-backfill")).toHaveLength(1);
      expect(fixture.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      await rm(workspace.home, { recursive: true, force: true });
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it("fails before changing a malformed v63 binding schema that lacks evidence columns", async () => {
    const fixture = await setup();
    downgradeToLegacyRuntimeBindingSchema(fixture.database);
    fixture.database.exec("ALTER TABLE canvas_runtime_host_bindings DROP COLUMN graph_fingerprint");

    expect(() => applyMigrations(fixture.database)).toThrow(
      "canvas_runtime_host_binding_evidence_schema_missing:graph_fingerprint"
    );
    expect(
      fixture.database
        .prepare("PRAGMA table_info(canvas_runtime_host_bindings)")
        .all()
        .map((column) => (column as { name: string }).name)
    ).toEqual([
      "workspace_id",
      "project_id",
      "host_id",
      "readiness_status",
      "first_observed_at",
      "last_observed_at",
      "operation_id",
      "execution_attempt_id",
      "host_generation",
      "content_revision"
    ]);
    expect(
      fixture.database.prepare("SELECT 1 FROM schema_migrations WHERE version=64").get()
    ).toBeUndefined();
    expect(
      fixture.database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='canvas_runtime_operation_attachments'"
        )
        .get()
    ).toBeUndefined();
    expect(fixture.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rolls back v64 when an unknown SQLite content-authority failure occurs", async () => {
    const fixture = await setup();
    const host = fixture.hosts.register("Faulted Migration Host").host;
    fixture.seedAcceptedOperation({
      operationId: "operation-migration-fault",
      executionAttemptId: "attempt-migration-fault",
      reservationLeaseId: "lease-migration-fault",
      hostId: host.id
    });
    downgradeToLegacyRuntimeBindingSchema(fixture.database);
    fixture.database
      .prepare(
        `INSERT INTO canvas_runtime_host_bindings(
           workspace_id,project_id,host_id,readiness_status,first_observed_at,last_observed_at,
           operation_id,execution_attempt_id,host_generation,content_revision,graph_fingerprint
         ) VALUES (?,?,?,'ready',?,?,?,?,?,?,?)`
      )
      .run(
        scope.workspaceId,
        scope.projectId,
        host.id,
        "2026-08-26T00:00:00.000Z",
        "2026-08-26T00:00:00.000Z",
        "operation-migration-fault",
        "attempt-migration-fault",
        host.id,
        7,
        graphFingerprint
      );
    fixture.database.exec("ALTER TABLE canvas_content_heads RENAME TO malformed_content_heads");

    expect(() => applyMigrations(fixture.database)).toThrow(/no such table: canvas_content_heads/);
    expect(
      fixture.database
        .prepare(
          `SELECT operation_id,execution_attempt_id,host_generation,content_revision,graph_fingerprint
             FROM canvas_runtime_host_bindings WHERE host_id=?`
        )
        .get(host.id)
    ).toEqual({
      operation_id: "operation-migration-fault",
      execution_attempt_id: "attempt-migration-fault",
      host_generation: host.id,
      content_revision: 7,
      graph_fingerprint: graphFingerprint
    });
    expect(
      fixture.database.prepare("SELECT 1 FROM schema_migrations WHERE version=64").get()
    ).toBeUndefined();
    expect(
      fixture.database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='canvas_runtime_operation_attachments'"
        )
        .get()
    ).toBeUndefined();
    expect(fixture.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("persists independent evidence for two Canvases in one project", async () => {
    const fixture = await setup();
    const host = fixture.hosts.register("Attach Host").host;
    fixture.registerCanvas("secondary");
    fixture.seedAcceptedOperation({
      operationId: "operation-attach-1",
      executionAttemptId: "attempt-attach-1",
      reservationLeaseId: "lease-attach-1",
      hostId: host.id
    });
    fixture.seedAcceptedOperation({
      operationId: "operation-attach-2",
      executionAttemptId: "attempt-attach-2",
      reservationLeaseId: "lease-attach-2",
      hostId: host.id,
      canvasId: "secondary"
    });
    const firstRequest = {
      ...scope,
      hostId: host.id,
      operationId: "operation-attach-1",
      executionAttemptId: "attempt-attach-1",
      reservationLeaseId: "lease-attach-1",
      contentRevision: 7,
      graphFingerprint
    };
    fixture.attach(firstRequest);
    fixture.attach(firstRequest);
    fixture.attach({
      ...scope,
      canvasId: "secondary",
      hostId: host.id,
      operationId: "operation-attach-2",
      executionAttemptId: "attempt-attach-2",
      reservationLeaseId: "lease-attach-2",
      contentRevision: 9,
      graphFingerprint
    });

    expect(fixture.attachments.listProject(scope)).toEqual([
      expect.objectContaining({ canvasId: "default", contentRevision: 7 }),
      expect.objectContaining({ canvasId: "secondary", contentRevision: 9 })
    ]);
    expect(fixture.hosts.runtimeBindings.list(scope)).toEqual([]);
  });

  it("keeps prior evidence when one operation retries with a new attempt", async () => {
    const fixture = await setup();
    const host = fixture.hosts.register("Retry Host").host;
    fixture.seedAcceptedOperation({
      operationId: "operation-retry",
      executionAttemptId: "attempt-retry-1",
      reservationLeaseId: "lease-retry-1",
      hostId: host.id
    });
    fixture.attach({
      ...scope,
      hostId: host.id,
      operationId: "operation-retry",
      executionAttemptId: "attempt-retry-1",
      reservationLeaseId: "lease-retry-1",
      contentRevision: 7,
      graphFingerprint
    });
    fixture.database
      .prepare(
        "UPDATE host_capacity_reservations SET status='released',released_at=? WHERE lease_id=?"
      )
      .run("2026-08-26T00:00:30.000Z", "lease-retry-1");
    fixture.database
      .prepare(
        "UPDATE remote_execution_attempts SET status='superseded',terminal_at=? WHERE execution_attempt_id=?"
      )
      .run("2026-08-26T00:00:30.000Z", "attempt-retry-1");
    fixture.database
      .prepare("UPDATE remote_operations SET execution_attempt_id=?,dispatch_id=? WHERE id=?")
      .run("attempt-retry-2", "dispatch-attempt-retry-2", "operation-retry");
    fixture.database
      .prepare(
        `INSERT INTO remote_execution_attempts(
          execution_attempt_id,operation_id,dispatch_id,workspace_id,project_id,canvas_id,
          block_ref,ownership_generation,status,host_id,lease_id,lease_fencing_token,
          lease_expires_at,state_version,created_at,updated_at
        ) SELECT ?,operation_id,?,workspace_id,project_id,canvas_id,block_ref,ownership_generation,
          'reserved',host_id,?,1,lease_expires_at,1,created_at,updated_at
          FROM remote_execution_attempts WHERE execution_attempt_id=?`
      )
      .run("attempt-retry-2", "dispatch-attempt-retry-2", "lease-retry-2", "attempt-retry-1");
    fixture.database
      .prepare(
        `INSERT INTO host_capacity_reservations(
          lease_id,execution_attempt_id,host_id,fencing_token,status,lease_expires_at,created_at
        ) SELECT ?,?,host_id,1,'active',lease_expires_at,created_at
          FROM host_capacity_reservations WHERE lease_id=?`
      )
      .run("lease-retry-2", "attempt-retry-2", "lease-retry-1");
    fixture.contentTargets.set(scope.canvasId, { revision: 8, graphFingerprint });
    fixture.attach({
      ...scope,
      hostId: host.id,
      operationId: "operation-retry",
      executionAttemptId: "attempt-retry-2",
      reservationLeaseId: "lease-retry-2",
      contentRevision: 8,
      graphFingerprint
    });

    expect(fixture.attachments.listForOperation("operation-retry")).toEqual([
      expect.objectContaining({ executionAttemptId: "attempt-retry-1", contentRevision: 7 }),
      expect.objectContaining({ executionAttemptId: "attempt-retry-2", contentRevision: 8 })
    ]);
  });

  it.each([
    ["canvas", { canvasId: "wrong" }],
    ["host", { hostId: "wrong-host" }],
    ["lease", { reservationLeaseId: "lease-wrong" }]
  ])("rejects an attachment with mismatched %s", async (_label, override) => {
    const fixture = await setup();
    const host = fixture.hosts.register("Validation Host").host;
    fixture.seedAcceptedOperation({
      operationId: "operation-validation",
      executionAttemptId: "attempt-validation",
      reservationLeaseId: "lease-validation",
      hostId: host.id
    });
    expect(() =>
      fixture.attach({
        ...scope,
        hostId: host.id,
        operationId: "operation-validation",
        executionAttemptId: "attempt-validation",
        reservationLeaseId: "lease-validation",
        contentRevision: 7,
        graphFingerprint,
        ...override
      })
    ).toThrow("canvas_runtime_attachment_attempt_scope_conflict");
  });

  it("rejects a released reservation and cascades evidence with attempt retention", async () => {
    const fixture = await setup();
    const host = fixture.hosts.register("Retention Host").host;
    fixture.seedAcceptedOperation({
      operationId: "operation-retention",
      executionAttemptId: "attempt-retention",
      reservationLeaseId: "lease-retention",
      hostId: host.id
    });
    const request = {
      ...scope,
      hostId: host.id,
      operationId: "operation-retention",
      executionAttemptId: "attempt-retention",
      reservationLeaseId: "lease-retention",
      contentRevision: 7,
      graphFingerprint
    };
    fixture.database
      .prepare(
        "UPDATE host_capacity_reservations SET status='released',released_at=? WHERE lease_id=?"
      )
      .run("2026-08-26T00:00:30.000Z", "lease-retention");
    expect(() => fixture.attach(request)).toThrow("canvas_runtime_attachment_reservation_inactive");
    fixture.database
      .prepare(
        "UPDATE host_capacity_reservations SET status='active',released_at=NULL WHERE lease_id=?"
      )
      .run("lease-retention");
    fixture.attach(request);
    fixture.database
      .prepare("DELETE FROM host_capacity_reservations WHERE lease_id=?")
      .run("lease-retention");
    fixture.database
      .prepare("DELETE FROM remote_execution_attempts WHERE execution_attempt_id=?")
      .run("attempt-retention");
    expect(fixture.attachments.listForOperation("operation-retention")).toEqual([]);
  });

  it("uses the attempt lease when an older reservation for the same attempt is released", async () => {
    const fixture = await setup();
    const host = fixture.hosts.register("Reservation History Host").host;
    fixture.seedAcceptedOperation({
      operationId: "operation-reservation-history",
      executionAttemptId: "attempt-reservation-history",
      reservationLeaseId: "lease-current",
      hostId: host.id
    });
    fixture.database
      .prepare("DELETE FROM host_capacity_reservations WHERE lease_id=?")
      .run("lease-current");
    fixture.database
      .prepare(
        `INSERT INTO host_capacity_reservations(
          lease_id,execution_attempt_id,host_id,fencing_token,status,lease_expires_at,
          created_at,released_at
        ) VALUES (?,?,?,2,'released',?,?,?)`
      )
      .run(
        "lease-released",
        "attempt-reservation-history",
        host.id,
        "2026-08-25T23:59:00.000Z",
        "2026-08-25T23:58:00.000Z",
        "2026-08-25T23:59:00.000Z"
      );
    fixture.database
      .prepare(
        `INSERT INTO host_capacity_reservations(
          lease_id,execution_attempt_id,host_id,fencing_token,status,lease_expires_at,created_at
        ) VALUES (?,?,?,1,'active',?,?)`
      )
      .run(
        "lease-current",
        "attempt-reservation-history",
        host.id,
        "2026-08-26T00:01:00.000Z",
        "2026-08-26T00:00:00.000Z"
      );

    fixture.attach({
      ...scope,
      hostId: host.id,
      operationId: "operation-reservation-history",
      executionAttemptId: "attempt-reservation-history",
      reservationLeaseId: "lease-current",
      contentRevision: 7,
      graphFingerprint
    });

    expect(fixture.attachments.listForOperation("operation-reservation-history")).toEqual([
      expect.objectContaining({ reservationLeaseId: "lease-current" })
    ]);
  });

  it("fails closed when the authoritative content head advances before the attachment transaction", async () => {
    const fixture = await setup();
    const host = fixture.hosts.register("Content Race Host").host;
    fixture.seedAcceptedOperation({
      operationId: "operation-content-race",
      executionAttemptId: "attempt-content-race",
      reservationLeaseId: "lease-content-race",
      hostId: host.id
    });
    fixture.contentTargets.set(scope.canvasId, { revision: 8, graphFingerprint });
    expect(() =>
      fixture.attach({
        ...scope,
        hostId: host.id,
        operationId: "operation-content-race",
        executionAttemptId: "attempt-content-race",
        reservationLeaseId: "lease-content-race",
        contentRevision: 7,
        graphFingerprint
      })
    ).toThrow("canvas_runtime_attachment_content_target_changed");
    expect(fixture.attachments.listForOperation("operation-content-race")).toEqual([]);
  });

  it("rejects an active reservation whose lease is already expired", async () => {
    const fixture = await setup();
    const host = fixture.hosts.register("Expired Reservation Host").host;
    fixture.seedAcceptedOperation({
      operationId: "operation-expired",
      executionAttemptId: "attempt-expired",
      reservationLeaseId: "lease-expired",
      hostId: host.id
    });
    fixture.database
      .prepare("UPDATE host_capacity_reservations SET lease_expires_at=? WHERE lease_id=?")
      .run("2026-08-25T23:59:59.000Z", "lease-expired");
    expect(() =>
      fixture.attach({
        ...scope,
        hostId: host.id,
        operationId: "operation-expired",
        executionAttemptId: "attempt-expired",
        reservationLeaseId: "lease-expired",
        contentRevision: 7,
        graphFingerprint
      })
    ).toThrow("canvas_runtime_attachment_reservation_expired");
    expect(fixture.attachments.listForOperation("operation-expired")).toEqual([]);
  });
});
