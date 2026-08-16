import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exampleExecuteDelivery,
  executeBlockCommandSchema,
  hashExecutionEnvelope
} from "@planweave-ai/agent-host-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openAgentHostState, type AgentHostState } from "../state/agentHostState.js";
import { openAgentHostDatabase } from "../state/sqliteDatabase.js";
import { acpCapabilitySnapshotTestValue } from "./support/acpCapabilitySnapshotTestValues.js";

const directories: string[] = [];
const states: AgentHostState[] = [];

afterEach(async () => {
  for (const state of states.splice(0)) state.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-agent-host-recovery-"));
  directories.push(directory);
  const path = join(directory, "host.sqlite");
  const state = await openAgentHostState(path);
  states.push(state);
  return { path, state };
}

function executeDelivery(sequence = 1, command = exampleExecuteDelivery.command) {
  return {
    type: "mailbox.message" as const,
    protocolVersion: 1 as const,
    sequence,
    previousSequence: sequence - 1,
    messageId: `mailbox-recovery-${sequence}`,
    command
  };
}

function resumeDelivery(sequence = 2, leaseExpiresAt = "2030-01-01T01:00:00.000Z") {
  return {
    type: "mailbox.message" as const,
    protocolVersion: 1 as const,
    sequence,
    previousSequence: sequence - 1,
    messageId: `mailbox-recovery-${sequence}`,
    command: {
      type: "resume_execution" as const,
      protocolVersion: 1 as const,
      dispatchId: exampleExecuteDelivery.command.dispatchId,
      leaseId: "lease-resumed-002",
      executionAttemptId: exampleExecuteDelivery.command.executionAttemptId,
      priorRecovery: { acpSessionId: "acp-session-1", recoveryId: "recovery-1" },
      leaseExpiresAt
    }
  };
}

function cancelDelivery(sequence: number, leaseId: string) {
  return {
    type: "mailbox.message" as const,
    protocolVersion: 1 as const,
    sequence,
    previousSequence: sequence - 1,
    messageId: `mailbox-recovery-${sequence}`,
    command: {
      type: "cancel_execution" as const,
      protocolVersion: 1 as const,
      dispatchId: exampleExecuteDelivery.command.dispatchId,
      leaseId,
      executionAttemptId: exampleExecuteDelivery.command.executionAttemptId,
      reason: "Operator cancelled recovery."
    }
  };
}

async function interruptedState(loadSession = true) {
  const { path, state } = await setup();
  state.receive(executeDelivery());
  state.startExecution(1);
  state.recordSessionEvidence(1, {
    sessionId: "acp-session-1",
    capabilitySnapshot: acpCapabilitySnapshotTestValue(loadSession),
    recoveryId: "recovery-1"
  });
  state.close();
  states.pop();
  const reopened = await openAgentHostState(path);
  states.push(reopened);
  expect(reopened.recoverInterruptedExecutions()).toBe(1);
  return reopened;
}

async function legacyInterruptedState() {
  const { path, state } = await setup();
  state.receive(executeDelivery());
  state.startExecution(1);
  state.recordSessionEvidence(1, {
    sessionId: "acp-session-1",
    capabilitySnapshot: acpCapabilitySnapshotTestValue(),
    recoveryId: "recovery-1"
  });
  state.close();
  states.pop();
  const database = await openAgentHostDatabase(path, 1_000);
  database
    .prepare("UPDATE agent_host_executions SET acp_capabilities_json=? WHERE inbox_sequence=1")
    .run(JSON.stringify({ loadSession: true, closeSession: false }));
  database.close();
  const reopened = await openAgentHostState(path);
  states.push(reopened);
  expect(reopened.recoverInterruptedExecutions()).toBe(1);
  return reopened;
}

describe("Agent Host explicit recovery", () => {
  it("replaces a stale unacknowledged heartbeat after crash recovery", async () => {
    const { path, state } = await setup();
    state.receive(executeDelivery());
    state.startExecution(1);
    const staleHeartbeat = state.queueHeartbeat(state.activeLeases());
    expect(staleHeartbeat).toMatchObject({
      type: "host.heartbeat",
      activeLeases: [expect.objectContaining({ leaseId: exampleExecuteDelivery.command.leaseId })]
    });
    state.close();
    states.pop();

    const reopened = await openAgentHostState(path);
    states.push(reopened);
    expect(reopened.recoverInterruptedExecutions()).toBe(1);
    const recoveredHeartbeat = reopened.queueHeartbeat(reopened.activeLeases());

    expect(recoveredHeartbeat.messageId).not.toBe(staleHeartbeat.messageId);
    expect(recoveredHeartbeat).toMatchObject({ type: "host.heartbeat", activeLeases: [] });
    expect(reopened.acknowledgeEvent(staleHeartbeat.messageId)).toBe(false);
    expect(reopened.pendingEvents().filter((event) => event.type === "host.heartbeat")).toEqual([
      recoveredHeartbeat
    ]);
    expect(reopened.pendingEvents()).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "dispatch.interrupted" })])
    );
  });

  it("classifies accepted startup work as interrupted instead of automatically rerunning it", async () => {
    const { path, state } = await setup();
    state.receive(executeDelivery());
    state.close();
    states.pop();

    const reopened = await openAgentHostState(path);
    states.push(reopened);
    expect(reopened.recoverInterruptedExecutions()).toBe(1);
    expect(reopened.pendingExecutions(1)).toEqual([]);
    expect(reopened.executionEvidence(1)?.status).toBe("interrupted");
    expect(reopened.pendingEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "dispatch.interrupted", resumable: false })
      ])
    );
  });

  it("atomically fences the old lease and resumes only the exact stored session", async () => {
    const state = await interruptedState();
    const resume = resumeDelivery();

    expect(state.receive(resume).stored).toBe(true);
    expect(state.pendingResumptions(1)).toHaveLength(1);
    expect(state.activeLeases()).toEqual([
      {
        dispatchId: resume.command.dispatchId,
        leaseId: resume.command.leaseId,
        executionAttemptId: resume.command.executionAttemptId
      }
    ]);
    expect(state.pendingResumptions(1)[0]?.command).toMatchObject({
      leaseId: resume.command.leaseId,
      leaseExpiresAt: resume.command.leaseExpiresAt
    });
    expect(state.executionEvidence(1)?.recoveryIntent).toEqual(
      expect.objectContaining({
        kind: "resume_same_session",
        leaseId: resume.command.leaseId,
        leaseExpiresAt: resume.command.leaseExpiresAt,
        priorLeaseId: exampleExecuteDelivery.command.leaseId
      })
    );
    expect(state.receive(resume).stored).toBe(false);

    expect(() =>
      state.receive({
        ...resumeDelivery(3, "2030-01-01T02:00:00.000Z"),
        command: {
          ...resume.command,
          leaseExpiresAt: "2030-01-01T02:00:00.000Z"
        }
      })
    ).toThrow("execution_resume_conflict");

    const artifact = {
      operationId: "resume-artifact",
      direction: "output",
      artifactRef: `artifact:sha256:${"a".repeat(64)}`,
      sha256: "a".repeat(64),
      sizeBytes: 1,
      mediaType: "text/plain"
    };
    expect(() =>
      state.recordArtifactTransfer(1, exampleExecuteDelivery.command.leaseId, artifact)
    ).toThrow("execution_artifact_stale_lease");
    expect(state.recordArtifactTransfer(1, resume.command.leaseId, artifact)).toBe(true);

    expect(state.startResumption(1)).toEqual(
      expect.objectContaining({
        sessionId: "acp-session-1",
        execution: expect.objectContaining({
          status: "running",
          command: expect.objectContaining({ leaseId: resume.command.leaseId })
        })
      })
    );
    expect(state.pendingEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "dispatch.accepted",
          leaseId: resume.command.leaseId,
          executionAttemptId: resume.command.executionAttemptId
        })
      ])
    );
    expect(state.startResumption(1)).toBeUndefined();
  });

  it("fails closed on unsupported or failed session load and supports a distinct retry attempt", async () => {
    const unsupported = await interruptedState(false);
    expect(() => unsupported.receive(resumeDelivery())).toThrow(
      "execution_resume_session_load_unsupported"
    );
    expect(unsupported.pendingEvents()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "mailbox.ack", sequence: 2 })])
    );

    const legacy = await legacyInterruptedState();
    expect(legacy.executionEvidence(1)).toMatchObject({
      legacyAcpCapabilities: { loadSession: true, closeSession: false }
    });
    expect(legacy.executionEvidence(1)?.acpCapabilitySnapshot).toBeUndefined();
    expect(legacy.pendingEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "dispatch.interrupted", resumable: false })
      ])
    );
    expect(() => legacy.receive(resumeDelivery())).toThrow(
      "execution_resume_session_load_unsupported"
    );

    const resumable = await interruptedState();
    resumable.receive(resumeDelivery());
    resumable.startResumption(1);
    expect(resumable.pendingEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "dispatch.accepted", leaseId: "lease-resumed-002" })
      ])
    );
    resumable.failResumption(1);
    expect(resumable.executionEvidence(1)).toMatchObject({
      status: "interrupted",
      recoveryIntent: { kind: "session_load_failed", leaseId: "lease-resumed-002" }
    });
    expect(resumable.pendingEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "dispatch.interrupted",
          leaseId: "lease-resumed-002",
          reason: "acp_session_lost",
          resumable: false
        })
      ])
    );

    const envelope = {
      ...exampleExecuteDelivery.command.envelope,
      execution: {
        ...exampleExecuteDelivery.command.envelope.execution,
        attemptId: "attempt-002"
      }
    };
    const retry = executeBlockCommandSchema.parse({
      ...exampleExecuteDelivery.command,
      executionAttemptId: "attempt-002",
      leaseId: "lease-retry-003",
      envelope,
      envelopeDigest: hashExecutionEnvelope(envelope)
    });
    resumable.receive(executeDelivery(3, retry));
    expect(resumable.pendingExecutions(1)[0]?.command.executionAttemptId).toBe("attempt-002");
    expect(resumable.executionEvidence(1)?.status).toBe("interrupted");
  });

  it("applies cancellation only to the current resumed lease and deduplicates replay", async () => {
    const state = await interruptedState();
    state.receive(resumeDelivery());
    state.startResumption(1);

    const stale = cancelDelivery(3, exampleExecuteDelivery.command.leaseId);
    state.receive(stale);
    expect(state.applyCancellation(3)).toEqual({ shouldAbort: false });
    expect(state.executionEvidence(1)?.status).toBe("running");

    const current = cancelDelivery(4, "lease-resumed-002");
    expect(state.receive(current).stored).toBe(true);
    expect(state.applyCancellation(4)).toEqual({ shouldAbort: true });
    expect(state.receive(current).stored).toBe(false);
    expect(state.applyCancellation(4)).toEqual({ shouldAbort: false });
    state.failExecution(1, {
      code: "execution_cancelled",
      message: "The execution was cancelled by the coordinator.",
      retryable: false
    });
    expect(state.executionEvidence(1)?.status).toBe("cancelled");
  });
});
