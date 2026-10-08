import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exampleExecuteDelivery } from "@planweave-ai/agent-host-protocol";
import { executeAcp, gateAcpCapabilities, type AcpCapabilitySnapshot } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { agentHostRemoteEngineEventSchema } from "../execution/remoteAcpPorts.js";
import { openAgentHostState, type AgentHostState } from "../state/agentHostState.js";

const directories: string[] = [];
const states: AgentHostState[] = [];
const mockAgentPath = fileURLToPath(
  new URL("../../../runtime/src/__tests__/support/acpMockAgent.mjs", import.meta.url)
);
const policy = { required: [], optional: ["history-load"] } as const;
const initialized = {
  protocolVersion: 1,
  agentInfo: { name: "session-capability-test", version: "1.0.0" },
  agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }
};

afterEach(async () => {
  for (const state of states.splice(0)) state.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-session-capabilities-"));
  directories.push(directory);
  const path = join(directory, "host.sqlite");
  const state = await openAgentHostState(path);
  states.push(state);
  state.setRemoteRunnerEventProtocolVersion(2);
  state.receive(exampleExecuteDelivery);
  state.startExecution(exampleExecuteDelivery.sequence);
  return { state, path };
}

describe("Agent Host ACP session capability identity", () => {
  it.each([
    {
      scenario: "load-capable",
      optional: ["history-load"],
      loadedOptional: [],
      loadedNegotiatedTail: ["history-load"],
      prompt: "continue the session"
    },
    {
      scenario: "load-capable-artifact",
      optional: ["session-close", "history-load"],
      loadedOptional: ["session-close"],
      loadedNegotiatedTail: ["history-load", "session-close"],
      prompt: "PLANWEAVE RUNNER-ONLY FINAL ARTIFACT CONTRACT\nPLANWEAVE_FINAL_ARTIFACT "
    }
  ] as const)("relays a fresh-lease $scenario load and persists terminal evidence", async ({
    scenario,
    optional,
    loadedOptional,
    loadedNegotiatedTail,
    prompt
  }) => {
    const setupResult = await setup();
    let state = setupResult.state;
    const oldIdentity = {
      dispatchId: exampleExecuteDelivery.command.dispatchId,
      executionAttemptId: exampleExecuteDelivery.command.executionAttemptId,
      leaseId: exampleExecuteDelivery.command.leaseId
    };
    const run = (
      identity: typeof oldIdentity,
      sessionStart: { kind: "new" } | { kind: "load"; sessionId: string }
    ) =>
      executeAcp({
        launch: { trusted: true, command: process.execPath, args: [mockAgentPath, scenario] },
        workspace: { cwd: process.cwd() },
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined
          )
        ),
        clientInfo: { name: "planweave-session-capability-test", version: "1.0.0" },
        shutdown: { eofDrainMs: 25, terminateGraceMs: 25, cleanupDeadlineMs: 300 },
        capabilityPolicy: { required: [], optional: [...optional] },
        prompt,
        sessionStart,
        limits: { operationTimeoutMs: 5_000, interactionTimeoutMs: 5_000 },
        eventSink: (event) => {
          if (event.kind !== "session_update") {
            state.append({
              kind: "engine_event",
              identity,
              event: agentHostRemoteEngineEventSchema.parse(event)
            });
          }
        }
      });

    const created = await run(oldIdentity, { kind: "new" });
    expect(created.terminal.state, JSON.stringify(created.terminal)).toBe("succeeded");
    const original = state.executionEvidence(exampleExecuteDelivery.sequence);
    expect(original).toMatchObject({
      acpSessionId: "mock-session-1",
      acpCapabilitySnapshot: { optional }
    });
    expect(created.capabilitySnapshot?.negotiated.slice(-optional.length)).toEqual(optional);
    if (!original?.acpSessionId || !original.recoveryId)
      throw new Error("session evidence missing");
    state.close();
    states.pop();
    state = await openAgentHostState(setupResult.path);
    states.push(state);
    state.setRemoteRunnerEventProtocolVersion(2);
    expect(state.recoverInterruptedExecutions()).toBe(1);
    const identity = { ...oldIdentity, leaseId: "fresh-session-capability-lease" };
    state.receive({
      type: "mailbox.message",
      protocolVersion: 1,
      sequence: exampleExecuteDelivery.sequence + 1,
      previousSequence: exampleExecuteDelivery.sequence,
      messageId: "resume-session-capabilities",
      command: {
        type: "resume_execution",
        protocolVersion: 1,
        ...identity,
        leaseExpiresAt: "2030-01-01T00:00:00.000Z",
        priorRecovery: { acpSessionId: original.acpSessionId, recoveryId: original.recoveryId }
      }
    });
    expect(state.startResumption(exampleExecuteDelivery.sequence)?.sessionId).toBe(
      original.acpSessionId
    );
    const loaded = await run(identity, { kind: "load", sessionId: original.acpSessionId });
    expect(loaded.terminal, JSON.stringify(loaded.terminal)).toMatchObject({ state: "succeeded" });
    expect(loaded.capabilitySnapshot?.negotiated.slice(-loadedNegotiatedTail.length)).toEqual(
      loadedNegotiatedTail
    );
    expect(state.executionEvidence(exampleExecuteDelivery.sequence)).toMatchObject({
      acpSessionId: original.acpSessionId,
      recoveryId: original.recoveryId,
      leaseId: identity.leaseId,
      acpCapabilitySnapshot: {
        required: expect.arrayContaining(["history-load"]),
        optional: loadedOptional
      }
    });
    expect(state.executionEvidence(exampleExecuteDelivery.sequence)?.acpCapabilitySnapshot).toEqual(
      loaded.capabilitySnapshot
    );
    expect(state.records(oldIdentity)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "engine_event",
          event: expect.objectContaining({
            kind: "capability_snapshot",
            snapshot: expect.objectContaining({ optional })
          })
        })
      ])
    );
    expect(state.records(identity)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "engine_event",
          event: expect.objectContaining({
            kind: "session_started",
            loaded: true,
            sessionId: original.acpSessionId
          })
        }),
        expect.objectContaining({
          kind: "engine_event",
          event: expect.objectContaining({
            kind: "terminal",
            terminal: expect.objectContaining({ state: "succeeded" })
          })
        })
      ])
    );
    expect(() =>
      state.append({
        kind: "engine_event",
        identity: oldIdentity,
        event: {
          kind: "session_started",
          sequence: 999,
          timestamp: new Date().toISOString(),
          loaded: false,
          sessionId: original.acpSessionId
        }
      })
    ).toThrow("remote_execution_stale_lease");
    state.completeExecution(exampleExecuteDelivery.sequence, identity, {
      summary: "resumed",
      reportArtifactRef: `artifact:sha256:${"a".repeat(64)}`,
      artifactRefs: []
    });
    expect(state.executionEvidence(exampleExecuteDelivery.sequence)?.status).toBe("completed");
  });

  it.each<[string, (snapshot: AcpCapabilitySnapshot) => AcpCapabilitySnapshot]>([
    [
      "agent info",
      (snapshot) => ({ ...snapshot, agentInfo: { name: "different-agent", version: "2.0.0" } })
    ],
    ["protocol version", (snapshot) => ({ ...snapshot, protocolVersion: 2 })],
    [
      "available capabilities",
      (snapshot) => ({ ...snapshot, available: [...snapshot.available, "embedded-context"] })
    ],
    [
      "negotiated capabilities",
      (snapshot) => ({
        ...snapshot,
        optional: ["image"],
        negotiated: [...snapshot.negotiated, "image"]
      })
    ]
  ])("rejects changed %s even when the new load gate succeeds", async (_name, change) => {
    const { state } = await setup();
    const snapshot = gateAcpCapabilities(
      { required: [], optional: [...policy.optional] },
      initialized
    );
    state.recordSessionEvidence(exampleExecuteDelivery.sequence, {
      sessionId: "session-1",
      recoveryId: "recovery-1",
      capabilitySnapshot: snapshot
    });
    const loaded = gateAcpCapabilities(
      { required: [], optional: [...policy.optional] },
      initialized,
      { sessionStart: "load", connectionMode: "dedicated" }
    );
    expect(() =>
      state.recordSessionEvidence(exampleExecuteDelivery.sequence, {
        sessionId: "session-1",
        recoveryId: "recovery-1",
        capabilitySnapshot: change(loaded)
      })
    ).toThrow("execution_session_identity_conflict");
    expect(state.executionEvidence(exampleExecuteDelivery.sequence)?.acpCapabilitySnapshot).toEqual(
      snapshot
    );
  });

  it.each([
    "sessionId",
    "recoveryId"
  ] as const)("rejects a changed %s with unchanged capabilities", async (field) => {
    const { state } = await setup();
    const evidence = {
      sessionId: "session-1",
      recoveryId: "recovery-1",
      capabilitySnapshot: gateAcpCapabilities(
        { required: [], optional: [...policy.optional] },
        initialized
      )
    };
    state.recordSessionEvidence(exampleExecuteDelivery.sequence, evidence);
    expect(() =>
      state.recordSessionEvidence(exampleExecuteDelivery.sequence, {
        ...evidence,
        [field]: "conflicting-identity"
      })
    ).toThrow("execution_session_identity_conflict");
  });

  it("keeps identical evidence idempotent after completion and rejects a late policy rewrite", async () => {
    const { state } = await setup();
    const capabilitySnapshot = gateAcpCapabilities(
      { required: [], optional: [...policy.optional] },
      initialized,
      { sessionStart: "load", connectionMode: "dedicated" }
    );
    const evidence = { sessionId: "session-1", recoveryId: "recovery-1", capabilitySnapshot };
    state.recordSessionEvidence(exampleExecuteDelivery.sequence, evidence);
    state.completeExecution(
      exampleExecuteDelivery.sequence,
      {
        dispatchId: exampleExecuteDelivery.command.dispatchId,
        executionAttemptId: exampleExecuteDelivery.command.executionAttemptId,
        leaseId: exampleExecuteDelivery.command.leaseId
      },
      {
        summary: "completed",
        reportArtifactRef: `artifact:sha256:${"b".repeat(64)}`,
        artifactRefs: []
      }
    );
    const completed = state.executionEvidence(exampleExecuteDelivery.sequence);
    expect(state.recordSessionEvidence(exampleExecuteDelivery.sequence, evidence)).toEqual(
      completed
    );
    expect(() =>
      state.recordSessionEvidence(exampleExecuteDelivery.sequence, {
        ...evidence,
        capabilitySnapshot: gateAcpCapabilities(
          { required: [], optional: [...policy.optional] },
          initialized
        )
      })
    ).toThrow("execution_session_state_invalid");
    expect(state.executionEvidence(exampleExecuteDelivery.sequence)).toEqual(completed);
  });
});
