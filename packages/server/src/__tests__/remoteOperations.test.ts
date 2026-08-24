import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import {
  applyMigrations,
  centralSchemaVersion,
  latestCentralSchemaVersion
} from "../migrations.js";
import { AgentHostRepository } from "../hosts.js";
import { HostReservationRepository } from "../hostReservations.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { RemoteOperationRepository } from "../remoteOperations.js";
import { RemoteExecutionActionRepository } from "../remoteExecutionActions.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const directories: string[] = [];
const servers: PlanweaveServer[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup(): Promise<PlanweaveServer> {
  const directory = await mkdtemp(join(tmpdir(), "planweave-remote-operation-"));
  directories.push(directory);
  const server = await startPlanweaveServer({
    dataDirectory: directory,
    databasePath: join(directory, "server.sqlite"),
    busyTimeoutMs: 5_000
  });
  servers.push(server);
  return server;
}

const operationInput = {
  workspaceId: "workspace-a",
  projectId: "project-a",
  canvasId: "default",
  blockRef: "RC-002#B-001",
  ownershipGeneration: "generation-1",
  idempotencyKey: "request-1",
  sourceFingerprint: "graph-fingerprint-1",
  requiredCapabilities: ["linux", "acp.codex"]
} as const;

describe("RemoteOperationRepository", () => {
  it("finds only the latest operation in the exact workspace, project, canvas, and block scope", async () => {
    const server = await setup();
    let now = new Date("2030-01-01T00:00:00.000Z");
    const repository = new RemoteOperationRepository(server.database, () => now);

    const first = repository.create(operationInput);
    now = new Date("2030-01-01T00:01:00.000Z");
    const latest = repository.create({ ...operationInput, idempotencyKey: "request-2" });
    repository.create({ ...operationInput, canvasId: "canvas-other", idempotencyKey: "request-3" });
    repository.create({ ...operationInput, blockRef: "RC-002#B-002", idempotencyKey: "request-4" });
    repository.create({
      ...operationInput,
      workspaceId: "workspace-b",
      idempotencyKey: "request-5"
    });

    expect(
      repository.findLatestByScope({
        workspaceId: operationInput.workspaceId,
        projectId: operationInput.projectId,
        canvasId: operationInput.canvasId,
        blockRef: operationInput.blockRef
      })
    ).toEqual(latest);
    expect(latest.id).not.toBe(first.id);
    expect(
      repository.findLatestByScope({
        workspaceId: operationInput.workspaceId,
        projectId: operationInput.projectId,
        canvasId: operationInput.canvasId,
        blockRef: "RC-002#B-missing"
      })
    ).toBeUndefined();
  });

  it("finds an operation by ID only when every remote scope field matches", async () => {
    const server = await setup();
    const repository = new RemoteOperationRepository(server.database);
    const operation = repository.create(operationInput);
    const scope = {
      workspaceId: operation.workspaceId,
      projectId: operation.projectId,
      canvasId: operation.canvasId,
      blockRef: operation.blockRef,
      operationId: operation.id
    };

    expect(repository.findByOperationIdInScope(scope)).toEqual(operation);
    expect(
      repository.findByOperationIdInScope({ ...scope, blockRef: "RC-002#B-002" })
    ).toBeUndefined();
    expect(
      repository.findByOperationIdInScope({ ...scope, operationId: "operation-not-found" })
    ).toBeUndefined();
  });

  it("uses insertion order when scoped operations share the same timestamp", async () => {
    const server = await setup();
    const repository = new RemoteOperationRepository(
      server.database,
      () => new Date("2030-01-01T00:00:00.000Z")
    );
    repository.create(operationInput);
    const second = repository.create({ ...operationInput, idempotencyKey: "request-2" });

    expect(
      repository.findLatestByScope({
        workspaceId: operationInput.workspaceId,
        projectId: operationInput.projectId,
        canvasId: operationInput.canvasId,
        blockRef: operationInput.blockRef
      })
    ).toEqual(second);
  });

  it("persists an endpoint selection across reload and binds it to idempotency", async () => {
    const server = await setup();
    const repository = new RemoteOperationRepository(server.database);
    const endpointSelection = {
      schemaVersion: "endpoint-selection/v1" as const,
      endpointId: "aep-primary",
      profileId: "codex-acp",
      agentId: "codex",
      displayName: "Codex",
      hostId: "host-internal",
      hostDisplayName: "VPS Singapore",
      capabilities: ["linux", "acp.codex"],
      resolvedAt: "2030-01-01T00:00:00.000Z",
      authority: {
        schemaVersion: "endpoint-authority/v1" as const,
        controlPlane: "collaboration" as const,
        responsibilityRevision: 2,
        reviewerRevision: 3
      }
    };
    const created = repository.create({ ...operationInput, endpointSelection });

    expect(repository.getRequired(created.id).endpointSelection).toEqual(endpointSelection);
    expect(repository.create({ ...operationInput, endpointSelection })).toEqual(created);
    expect(() =>
      repository.create({
        ...operationInput,
        endpointSelection: { ...endpointSelection, endpointId: "aep-other" }
      })
    ).toThrowError("remote_operation_idempotency_conflict");
    expect(
      server.database
        .prepare("SELECT endpoint_selection_json FROM remote_operations WHERE id=?")
        .get(created.id)?.endpoint_selection_json
    ).toEqual(expect.stringContaining('"endpointId":"aep-primary"'));
  });

  it("creates stable dispatch and attempt identities, replays identical input, and rejects conflict", async () => {
    const server = await setup();
    const repository = new RemoteOperationRepository(server.database);

    const created = repository.create(operationInput);
    expect(repository.create(operationInput)).toEqual(created);
    expect(created.dispatchId).toMatch(/^dispatch-/);
    expect(created.executionAttemptId).toMatch(/^attempt-/);
    expect(created.attempt.status).toBe("prepared");
    expect(repository.markClaimed(created.id).state).toBe("claimed");
    const digest = `envelope:sha256:${"a".repeat(64)}`;
    expect(repository.recordEnvelope({ operationId: created.id, digest }).envelopeDigest).toBe(
      digest
    );
    expect(repository.recordEnvelope({ operationId: created.id, digest }).dispatchId).toBe(
      created.dispatchId
    );
    expect(() =>
      repository.recordEnvelope({
        operationId: created.id,
        digest: `envelope:sha256:${"b".repeat(64)}`
      })
    ).toThrowError("remote_operation_envelope_conflict");
    expect(() =>
      repository.create({ ...operationInput, sourceFingerprint: "graph-fingerprint-2" })
    ).toThrowError("remote_operation_idempotency_conflict");
  });

  it("cancels only a claimed prepared attempt whose Runtime binding was reset before dispatch", async () => {
    const server = await setup();
    const clock = () => new Date("2030-01-01T00:00:00.000Z");
    const repository = new RemoteOperationRepository(server.database, clock);
    const claimed = repository.markClaimed(repository.create(operationInput).id);

    expect(
      repository.cancelClaimedAfterRuntimeReset({
        operationId: claimed.id,
        executionAttemptId: claimed.executionAttemptId
      })
    ).toMatchObject({
      state: "cancelled",
      terminalAt: "2030-01-01T00:00:00.000Z",
      attempt: {
        status: "cancelled",
        stateVersion: 1,
        terminalAt: "2030-01-01T00:00:00.000Z"
      }
    });
    expect(
      server.database
        .prepare("SELECT diagnostic_code,diagnostic_message FROM remote_operations WHERE id=?")
        .get(claimed.id)
    ).toEqual({
      diagnostic_code: "runtime_binding_reset",
      diagnostic_message: "Runtime reset removed remote ownership before Host dispatch."
    });
    expect(
      server.database
        .prepare(
          "SELECT COUNT(*) AS count FROM remote_operation_events WHERE operation_id=? AND type='remote.attempt.cancelled'"
        )
        .get(claimed.id)?.count
    ).toBe(1);

    const preparing = repository.create({ ...operationInput, idempotencyKey: "request-2" });
    expect(() =>
      repository.cancelClaimedAfterRuntimeReset({
        operationId: preparing.id,
        executionAttemptId: preparing.executionAttemptId
      })
    ).toThrowError("remote_runtime_reset_recovery_conflict");
  });

  it("upgrades a v44 prepared attempt before cancelling its reset Runtime binding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-remote-v45-migration-"));
    directories.push(directory);
    const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
    databases.push(database);
    database.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
      CREATE TRIGGER stop_before_remote_attempt_cancellation
      BEFORE INSERT ON schema_migrations
      WHEN NEW.version = 45
      BEGIN
        SELECT RAISE(ABORT, 'stop_before_remote_attempt_cancellation');
      END;
    `);

    expect(() => applyMigrations(database)).toThrowError("stop_before_remote_attempt_cancellation");
    expect(centralSchemaVersion(database)).toBe(44);
    const legacyRepository = new RemoteOperationRepository(database);
    const claimed = legacyRepository.markClaimed(legacyRepository.create(operationInput).id);

    database.exec("DROP TRIGGER stop_before_remote_attempt_cancellation");
    applyMigrations(database);

    expect(centralSchemaVersion(database)).toBe(latestCentralSchemaVersion);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      new RemoteOperationRepository(database).cancelClaimedAfterRuntimeReset({
        operationId: claimed.id,
        executionAttemptId: claimed.executionAttemptId
      })
    ).toMatchObject({ state: "cancelled", attempt: { status: "cancelled" } });
  });

  it("fails visibly when persisted enum or JSON data is corrupted", async () => {
    const server = await setup();
    const repository = new RemoteOperationRepository(server.database);
    const created = repository.create(operationInput);

    server.database
      .prepare("UPDATE remote_operations SET required_capabilities_json=? WHERE id=?")
      .run('["linux",', created.id);
    expect(() => repository.getRequired(created.id)).toThrowError("remote_operation_row_invalid");

    server.database.exec("PRAGMA ignore_check_constraints = ON");
    server.database
      .prepare("UPDATE remote_operations SET required_capabilities_json=?,state=? WHERE id=?")
      .run('["linux"]', "unknown", created.id);
    server.database.exec("PRAGMA ignore_check_constraints = OFF");
    expect(() => repository.getRequired(created.id)).toThrowError("remote_operation_row_invalid");
  });

  it("creates a new current attempt only after preserving and fencing the interrupted attempt", async () => {
    const server = await setup();
    const clock = () => new Date("2030-01-01T00:00:00.000Z");
    const operations = new RemoteOperationRepository(server.database, clock);
    const hosts = new AgentHostRepository(server.database, clock);
    const host = hosts.register("Retry Host").host;
    const workspaceId = new WorkspaceIdentityRepository(
      server.database
    ).ensureWorkspaceForLegacyProject(operationInput.projectId);
    hosts.bindToWorkspace(host.id, workspaceId);
    hosts.reportOnline(host.id, ["linux", "acp.codex"], 1, {
      workspaceMappings: [{ workspaceId, status: "ready" }],
      acpProfiles: [
        {
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Test Agent",
          status: "ready",
          capabilities: ["linux", "acp.codex"]
        }
      ]
    });
    const reservations = new HostReservationRepository(server.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      clock
    });
    const created = operations.markClaimed(
      operations.create({ ...operationInput, workspaceId }).id
    );
    const reservation = reservations.reserve(created.id, {
      agentId: "codex",
      agentProfileId: "codex-acp"
    });
    reservations.transition({
      leaseId: reservation.leaseId,
      fencingToken: reservation.fencingToken,
      expectedAttemptVersion: operations.getRequired(created.id).attempt.stateVersion,
      status: "activated"
    });
    const activated = operations.getRequired(created.id);
    reservations.release({
      leaseId: reservation.leaseId,
      fencingToken: reservation.fencingToken,
      expectedVersion: reservation.version,
      reason: "expired"
    });
    const interrupted = operations.getRequired(created.id);

    const retried = operations.retryAttempt({
      operationId: created.id,
      priorExecutionAttemptId: interrupted.executionAttemptId,
      newDispatchId: "dispatch-retry-2",
      newExecutionAttemptId: "attempt-retry-2",
      expectedAttemptVersion: interrupted.attempt.stateVersion
    });
    expect(retried).toMatchObject({
      state: "claimed",
      dispatchId: "dispatch-retry-2",
      executionAttemptId: "attempt-retry-2",
      attempt: { executionAttemptId: "attempt-retry-2", status: "prepared" }
    });
    expect(
      operations.retryAttempt({
        operationId: created.id,
        priorExecutionAttemptId: interrupted.executionAttemptId,
        newDispatchId: "dispatch-retry-2",
        newExecutionAttemptId: "attempt-retry-2",
        expectedAttemptVersion: interrupted.attempt.stateVersion
      })
    ).toEqual(retried);
    expect(
      server.database
        .prepare(
          "SELECT status,terminal_at FROM remote_execution_attempts WHERE execution_attempt_id=?"
        )
        .get(activated.executionAttemptId)
    ).toMatchObject({ status: "superseded", terminal_at: expect.any(String) });
    expect(
      server.database
        .prepare("SELECT COUNT(*) AS count FROM remote_execution_attempts WHERE operation_id=?")
        .get(created.id)?.count
    ).toBe(2);
  });
});

describe("remote coordinator migration v9", () => {
  it("upgrades v8 in place and rejects corrupt Host capability data without recording v9", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-remote-migration-"));
    directories.push(directory);
    const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
    databases.push(database);
    database.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version,applied_at) VALUES
        (1,'2020-01-01T00:00:00.000Z'),(2,'2020-01-01T00:00:00.000Z'),
        (3,'2020-01-01T00:00:00.000Z'),(4,'2020-01-01T00:00:00.000Z'),
        (5,'2020-01-01T00:00:00.000Z'),(6,'2020-01-01T00:00:00.000Z'),
        (7,'2020-01-01T00:00:00.000Z'),(8,'2020-01-01T00:00:00.000Z');
      CREATE TABLE dispatches(
        id TEXT PRIMARY KEY,project_id TEXT NOT NULL,block_ref TEXT NOT NULL,
        package_ref TEXT NOT NULL,host_id TEXT NOT NULL,required_capabilities_json TEXT NOT NULL,
        status TEXT NOT NULL,lease_id TEXT NOT NULL UNIQUE,execution_attempt_id TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,created_at TEXT NOT NULL,accepted_at TEXT,finished_at TEXT,
        result_json TEXT,failure_json TEXT,interruption_reason TEXT,
        interruption_resumable INTEGER,interruption_recovery_json TEXT
      );
      CREATE TABLE agent_hosts(
        id TEXT PRIMARY KEY,display_name TEXT NOT NULL,credential_hash TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,capacity INTEGER NOT NULL,last_seen_at TEXT,
        last_acknowledged_sequence INTEGER NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL
      );
      INSERT INTO agent_hosts VALUES(
        'host-a','Host A','hash','["linux",',1,NULL,0,NULL,
        '2020-01-01T00:00:00.000Z'
      );
      CREATE TABLE mailbox_messages(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL UNIQUE,
        host_id TEXT NOT NULL REFERENCES agent_hosts(id),command_json TEXT NOT NULL,
        created_at TEXT NOT NULL,acknowledged_at TEXT
      );
      CREATE TABLE artifact_blobs(ref TEXT PRIMARY KEY,media_type TEXT NOT NULL);
      CREATE TABLE artifact_grants(grant_id TEXT PRIMARY KEY,expected_media_type TEXT);
    `);

    expect(() => applyMigrations(database)).toThrowError("migration_invalid_agent_host_row");
    expect(centralSchemaVersion(database)).toBe(9);
    expect(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='remote_operations'")
        .get()
    ).toBeUndefined();

    database
      .prepare("UPDATE agent_hosts SET capabilities_json=? WHERE id=?")
      .run('["linux"]', "host-a");
    applyMigrations(database);
    expect(centralSchemaVersion(database)).toBe(latestCentralSchemaVersion);
    expect(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='remote_operations'")
        .get()
    ).toBeDefined();
  });
});

