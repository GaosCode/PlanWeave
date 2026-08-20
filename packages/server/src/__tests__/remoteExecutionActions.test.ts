import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RemoteExecutionActionRepository,
  RemoteExecutionActionRejectedError,
  RemoteExecutionActionService
} from "../remoteExecutionActions.js";
import {
  applyMigrations,
  centralSchemaVersion,
  latestCentralSchemaVersion
} from "../migrations.js";
import { migrations } from "../migrations/registry.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { dispatchHostSelectionSnapshotSchema } from "../work/dispatchIntegration.js";

const directories: string[] = [];
const databases: SqliteDatabase[] = [];
const serverInstanceOwnerToken = "00000000-0000-4000-8000-000000000023";

function prepareHistoricalSchema(database: SqliteDatabase, throughVersion: number): void {
  database.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  for (const migration of migrations) {
    if (migration.version > throughVersion) break;
    if (
      database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(migration.version)
    ) {
      continue;
    }
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
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-remote-actions-"));
  directories.push(directory);
  const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
  databases.push(database);
  applyMigrations(database);
  database.exec("PRAGMA foreign_keys=OFF");
  database.exec(`
    INSERT INTO server_instance_ownership(
      singleton,owner_token,process_id,hostname,acquired_at
    ) VALUES (
      1,'${serverInstanceOwnerToken}',1,'test-host','2030-01-01T00:00:00.000Z'
    );
  `);
  let now = Date.parse("2030-01-01T00:00:00.000Z");
  return {
    repository: new RemoteExecutionActionRepository(database, () => new Date(now++)),
    database
  };
}

const cancelAction = {
  actionId: "action-1",
  operationId: "operation-1",
  dispatchId: "dispatch-1",
  executionAttemptId: "attempt-1",
  expectedAttemptVersion: 2,
  kind: "cancel",
  leaseId: "lease-1",
  reason: "operator requested cancellation"
} as const;

const retryAction = {
  actionId: "retry-action-1",
  operationId: "operation-retry-1",
  dispatchId: "dispatch-retry-1",
  executionAttemptId: "attempt-retry-1",
  expectedAttemptVersion: 4,
  kind: "retry_new_attempt",
  priorLeaseId: "lease-retry-1",
  newDispatchId: "dispatch-retry-2",
  newExecutionAttemptId: "attempt-retry-2",
  reason: "retry after lost session"
} as const;

const hostASelection = dispatchHostSelectionSnapshotSchema.parse({
  assignmentRevision: 1,
  target: { kind: "exact_host", hostId: "host-a" },
  selection: "exact",
  preferredHostId: "host-a",
  requiredCapabilities: ["acp.codex"]
});

const hostBSelection = dispatchHostSelectionSnapshotSchema.parse({
  assignmentRevision: 2,
  target: { kind: "exact_host", hostId: "host-b" },
  selection: "exact",
  preferredHostId: "host-b",
  requiredCapabilities: ["acp.codex"]
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function runningSnapshot() {
  return {
    operationId: cancelAction.operationId,
    dispatchId: cancelAction.dispatchId,
    executionAttemptId: cancelAction.executionAttemptId,
    attemptStatus: "running" as const,
    attemptVersion: cancelAction.expectedAttemptVersion,
    leaseId: cancelAction.leaseId,
    leaseFenced: false,
    hostCapabilities: []
  };
}

function retrySnapshot() {
  return {
    operationId: retryAction.operationId,
    dispatchId: retryAction.dispatchId,
    executionAttemptId: retryAction.executionAttemptId,
    attemptStatus: "interrupted" as const,
    attemptVersion: retryAction.expectedAttemptVersion,
    leaseId: retryAction.priorLeaseId,
    leaseFenced: true,
    interruption: { resumable: false },
    hostCapabilities: ["acp.codex"]
  };
}

describe("RemoteExecutionActionRepository", () => {
  it("replays an identical action and rejects an action-id payload conflict", async () => {
    const { repository } = await setup();
    const recorded = repository.record(cancelAction);
    expect(repository.record(cancelAction)).toEqual(recorded);
    expect(recorded).toMatchObject({ state: "recorded", request: cancelAction });
    expect(() =>
      repository.record({ ...cancelAction, reason: "a conflicting reason" })
    ).toThrowError("remote_action_idempotency_conflict");
  });

  it("persists each delivery phase and replays identical transitions", async () => {
    const { repository } = await setup();
    repository.record(cancelAction);
    const delivered = repository.transition(cancelAction.actionId, "delivered");
    expect(repository.transition(cancelAction.actionId, "delivered")).toEqual(delivered);
    const acknowledged = repository.transition(cancelAction.actionId, "acknowledged");
    const settled = repository.transition(cancelAction.actionId, "settled");
    expect(acknowledged.acknowledgedAt).toBeDefined();
    expect(settled).toMatchObject({ state: "settled" });
    expect(settled.settledAt).toBeDefined();
    expect(repository.listUnsettled()).toEqual([]);
  });

  it("persists policy rejection as a terminal non-replayable action", async () => {
    const { repository } = await setup();
    let applications = 0;
    const service = new RemoteExecutionActionService(
      repository,
      {
        snapshot: (request) => ({
          operationId: request.operationId,
          dispatchId: request.dispatchId,
          executionAttemptId: request.executionAttemptId,
          attemptStatus: "running",
          attemptVersion: request.expectedAttemptVersion,
          leaseId: request.kind === "cancel" ? request.leaseId : undefined,
          leaseFenced: false,
          hostCapabilities: []
        }),
        apply: () => {
          applications += 1;
          throw new RemoteExecutionActionRejectedError("work_not_agent_assigned");
        }
      },
      serverInstanceOwnerToken
    );

    await expect(service.execute(cancelAction)).rejects.toMatchObject({
      code: "work_not_agent_assigned"
    });
    expect(repository.getRequired(cancelAction.actionId)).toMatchObject({
      state: "rejected",
      rejectionCode: "work_not_agent_assigned"
    });
    expect(repository.getRequired(cancelAction.actionId).rejectedAt).toBeDefined();
    expect(repository.listUnsettled()).toEqual([]);

    await expect(service.execute(cancelAction)).rejects.toMatchObject({
      code: "work_not_agent_assigned"
    });
    expect(applications).toBe(1);
  });

  it("advances command actions from mailbox acknowledgement to attempt settlement", async () => {
    const { repository } = await setup();
    repository.record(cancelAction);
    expect(repository.acknowledgeMailbox(cancelAction.actionId)).toMatchObject({
      state: "acknowledged"
    });
    expect(
      repository.settleAttemptCommands({
        dispatchId: cancelAction.dispatchId,
        executionAttemptId: cancelAction.executionAttemptId,
        kinds: ["cancel"]
      })
    ).toMatchObject([{ state: "settled" }]);
    expect(repository.listUnsettled()).toEqual([]);
  });

  it("recovers an application effect before stale snapshot validation", async () => {
    const { repository } = await setup();
    let snapshots = 0;
    const service = new RemoteExecutionActionService(
      repository,
      {
        recover: () => "settled",
        snapshot: () => {
          snapshots += 1;
          throw new Error("stale_snapshot_must_not_be_read");
        },
        apply: () => {
          throw new Error("effect_must_not_be_reapplied");
        }
      },
      serverInstanceOwnerToken
    );
    await expect(service.execute(cancelAction)).resolves.toMatchObject({ state: "settled" });
    expect(snapshots).toBe(0);
  });

  it("fails closed on invalid transition and persisted payload tampering", async () => {
    const { repository, database } = await setup();
    repository.record(cancelAction);
    expect(() => repository.transition(cancelAction.actionId, "acknowledged")).toThrowError(
      "remote_action_state_transition_invalid"
    );
    database
      .prepare("UPDATE remote_execution_actions SET request_json=? WHERE action_id=?")
      .run(JSON.stringify({ ...cancelAction, leaseId: "lease-foreign" }), cancelAction.actionId);
    expect(() => repository.getRequired(cancelAction.actionId)).toThrowError(
      "remote_action_row_payload_mismatch"
    );
  });

  it("persists an exact action before invoking its application side effect", async () => {
    const { repository, database } = await setup();
    const applied: string[] = [];
    const service = new RemoteExecutionActionService(
      repository,
      {
        snapshot: (request) => ({
          operationId: request.operationId,
          dispatchId: request.dispatchId,
          executionAttemptId: request.executionAttemptId,
          attemptStatus: "running",
          attemptVersion: request.expectedAttemptVersion,
          leaseId: request.kind === "cancel" ? request.leaseId : undefined,
          leaseFenced: false,
          hostCapabilities: []
        }),
        apply: (request, decision) => {
          expect(
            database
              .prepare("SELECT state FROM remote_execution_actions WHERE action_id=?")
              .get(request.actionId)?.state
          ).toBe("recorded");
          expect(decision).toEqual({ transition: "cancel", sendsCommand: true });
          applied.push(request.actionId);
          return "delivered";
        }
      },
      serverInstanceOwnerToken
    );

    await expect(service.execute(cancelAction)).resolves.toMatchObject({ state: "delivered" });
    await expect(service.execute(cancelAction)).resolves.toMatchObject({ state: "delivered" });
    expect(applied).toEqual([cancelAction.actionId]);
  });

  it("joins identical concurrent execution within one service", async () => {
    const { repository } = await setup();
    const entered = deferred<void>();
    const resume = deferred<void>();
    let applications = 0;
    const service = new RemoteExecutionActionService(
      repository,
      {
        snapshot: runningSnapshot,
        apply: async () => {
          applications += 1;
          entered.resolve();
          await resume.promise;
          return "delivered";
        }
      },
      serverInstanceOwnerToken
    );

    const first = service.execute(cancelAction);
    await entered.promise;
    const second = service.execute(cancelAction);
    expect(second).toBe(first);
    resume.resolve();
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { state: "delivered" },
      { state: "delivered" }
    ]);
    expect(applications).toBe(1);
  });

  it("uses the database claim as authority across service and repository instances", async () => {
    const { repository, database } = await setup();
    const entered = deferred<void>();
    const resume = deferred<void>();
    const winner = new RemoteExecutionActionService(
      repository,
      {
        snapshot: runningSnapshot,
        apply: async () => {
          entered.resolve();
          await resume.promise;
          return "delivered";
        }
      },
      serverInstanceOwnerToken
    );
    const loser = new RemoteExecutionActionService(
      new RemoteExecutionActionRepository(database),
      {
        snapshot: () => {
          throw new Error("loser_must_not_snapshot");
        },
        apply: () => {
          throw new Error("loser_must_not_apply");
        }
      },
      serverInstanceOwnerToken
    );

    const winning = winner.execute(cancelAction);
    await entered.promise;
    await expect(loser.execute(cancelAction)).rejects.toThrow("remote_action_in_progress");
    resume.resolve();
    await expect(winning).resolves.toMatchObject({ state: "delivered" });
  });

  it("allows an explicit startup owner to recover a claim left by a crashed owner", async () => {
    const { repository, database } = await setup();
    repository.record(cancelAction);
    repository.claimApplication(cancelAction.actionId, serverInstanceOwnerToken);
    const restartedOwnerToken = "00000000-0000-4000-8000-000000000024";
    database
      .prepare(
        `UPDATE server_instance_ownership SET owner_token=?
         WHERE singleton=1 AND owner_token=?`
      )
      .run(restartedOwnerToken, serverInstanceOwnerToken);
    let recovered = 0;
    const restarted = new RemoteExecutionActionService(
      new RemoteExecutionActionRepository(database),
      {
        recover: () => {
          recovered += 1;
          return "settled";
        },
        snapshot: () => {
          throw new Error("startup_recovery_must_precede_snapshot");
        },
        apply: () => {
          throw new Error("startup_recovery_must_not_reapply");
        }
      },
      restartedOwnerToken
    );

    await expect(
      restarted.reconcile({ serverInstanceOwnerToken: restartedOwnerToken })
    ).resolves.toMatchObject([{ state: "settled" }]);
    expect(recovered).toBe(1);
  });

  it("reuses the durable decision after startup takeover instead of resnapshotting", async () => {
    const { repository, database } = await setup();
    repository.record(cancelAction);
    repository.claimApplication(cancelAction.actionId, serverInstanceOwnerToken);
    repository.recordApplicationPlan(
      cancelAction.actionId,
      serverInstanceOwnerToken,
      { transition: "cancel", sendsCommand: true },
      { authorizedHostId: "host-before-crash", assignmentRevision: 7 }
    );
    const restartedOwnerToken = "00000000-0000-4000-8000-000000000025";
    database
      .prepare("UPDATE server_instance_ownership SET owner_token=? WHERE singleton=1")
      .run(restartedOwnerToken);
    let appliedDecision: unknown;
    let appliedContext: unknown;
    const restarted = new RemoteExecutionActionService(
      new RemoteExecutionActionRepository(database),
      {
        recover: () => undefined,
        snapshot: () => {
          throw new Error("durable_decision_must_skip_changed_snapshot");
        },
        apply: (_request, decision, context) => {
          appliedDecision = decision;
          appliedContext = context;
          return "delivered";
        }
      },
      restartedOwnerToken
    );

    await expect(
      restarted.reconcile({ serverInstanceOwnerToken: restartedOwnerToken })
    ).resolves.toMatchObject([{ state: "delivered" }]);
    expect(appliedDecision).toEqual({ transition: "cancel", sendsCommand: true });
    expect(appliedContext).toEqual({
      authorizedHostId: "host-before-crash",
      assignmentRevision: 7
    });
  });

  it.each([
    "same_service",
    "new_service",
    "startup"
  ] as const)("retains a retry plan after an apply error for %s recovery", async (recoveryMode) => {
    const { repository, database } = await setup();
    let snapshots = 0;
    let preparations = 0;
    let firstApply = true;
    let currentSelection = hostASelection;
    const appliedSelections: string[] = [];
    const application = {
      recover: () => undefined,
      snapshot: () => {
        snapshots += 1;
        return retrySnapshot();
      },
      prepare: () => {
        preparations += 1;
        return currentSelection;
      },
      apply: (_request: unknown, _decision: unknown, context?: unknown) => {
        const selection = dispatchHostSelectionSnapshotSchema.parse(context);
        appliedSelections.push(selection.preferredHostId ?? "");
        if (firstApply) {
          firstApply = false;
          throw new Error("injected_after_external_side_effect");
        }
        return "settled" as const;
      }
    };
    const firstService = new RemoteExecutionActionService(
      repository,
      application,
      serverInstanceOwnerToken
    );

    await expect(firstService.execute(retryAction)).rejects.toThrow(
      "injected_after_external_side_effect"
    );
    const row = database
      .prepare(
        `SELECT application_owner_token,application_claimed_at,application_decision_json
           FROM remote_execution_actions WHERE action_id=?`
      )
      .get(retryAction.actionId);
    expect(row).toMatchObject({
      application_owner_token: null,
      application_claimed_at: null
    });
    expect(JSON.parse(String(row?.application_decision_json))).toMatchObject({
      decision: { transition: "retry" },
      context: { preferredHostId: "host-a", assignmentRevision: 1 }
    });

    currentSelection = hostBSelection;
    let recoveryService = firstService;
    let recoveryOwnerToken = serverInstanceOwnerToken;
    if (recoveryMode !== "same_service") {
      if (recoveryMode === "startup") {
        recoveryOwnerToken = "00000000-0000-4000-8000-000000000026";
        database
          .prepare("UPDATE server_instance_ownership SET owner_token=? WHERE singleton=1")
          .run(recoveryOwnerToken);
      }
      recoveryService = new RemoteExecutionActionService(
        new RemoteExecutionActionRepository(database),
        {
          recover: () => undefined,
          snapshot: () => {
            throw new Error("retained_plan_must_skip_snapshot");
          },
          prepare: () => {
            throw new Error("retained_plan_must_skip_prepare");
          },
          apply: application.apply
        },
        recoveryOwnerToken
      );
    }

    const recovered =
      recoveryMode === "startup"
        ? await recoveryService.reconcile({ serverInstanceOwnerToken: recoveryOwnerToken })
        : [await recoveryService.execute(retryAction)];
    expect(recovered).toMatchObject([{ state: "settled" }]);
    expect(appliedSelections).toEqual(["host-a", "host-a"]);
    expect(snapshots).toBe(1);
    expect(preparations).toBe(1);
  });

  it.each([
    "snapshot",
    "prepare"
  ] as const)("discards the claim and plan when %s fails before apply", async (failureStage) => {
    const { repository, database } = await setup();
    const service = new RemoteExecutionActionService(
      repository,
      {
        recover: () => undefined,
        snapshot: () => {
          if (failureStage === "snapshot") throw new Error("injected_snapshot_failure");
          return retrySnapshot();
        },
        prepare: () => {
          if (failureStage === "prepare") throw new Error("injected_prepare_failure");
          return hostASelection;
        },
        apply: () => {
          throw new Error("apply_must_not_run");
        }
      },
      serverInstanceOwnerToken
    );

    await expect(service.execute(retryAction)).rejects.toThrow(`injected_${failureStage}_failure`);
    expect(
      database
        .prepare(
          `SELECT application_owner_token,application_claimed_at,application_decision_json
             FROM remote_execution_actions WHERE action_id=?`
        )
        .get(retryAction.actionId)
    ).toEqual({
      application_owner_token: null,
      application_claimed_at: null,
      application_decision_json: null
    });
  });
});

describe("remote execution action migration v22", () => {
  it("preserves historical action states without inferring rejection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-remote-actions-v22-"));
    directories.push(directory);
    const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
    databases.push(database);
    const requestJson = JSON.stringify(cancelAction);
    const fingerprint = createHash("sha256").update(requestJson).digest("hex");
    prepareHistoricalSchema(database, 21);
    database
      .prepare(
        `INSERT INTO remote_operations(
          id,project_id,canvas_id,block_ref,ownership_generation,idempotency_key,
          request_fingerprint,source_fingerprint,required_capabilities_json,state,dispatch_id,
          execution_attempt_id,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,'preparing',?,?,?,?)`
      )
      .run(
        cancelAction.operationId,
        "project-a",
        "default",
        "T-001#B-001",
        "generation-1",
        "key-1",
        fingerprint,
        "source-1",
        "[]",
        cancelAction.dispatchId,
        cancelAction.executionAttemptId,
        "2030-01-01T00:00:00.000Z",
        "2030-01-01T00:00:00.000Z"
      );
    database
      .prepare(
        `INSERT INTO remote_execution_attempts(
          execution_attempt_id,operation_id,dispatch_id,project_id,canvas_id,block_ref,
          ownership_generation,status,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,'prepared',?,?)`
      )
      .run(
        cancelAction.executionAttemptId,
        cancelAction.operationId,
        cancelAction.dispatchId,
        "project-a",
        "default",
        "T-001#B-001",
        "generation-1",
        "2030-01-01T00:00:00.000Z",
        "2030-01-01T00:00:00.000Z"
      );
    database
      .prepare(
        `INSERT INTO remote_execution_actions(
          action_id,operation_id,dispatch_id,execution_attempt_id,kind,
          request_fingerprint,request_json,state,created_at
        ) VALUES (?,?,?,?,?,?,?,'recorded',?)`
      )
      .run(
        cancelAction.actionId,
        cancelAction.operationId,
        cancelAction.dispatchId,
        cancelAction.executionAttemptId,
        cancelAction.kind,
        fingerprint,
        requestJson,
        "2030-01-01T00:00:00.000Z"
      );

    prepareHistoricalSchema(database, 28);
    database.exec(`
      INSERT INTO workspaces(workspace_id,display_name,created_at,archived_at)
      VALUES ('workspace-a','Workspace A','2030-01-01T00:00:00.000Z',NULL);
      INSERT INTO project_registry(
        project_registry_id,workspace_id,project_id,project_root_internal,visibility,
        owner_human_principal_id,acl_revision,created_at,updated_at,revoked_at
      ) VALUES (
        'registry-a','workspace-a','project-a',NULL,'private',NULL,0,
        '2030-01-01T00:00:00.000Z','2030-01-01T00:00:00.000Z',NULL
      );
    `);

    applyMigrations(database);

    expect(centralSchemaVersion(database)).toBe(latestCentralSchemaVersion);
    expect(latestCentralSchemaVersion).toBe(51);
    expect(
      new RemoteExecutionActionRepository(database).getRequired(cancelAction.actionId)
    ).toMatchObject({
      state: "recorded",
      rejectedAt: undefined,
      rejectionCode: undefined
    });
  });
});
