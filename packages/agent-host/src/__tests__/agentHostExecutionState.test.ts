import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exampleExecuteDelivery } from "@planweave-ai/agent-host-protocol";
import { openAgentHostState, type AgentHostState } from "../state/agentHostState.js";
import { acpCapabilitySnapshotTestValue } from "./support/acpCapabilitySnapshotTestValues.js";
import { openAgentHostRemoteExecutionOutbox } from "../state/remoteExecutionOutbox.js";
import { openAgentHostDatabase } from "../state/sqliteDatabase.js";

const directories: string[] = [];
const states: AgentHostState[] = [];

afterEach(async () => {
  for (const state of states.splice(0)) state.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup(limits: Parameters<typeof openAgentHostState>[2] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "planweave-agent-host-execution-state-"));
  directories.push(directory);
  const path = join(directory, "state.sqlite");
  const state = await openAgentHostState(path, 5_000, limits);
  states.push(state);
  return { directory, path, state };
}

function executeMessage(sequence = 1, command = exampleExecuteDelivery.command) {
  return {
    type: "mailbox.message" as const,
    protocolVersion: 1 as const,
    sequence,
    previousSequence: sequence - 1,
    messageId: `mailbox-evidence-${sequence}`,
    command: {
      ...command,
      leaseId: "lease-evidence-1",
      leaseExpiresAt: "2030-01-01T00:00:00.000Z"
    }
  };
}

function identity() {
  return {
    dispatchId: exampleExecuteDelivery.command.dispatchId,
    leaseId: "lease-evidence-1",
    executionAttemptId: exampleExecuteDelivery.command.executionAttemptId
  };
}

function lifecycleRecord(sequence: number, state: "connecting" | "running" = "connecting") {
  return {
    kind: "engine_event" as const,
    identity: identity(),
    event: {
      kind: "lifecycle" as const,
      state,
      sequence,
      timestamp: `2026-07-23T00:00:0${sequence}.000Z`
    }
  };
}