describe("remote recovery migration v13", () => {
  it("preserves v12 attempt evidence and permits multiple fenced attempts and leases", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-remote-v13-migration-"));
    directories.push(directory);
    const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
    databases.push(database);
    database.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version,applied_at) VALUES
        (1,'2020-01-01T00:00:00.000Z'),(2,'2020-01-01T00:00:00.000Z'),
        (3,'2020-01-01T00:00:00.000Z'),(4,'2020-01-01T00:00:00.000Z'),
        (5,'2020-01-01T00:00:00.000Z'),(6,'2020-01-01T00:00:00.000Z'),
        (7,'2020-01-01T00:00:00.000Z'),(8,'2020-01-01T00:00:00.000Z'),
        (9,'2020-01-01T00:00:00.000Z'),(10,'2020-01-01T00:00:00.000Z'),
        (11,'2020-01-01T00:00:00.000Z'),(12,'2020-01-01T00:00:00.000Z');
      CREATE TABLE dispatches(
        id TEXT PRIMARY KEY,project_id TEXT NOT NULL,block_ref TEXT NOT NULL,
        package_ref TEXT NOT NULL,host_id TEXT NOT NULL,required_capabilities_json TEXT NOT NULL,
        status TEXT NOT NULL,lease_id TEXT NOT NULL UNIQUE,execution_attempt_id TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,created_at TEXT NOT NULL,accepted_at TEXT,finished_at TEXT,
        result_json TEXT,failure_json TEXT,interruption_reason TEXT,
        interruption_resumable INTEGER,interruption_recovery_json TEXT
      );
      CREATE TABLE agent_hosts(
        id TEXT PRIMARY KEY,display_name TEXT NOT NULL,credential_hash TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,capacity INTEGER NOT NULL,last_seen_at TEXT,
        last_acknowledged_sequence INTEGER NOT NULL DEFAULT 0,revoked_at TEXT,
        created_at TEXT NOT NULL,credential_expires_at TEXT
      );
      INSERT INTO agent_hosts(
        id,display_name,credential_hash,capabilities_json,capacity,created_at
      ) VALUES ('host-1','Host','${"a".repeat(64)}','["acp.codex"]',1,'2020-01-01T00:00:00.000Z');
      CREATE TABLE remote_operations(
        id TEXT PRIMARY KEY,project_id TEXT NOT NULL,canvas_id TEXT NOT NULL,
        block_ref TEXT NOT NULL,ownership_generation TEXT NOT NULL,idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,source_fingerprint TEXT NOT NULL,
        required_capabilities_json TEXT NOT NULL,state TEXT NOT NULL,dispatch_id TEXT NOT NULL UNIQUE,
        execution_attempt_id TEXT NOT NULL UNIQUE,envelope_digest TEXT,envelope_reference TEXT,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL,terminal_at TEXT,
        diagnostic_code TEXT,diagnostic_message TEXT
      );
      INSERT INTO remote_operations VALUES (
        'operation-1','project-1','default','RC-003#B-001','generation-1','request-1',
        '${"b".repeat(64)}','graph-1','["acp.codex"]','interrupted','dispatch-1','attempt-1',
        NULL,NULL,'2020-01-01T00:00:00.000Z','2020-01-01T00:00:01.000Z',NULL,NULL,NULL
      );
      CREATE TABLE remote_execution_attempts(
        execution_attempt_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE REFERENCES remote_operations(id),
        dispatch_id TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL,canvas_id TEXT NOT NULL,
        block_ref TEXT NOT NULL,ownership_generation TEXT NOT NULL,status TEXT NOT NULL,
        host_id TEXT REFERENCES agent_hosts(id),lease_id TEXT UNIQUE,lease_fencing_token INTEGER NOT NULL,
        lease_expires_at TEXT,state_version INTEGER NOT NULL,created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,terminal_at TEXT
      );
      INSERT INTO remote_execution_attempts VALUES (
        'attempt-1','operation-1','dispatch-1','project-1','default','RC-003#B-001',
        'generation-1','interrupted','host-1','lease-1',1,'2020-01-01T00:00:01.000Z',4,
        '2020-01-01T00:00:00.000Z','2020-01-01T00:00:01.000Z',NULL
      );
      CREATE TABLE host_capacity_reservations(
        lease_id TEXT PRIMARY KEY,execution_attempt_id TEXT NOT NULL UNIQUE REFERENCES remote_execution_attempts(execution_attempt_id),
        host_id TEXT NOT NULL REFERENCES agent_hosts(id),fencing_token INTEGER NOT NULL,
        status TEXT NOT NULL,lease_expires_at TEXT NOT NULL,version INTEGER NOT NULL,
        created_at TEXT NOT NULL,released_at TEXT
      );
      INSERT INTO host_capacity_reservations VALUES (
        'lease-1','attempt-1','host-1',1,'expired','2020-01-01T00:00:01.000Z',1,
        '2020-01-01T00:00:00.000Z','2020-01-01T00:00:01.000Z'
      );
      CREATE TABLE remote_operation_events(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL REFERENCES remote_operations(id),
        execution_attempt_id TEXT REFERENCES remote_execution_attempts(execution_attempt_id),
        type TEXT NOT NULL,occurred_at TEXT NOT NULL
      );
      INSERT INTO remote_operation_events(operation_id,execution_attempt_id,type,occurred_at)
      VALUES ('operation-1','attempt-1','remote.attempt.interrupted','2020-01-01T00:00:01.000Z');
    `);

    database.exec(`
      CREATE TRIGGER stop_before_workspace_identity
      BEFORE INSERT ON schema_migrations
      WHEN NEW.version = 27
      BEGIN
        SELECT RAISE(ABORT, 'stop_before_workspace_identity');
      END;
    `);
    expect(() => applyMigrations(database)).toThrow("stop_before_workspace_identity");
    expect(centralSchemaVersion(database)).toBe(26);
    database.exec(`
      INSERT INTO human_principals(human_principal_id,display_name,created_at)
      VALUES ('principal-1','Owner','2020-01-01T00:00:00.000Z');
      INSERT INTO project_memberships(
        membership_id,project_id,human_principal_id,role,created_at,updated_at,revoked_at
      ) VALUES (
        'membership-1','project-1','principal-1','owner',
        '2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z',NULL
      );
      DROP TRIGGER stop_before_workspace_identity;
    `);
    applyMigrations(database);
    expect(centralSchemaVersion(database)).toBe(latestCentralSchemaVersion);
    expect(
      database.prepare("SELECT status,state_version FROM remote_execution_attempts").get()
    ).toEqual({ status: "interrupted", state_version: 4 });
    expect(database.prepare("SELECT status FROM host_capacity_reservations").get()).toEqual({
      status: "expired"
    });
    expect(database.prepare("SELECT type FROM remote_operation_events").get()).toEqual({
      type: "remote.attempt.interrupted"
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    database.exec(`
      INSERT INTO remote_execution_attempts(
        execution_attempt_id,operation_id,dispatch_id,workspace_id,project_id,canvas_id,block_ref,
        ownership_generation,status,created_at,updated_at
      ) VALUES (
        'attempt-2','operation-1','dispatch-2',
        (SELECT workspace_id FROM remote_operations WHERE id='operation-1'),
        'project-1','default','RC-003#B-001',
        'generation-1','prepared','2020-01-01T00:00:02.000Z','2020-01-01T00:00:02.000Z'
      );
      INSERT INTO host_capacity_reservations(
        lease_id,execution_attempt_id,host_id,fencing_token,status,lease_expires_at,
        version,created_at,released_at
      ) VALUES (
        'lease-2','attempt-1','host-1',2,'expired','2020-01-01T00:00:02.000Z',1,
        '2020-01-01T00:00:01.000Z','2020-01-01T00:00:02.000Z'
      );
    `);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM remote_execution_attempts").get()?.count
    ).toBe(2);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM host_capacity_reservations").get()?.count
    ).toBe(2);
    expect(() =>
      database.exec(`
        INSERT INTO remote_execution_attempts(
          execution_attempt_id,operation_id,dispatch_id,workspace_id,project_id,canvas_id,block_ref,
          ownership_generation,status,created_at,updated_at
        ) VALUES (
          'attempt-duplicate-dispatch','operation-1','dispatch-2',
          (SELECT workspace_id FROM remote_operations WHERE id='operation-1'),'project-1','default',
          'RC-003#B-001','generation-1','prepared','2020-01-01T00:00:03.000Z',
          '2020-01-01T00:00:03.000Z'
        )
      `)
    ).toThrowError(/UNIQUE constraint failed/);
    expect(() =>
      database
        .prepare(
          `UPDATE remote_execution_attempts SET status='reserved',host_id='host-1',lease_id='lease-1',
             lease_fencing_token=2,lease_expires_at='2020-01-01T00:00:03.000Z'
           WHERE execution_attempt_id='attempt-2'`
        )
        .run()
    ).toThrowError(/UNIQUE constraint failed/);

    const actions = new RemoteExecutionActionRepository(database);
    expect(
      actions.record({
        actionId: "action-1",
        operationId: "operation-1",
        dispatchId: "dispatch-1",
        executionAttemptId: "attempt-1",
        expectedAttemptVersion: 4,
        kind: "block",
        leaseId: "lease-1",
        reason: "operator requires investigation"
      }).state
    ).toBe("recorded");
  });

  it("fails a v14 upgrade visibly when persisted attempt identities are ambiguous", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-remote-v15-migration-"));
    directories.push(directory);
    const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
    databases.push(database);
    database.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version,applied_at)
        SELECT value,'2020-01-01T00:00:00.000Z' FROM json_each('[1,2,3,4,5,6,7,8,9,10,11,12,13,14]');
      CREATE TABLE dispatches(
        id TEXT PRIMARY KEY,project_id TEXT NOT NULL,block_ref TEXT NOT NULL,
        package_ref TEXT NOT NULL,host_id TEXT NOT NULL,required_capabilities_json TEXT NOT NULL,
        status TEXT NOT NULL,lease_id TEXT NOT NULL UNIQUE,execution_attempt_id TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,created_at TEXT NOT NULL,accepted_at TEXT,finished_at TEXT,
        result_json TEXT,failure_json TEXT,interruption_reason TEXT,
        interruption_resumable INTEGER,interruption_recovery_json TEXT
      );
      CREATE TABLE remote_operations(
        id TEXT PRIMARY KEY,project_id TEXT NOT NULL,canvas_id TEXT NOT NULL,
        block_ref TEXT NOT NULL,ownership_generation TEXT NOT NULL,idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,source_fingerprint TEXT NOT NULL,
        required_capabilities_json TEXT NOT NULL,state TEXT NOT NULL,dispatch_id TEXT NOT NULL UNIQUE,
        execution_attempt_id TEXT NOT NULL UNIQUE,envelope_digest TEXT,envelope_reference TEXT,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL,terminal_at TEXT,
        diagnostic_code TEXT,diagnostic_message TEXT
      );
      CREATE TABLE remote_execution_attempts(
        execution_attempt_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,dispatch_id TEXT NOT NULL,
        project_id TEXT NOT NULL,canvas_id TEXT NOT NULL,block_ref TEXT NOT NULL,
        ownership_generation TEXT NOT NULL,status TEXT NOT NULL,host_id TEXT,
        lease_id TEXT,lease_fencing_token INTEGER NOT NULL,lease_expires_at TEXT,
        state_version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        terminal_at TEXT
      );
      INSERT INTO remote_execution_attempts VALUES
        ('attempt-1','operation-1','dispatch-shared','project-1','default','TASK#B-001',
         'generation-1','prepared',NULL,'lease-1',0,NULL,0,
         '2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z',NULL),
        ('attempt-2','operation-2','dispatch-shared','project-2','default','TASK#B-002',
         'generation-2','prepared',NULL,'lease-2',0,NULL,0,
         '2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z',NULL);
    `);
    expect(() => applyMigrations(database)).toThrowError(
      "migration_duplicate_remote_attempt_dispatch_identity"
    );
    expect(centralSchemaVersion(database)).toBe(14);
    database
      .prepare("UPDATE remote_execution_attempts SET dispatch_id=? WHERE execution_attempt_id=?")
      .run("dispatch-2", "attempt-2");
    applyMigrations(database);
    expect(centralSchemaVersion(database)).toBe(latestCentralSchemaVersion);
  });
});

describe("remote operation host_selection migration v18", () => {
  it("adds nullable host_selection_json for populated pending ops without inventing a snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-remote-v18-migration-"));
    directories.push(directory);
    const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
    databases.push(database);

    // Pre-v18 shape: remote_operations present without host_selection_json, with a pending row.
    database.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version,applied_at)
        SELECT value,'2020-01-01T00:00:00.000Z' FROM json_each('[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17]');
      CREATE TABLE dispatches(
        id TEXT PRIMARY KEY,project_id TEXT NOT NULL,block_ref TEXT NOT NULL,
        package_ref TEXT NOT NULL,host_id TEXT NOT NULL,required_capabilities_json TEXT NOT NULL,
        status TEXT NOT NULL,lease_id TEXT NOT NULL UNIQUE,execution_attempt_id TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,created_at TEXT NOT NULL,accepted_at TEXT,finished_at TEXT,
        result_json TEXT,failure_json TEXT,interruption_reason TEXT,
        interruption_resumable INTEGER,interruption_recovery_json TEXT
      );
      CREATE TABLE human_principals(
        human_principal_id TEXT PRIMARY KEY,display_name TEXT NOT NULL,created_at TEXT NOT NULL
      );
      CREATE TABLE project_memberships(
        membership_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,
        human_principal_id TEXT NOT NULL REFERENCES human_principals(human_principal_id),
        role TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,revoked_at TEXT
      );
      CREATE TABLE human_device_credentials(
        device_credential_id TEXT PRIMARY KEY,
        human_principal_id TEXT NOT NULL REFERENCES human_principals(human_principal_id),
        minted_for_project_id TEXT NOT NULL,label TEXT,token_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,expires_at TEXT,revoked_at TEXT,last_used_at TEXT
      );
      CREATE TABLE agent_hosts(
        id TEXT PRIMARY KEY,display_name TEXT NOT NULL,credential_hash TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,capacity INTEGER NOT NULL,last_seen_at TEXT,
        last_acknowledged_sequence INTEGER NOT NULL DEFAULT 0,revoked_at TEXT,
        created_at TEXT NOT NULL,credential_expires_at TEXT
      );
      INSERT INTO agent_hosts(
        id,display_name,credential_hash,capabilities_json,capacity,created_at
      ) VALUES (
        'host-1','Host','${"a".repeat(64)}','["acp.codex"]',1,'2020-01-01T00:00:00.000Z'
      );
      CREATE TABLE remote_operations(
        id TEXT PRIMARY KEY,project_id TEXT NOT NULL,canvas_id TEXT NOT NULL,
        block_ref TEXT NOT NULL,ownership_generation TEXT NOT NULL,idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,source_fingerprint TEXT NOT NULL,
        required_capabilities_json TEXT NOT NULL,state TEXT NOT NULL,dispatch_id TEXT NOT NULL UNIQUE,
        execution_attempt_id TEXT NOT NULL UNIQUE,envelope_digest TEXT,envelope_reference TEXT,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL,terminal_at TEXT,
        diagnostic_code TEXT,diagnostic_message TEXT
      );
      INSERT INTO remote_operations VALUES (
        'operation-pending','project-1','default','FIX-HC-002#B-001','generation-1','request-1',
        '${"b".repeat(64)}','graph-1','["acp.codex"]','claimed','dispatch-pending','attempt-pending',
        NULL,NULL,'2020-01-01T00:00:00.000Z','2020-01-01T00:00:01.000Z',NULL,NULL,NULL
      );
      CREATE TABLE remote_execution_attempts(
        execution_attempt_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES remote_operations(id),
        dispatch_id TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL,canvas_id TEXT NOT NULL,
        block_ref TEXT NOT NULL,ownership_generation TEXT NOT NULL,status TEXT NOT NULL,
        host_id TEXT REFERENCES agent_hosts(id),lease_id TEXT UNIQUE,lease_fencing_token INTEGER NOT NULL DEFAULT 0,
        lease_expires_at TEXT,state_version INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,terminal_at TEXT
      );
      INSERT INTO remote_execution_attempts VALUES (
        'attempt-pending','operation-pending','dispatch-pending','project-1','default','FIX-HC-002#B-001',
        'generation-1','prepared',NULL,NULL,0,NULL,0,
        '2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z',NULL
      );
      CREATE TABLE work_assignments(
        project_id TEXT NOT NULL,canvas_id TEXT NOT NULL,work_item_kind TEXT NOT NULL,
        work_item_key TEXT NOT NULL,target_kind TEXT NOT NULL,target_human_principal_id TEXT,
        target_host_id TEXT,revision INTEGER NOT NULL,updated_by_kind TEXT NOT NULL,
        updated_by_id TEXT NOT NULL,updated_by_display_name TEXT,updated_at TEXT NOT NULL,
        reason TEXT,PRIMARY KEY(project_id,canvas_id,work_item_kind,work_item_key)
      );
      INSERT INTO human_principals(human_principal_id,display_name,created_at)
      VALUES ('principal-1','Owner','2020-01-01T00:00:00.000Z');
      INSERT INTO project_memberships(
        membership_id,project_id,human_principal_id,role,created_at,updated_at,revoked_at
      ) VALUES (
        'membership-1','project-1','principal-1','owner',
        '2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z',NULL
      );
    `);

    expect(
      database
        .prepare(
          "SELECT 1 AS present FROM pragma_table_info('remote_operations') WHERE name='host_selection_json'"
        )
        .get()
    ).toBeUndefined();

    applyMigrations(database);
    expect(centralSchemaVersion(database)).toBe(latestCentralSchemaVersion);
    expect(
      database
        .prepare(
          "SELECT 1 AS present FROM pragma_table_info('remote_operations') WHERE name='host_selection_json'"
        )
        .get()
    ).toBeDefined();

    const row = database
      .prepare("SELECT state,host_selection_json FROM remote_operations WHERE id=?")
      .get("operation-pending") as { state: string; host_selection_json: string | null };
    expect(row.state).toBe("claimed");
    // Must remain NULL: migration must not invent a fingerprint that retargets Hosts.
    expect(row.host_selection_json).toBeNull();

    const operations = new RemoteOperationRepository(database);
    const loaded = operations.getRequired("operation-pending");
    expect(loaded.hostSelection).toBeUndefined();
    expect(loaded.state).toBe("claimed");
  });

  it("persistHostSelection fills NULL once and is idempotent against concurrent fill", async () => {
    const server = await setup();
    const operations = new RemoteOperationRepository(server.database);
    const created = operations.markClaimed(operations.create(operationInput).id);
    expect(created.hostSelection).toBeUndefined();

    const snapshot = {
      assignmentRevision: 3,
      target: { kind: "exact_host" as const, hostId: "host-exact-1" },
      selection: "exact" as const,
      preferredHostId: "host-exact-1",
      requiredCapabilities: ["linux", "acp.codex"]
    };
    const filled = operations.persistHostSelection(created.id, snapshot);
    expect(filled.hostSelection).toMatchObject(snapshot);

    // Second call with a different snapshot must not overwrite durable evidence.
    const again = operations.persistHostSelection(created.id, {
      ...snapshot,
      preferredHostId: "host-other",
      assignmentRevision: 99
    });
    expect(again.hostSelection).toMatchObject({
      preferredHostId: "host-exact-1",
      assignmentRevision: 3
    });
  });
});