describe("authoritative Agent Host execution state", () => {
  it("persists exact immutable execution identity before mailbox acknowledgement", async () => {
    const { state } = await setup();
    const received = state.receive(executeMessage());

    expect(state.executionEvidence(1)).toMatchObject({
      ...identity(),
      protocolVersion: 1,
      envelopeDigest: exampleExecuteDelivery.command.envelopeDigest,
      envelopeVersion: 1,
      workspaceId: exampleExecuteDelivery.command.envelope.workspaceId,
      agentProfileId: exampleExecuteDelivery.command.envelope.agentProfileId,
      sourceRevision: exampleExecuteDelivery.command.envelope.sourceRevision,
      status: "accepted",
      eventCursor: 0,
      actionCursor: 0
    });
    expect(state.lastAcknowledgedSequence()).toBe(0);

    state.acknowledgeEvent(received.acknowledgement.messageId);
    expect(state.lastAcknowledgedSequence()).toBe(1);
  });

  it("deduplicates the same execution command under a new mailbox message and rejects conflicts", async () => {
    const { state } = await setup();
    state.receive(executeMessage(1));
    expect(state.receive(executeMessage(2))).toMatchObject({ stored: true });
    expect(state.pendingExecutions(10)).toHaveLength(1);

    const conflicting = executeMessage(3);
    expect(() =>
      state.receive({
        ...conflicting,
        command: { ...conflicting.command, leaseExpiresAt: "2031-01-01T00:00:00.000Z" }
      })
    ).toThrow("execution_identity_conflict");
    expect(state.pendingEvents()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "mailbox.ack", sequence: 3 })])
    );
  });

  it("enforces legal transitions and atomically rolls back terminal evidence on failure", async () => {
    const { state } = await setup();
    state.receive(executeMessage());
    expect(() =>
      state.completeExecution(1, {
        summary: "not running",
        reportArtifactRef: `artifact:sha256:${"a".repeat(64)}`,
        artifactRefs: []
      })
    ).toThrow("execution_transition_invalid:accepted:completed");
    expect(state.executionEvidence(1)?.status).toBe("accepted");
    expect(state.pendingEvents()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "dispatch.completed" })])
    );

    expect(state.startExecution(1)?.status).toBe("running");
    expect(state.startExecution(1)).toBeUndefined();
  });

  it("fences session, event, action, and artifact evidence by exact identity", async () => {
    const { state } = await setup();
    state.receive(executeMessage());
    state.startExecution(1);
    state.recordSessionEvidence(1, {
      sessionId: "acp-session-1",
      capabilitySnapshot: acpCapabilitySnapshotTestValue(),
      recoveryId: "recovery-1"
    });
    expect(state.advanceEventCursor(1, 0, 2)).toBe(2);
    expect(() => state.advanceEventCursor(1, 0, 3)).toThrow("execution_event_cursor_conflict");

    const action = {
      leaseId: "lease-evidence-1",
      sessionId: "acp-session-1",
      actionId: "action-1",
      kind: "permission",
      deadline: "2030-01-01T00:00:00.000Z",
      requestDigest: `sha256:${"b".repeat(64)}`,
      afterCursor: 0,
      cursor: 1
    };
    expect(state.recordInteractionAction(1, action)).toBe(true);
    expect(state.recordInteractionAction(1, action)).toBe(false);
    expect(() =>
      state.recordInteractionAction(1, {
        ...action,
        actionId: "action-stale",
        leaseId: "lease-stale",
        afterCursor: 1,
        cursor: 2
      })
    ).toThrow("execution_action_stale_lease");
    expect(
      state.settleInteractionAction(1, {
        leaseId: "lease-evidence-1",
        sessionId: "acp-session-1",
        actionId: "action-1",
        response: {
          type: "interaction.permission_response",
          ...identity(),
          acpSessionId: "acp-session-1",
          actionId: "action-1",
          decision: "allow_once"
        }
      })
    ).toBe(true);
    expect(
      state.settleInteractionAction(1, {
        leaseId: "lease-evidence-1",
        sessionId: "acp-session-1",
        actionId: "action-1",
        response: {
          type: "interaction.permission_response",
          ...identity(),
          acpSessionId: "acp-session-1",
          actionId: "action-1",
          decision: "allow_once"
        }
      })
    ).toBe(false);
    expect(() =>
      state.settleInteractionAction(1, {
        leaseId: "lease-evidence-1",
        sessionId: "acp-session-1",
        actionId: "action-1",
        response: {
          type: "interaction.permission_response",
          ...identity(),
          acpSessionId: "acp-session-1",
          actionId: "action-1",
          decision: "deny"
        }
      })
    ).toThrow("execution_action_response_conflict");

    const artifact = {
      operationId: "artifact-operation-1",
      direction: "report",
      artifactRef: `artifact:sha256:${"c".repeat(64)}`,
      sha256: "c".repeat(64),
      sizeBytes: 42,
      mediaType: "text/markdown"
    };
    expect(state.recordArtifactTransfer(1, identity().leaseId, artifact)).toBe(true);
    expect(state.recordArtifactTransfer(1, identity().leaseId, artifact)).toBe(false);
    expect(() =>
      state.recordArtifactTransfer(1, identity().leaseId, { ...artifact, sizeBytes: 43 })
    ).toThrow("execution_artifact_identity_conflict");
    expect(state.executionEvidence(1)).toMatchObject({
      acpSessionId: "acp-session-1",
      recoveryId: "recovery-1",
      eventCursor: 2,
      actionCursor: 1
    });
  });

  it("persists terminal digest and delivery acknowledgement idempotently", async () => {
    const { state } = await setup();
    state.receive(executeMessage());
    state.startExecution(1);
    const result = {
      summary: "completed",
      reportArtifactRef: `artifact:sha256:${"d".repeat(64)}` as const,
      artifactRefs: []
    };
    state.completeExecution(1, result);
    state.completeExecution(1, result);
    const completed = state.pendingEvents().find((event) => event.type === "dispatch.completed");
    expect(completed).toBeDefined();
    expect(state.executionEvidence(1)).toMatchObject({
      status: "completed",
      terminalKind: "completed",
      terminalEventMessageId: completed?.messageId
    });
    expect(state.executionEvidence(1)?.terminalPayloadDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    state.acknowledgeEvent(completed?.messageId ?? "missing");
    expect(state.executionEvidence(1)?.terminalAcknowledgedAt).toBeDefined();
  });

  it("classifies an expired running lease as interrupted and action-required across reopen", async () => {
    const { path, state } = await setup();
    state.receive(executeMessage());
    state.startExecution(1);

    expect(state.abandonExpiredExecutions(new Date("2031-01-01T00:00:00.000Z"))).toHaveLength(1);
    expect(state.executionEvidence(1)).toMatchObject({
      status: "interrupted",
      recoveryIntent: { kind: "lease_lost", actionRequired: true }
    });
    expect(state.pendingEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "dispatch.interrupted", reason: "lease_lost" })
      ])
    );
    expect(state.pendingEvents()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "dispatch.failed" })])
    );

    state.close();
    states.pop();
    const reopened = await openAgentHostState(path);
    states.push(reopened);
    expect(reopened.executionEvidence(1)?.status).toBe("interrupted");
    expect(reopened.recoverInterruptedExecutions()).toBe(0);
  });

  it("enforces bounded action, artifact, and remote record retention", async () => {
    const { state } = await setup({
      maxActionsPerExecution: 1,
      maxArtifactsPerExecution: 1,
      maxRemoteRecordsPerExecution: 1
    });
    state.receive(executeMessage());
    state.startExecution(1);
    state.recordSessionEvidence(1, {
      sessionId: "acp-session-retention",
      capabilitySnapshot: acpCapabilitySnapshotTestValue(false)
    });
    state.recordInteractionAction(1, {
      leaseId: "lease-evidence-1",
      sessionId: "acp-session-retention",
      actionId: "action-1",
      kind: "permission",
      deadline: "2030-01-01T00:00:00.000Z",
      requestDigest: `sha256:${"e".repeat(64)}`,
      afterCursor: 0,
      cursor: 1
    });
    expect(() =>
      state.recordInteractionAction(1, {
        leaseId: "lease-evidence-1",
        sessionId: "acp-session-retention",
        actionId: "action-2",
        kind: "permission",
        deadline: "2030-01-01T00:00:00.000Z",
        requestDigest: `sha256:${"f".repeat(64)}`,
        afterCursor: 1,
        cursor: 2
      })
    ).toThrow("execution_action_retention_limit_exceeded");
    state.recordArtifactTransfer(1, identity().leaseId, {
      operationId: "artifact-1",
      direction: "output",
      artifactRef: `artifact:sha256:${"1".repeat(64)}`,
      sha256: "1".repeat(64),
      sizeBytes: 1,
      mediaType: "application/octet-stream"
    });
    expect(() =>
      state.recordArtifactTransfer(1, identity().leaseId, {
        operationId: "artifact-2",
        direction: "output",
        artifactRef: `artifact:sha256:${"2".repeat(64)}`,
        sha256: "2".repeat(64),
        sizeBytes: 1,
        mediaType: "application/octet-stream"
      })
    ).toThrow("execution_artifact_retention_limit_exceeded");
    state.append(lifecycleRecord(1));
    expect(() => state.append(lifecycleRecord(2, "running"))).toThrow(
      "remote_execution_record_retention_limit_exceeded"
    );
  });

  it("migrates prototype lifecycle state forward without retaining a second state authority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-agent-host-prototype-state-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const database = await openAgentHostDatabase(path, 5_000);
    database.exec(`
      CREATE TABLE agent_host_inbox (
        sequence INTEGER PRIMARY KEY,
        previous_sequence INTEGER NOT NULL DEFAULT 0,
        message_id TEXT NOT NULL UNIQUE,
        command_json TEXT NOT NULL,
        execution_status TEXT,
        lease_expires_at TEXT,
        received_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        acknowledged_at TEXT,
        processed_at TEXT
      );
      CREATE TABLE agent_host_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        event_key TEXT NOT NULL UNIQUE,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        acknowledged_at TEXT
      );
    `);
    const message = executeMessage();
    database
      .prepare(
        `INSERT INTO agent_host_inbox(
          sequence,previous_sequence,message_id,command_json,execution_status,
          lease_expires_at,received_at,started_at
        ) VALUES(?,?,?,?,?,?,?,?)`
      )
      .run(
        1,
        0,
        message.messageId,
        JSON.stringify(message.command),
        "running",
        message.command.leaseExpiresAt,
        "2026-07-23T00:00:00.000Z",
        "2026-07-23T00:00:01.000Z"
      );
    database.close();

    const state = await openAgentHostState(path);
    states.push(state);
    expect(state.executionEvidence(1)).toMatchObject({ status: "running", ...identity() });
    state.close();
    states.pop();

    const inspected = await openAgentHostDatabase(path, 5_000);
    expect(inspected.prepare("SELECT execution_status FROM agent_host_inbox").get()).toMatchObject({
      execution_status: null
    });
    inspected.close();
  });

  it("rejects a state database created by a newer schema version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-agent-host-future-state-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const database = await openAgentHostDatabase(path, 5_000);
    database.exec(`
      CREATE TABLE agent_host_state_schema (
        singleton INTEGER PRIMARY KEY,
        version INTEGER NOT NULL,
        migrated_at TEXT NOT NULL
      );
      INSERT INTO agent_host_state_schema VALUES(1,99,'2026-07-23T00:00:00.000Z');
    `);
    database.close();

    await expect(openAgentHostState(path)).rejects.toThrow(
      "agent_host_state_schema_version_unsupported"
    );
  });

  it("imports the legacy remote outbox idempotently, preserves the source, and fails closed", async () => {
    const { directory, state } = await setup();
    state.receive(executeMessage());
    const legacyPath = join(directory, "remote-execution.sqlite");
    const legacy = await openAgentHostRemoteExecutionOutbox(legacyPath);
    legacy.append(lifecycleRecord(1));
    legacy.close();

    await expect(state.importLegacyRemoteExecutionStore(legacyPath)).resolves.toEqual({
      imported: 1,
      replayed: 0,
      sourcePresent: true
    });
    await expect(state.importLegacyRemoteExecutionStore(legacyPath)).resolves.toEqual({
      imported: 0,
      replayed: 1,
      sourcePresent: true
    });
    expect((await stat(legacyPath)).isFile()).toBe(true);

    const tampered = await openAgentHostDatabase(legacyPath, 5_000);
    tampered
      .prepare("UPDATE agent_host_remote_execution_outbox SET record_json=? WHERE sequence=1")
      .run(JSON.stringify(lifecycleRecord(1, "running")));
    tampered.close();
    await expect(state.importLegacyRemoteExecutionStore(legacyPath)).rejects.toThrow(
      "remote_execution_outbox_conflict"
    );
    expect(state.records(identity())).toEqual([lifecycleRecord(1)]);
  });
});
