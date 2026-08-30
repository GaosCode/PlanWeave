import { describe, expect, it } from "vitest";
import {
  projectWorkspaceExecutionTimeline,
  workspaceExecutionCoordinatorViewSchema
} from "../workspaceExecution/browser.js";

const source = {
  target: "remote" as const,
  operationId: "operation-1",
  executionAttemptId: "attempt-1",
  cursor: 2
};
const base = {
  version: "planweave.execution-event/v1" as const,
  observedAt: "2030-01-01T00:00:00.000Z",
  runSessionId: "SESSION-0001",
  scope: { kind: "block" as const, blockRef: "T-001#B-001" },
  source
};

describe("workspace execution browser view", () => {
  it("projects one canonical attempt, interaction, cursor, and terminal timeline", () => {
    const required = {
      ...base,
      eventId: "interaction-1",
      type: "interaction_required" as const,
      data: {
        type: "interaction.authentication_required" as const,
        dispatchId: "dispatch-1",
        leaseId: "lease-1",
        executionAttemptId: "attempt-1",
        acpSessionId: "acp-1",
        actionId: "action-1",
        expiresAt: "2030-01-01T00:05:00.000Z",
        agentProfileId: "codex-acp",
        hostInstruction: "Login required"
      }
    };
    const terminal = {
      ...base,
      eventId: "terminal-1",
      observedAt: "2030-01-01T00:00:01.000Z",
      source: { ...source, cursor: 3 },
      type: "run_terminal" as const,
      data: { outcome: "completed" as const }
    };
    const runner = {
      ...base,
      eventId: "runner-1",
      observedAt: "2029-12-31T23:59:59.000Z",
      source: { ...source, cursor: 1 },
      type: "runner_event" as const,
      data: {
        eventProtocolVersion: 1 as const,
        event: { cursor: 1, kind: "agent_message" as const, text: "Completed the block." }
      }
    };
    const timeline = projectWorkspaceExecutionTimeline([terminal, required, runner, required]);

    expect(timeline.events.map((event) => event.eventId)).toEqual([
      "runner-1",
      "interaction-1",
      "terminal-1"
    ]);
    expect(timeline.executionAttemptIds).toEqual(["attempt-1"]);
    expect(timeline.pendingInteractions).toEqual(["action-1"]);
    expect(timeline.cursor).toBe(3);
    expect(timeline.terminalOutcome).toBe("completed");
    expect(timeline.runnerTimeline).toMatchObject([
      { kind: "message", content: "Completed the block." }
    ]);
  });

  it("rejects main-only paths, storage, and credentials at the browser boundary", () => {
    const session = {
      sessionId: "SESSION-0001",
      stateVersion: 1,
      phase: "running",
      scope: { kind: "block", blockRef: "T-001#B-001" },
      startedAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
      finishedAt: null,
      error: null,
      interactionStatus: [],
      evidence: { status: "pending", diagnostics: [] }
    };
    for (const forbidden of [
      { projectRoot: "/workspace" },
      { storage: { kind: "namespace", namespace: "secret" } },
      { credential: "token" }
    ]) {
      expect(() =>
        workspaceExecutionCoordinatorViewSchema.parse({
          version: "planweave.workspace-execution-view/v1",
          handle: {},
          session: { ...session, ...forbidden },
          events: []
        })
      ).toThrow();
    }
  });

  it("keeps the cursor in the current remote attempt domain after an attempt reset", () => {
    const attemptA = {
      ...base,
      eventId: "attempt-a-runner-18",
      source: { ...source, executionAttemptId: "attempt-a", cursor: 18 },
      type: "runner_event" as const,
      data: {
        eventProtocolVersion: 1 as const,
        event: { cursor: 18, kind: "agent_message" as const, text: "old attempt" }
      }
    };
    const changed = {
      ...base,
      eventId: "attempt-b-changed",
      observedAt: "2030-01-01T00:00:01.000Z",
      source: { ...source, executionAttemptId: "attempt-b", cursor: 0 },
      type: "attempt_changed" as const,
      data: {
        previousExecutionAttemptId: "attempt-a",
        executionAttemptId: "attempt-b"
      }
    };
    const operation = {
      ...base,
      eventId: "operation-revision-42",
      observedAt: "2030-01-01T00:00:02.000Z",
      source: { ...source, executionAttemptId: "attempt-b", cursor: 1 },
      type: "operation_observed" as const,
      data: { state: "running", attemptStatus: "running", operationRevision: 42 }
    };

    const timeline = projectWorkspaceExecutionTimeline([attemptA, changed, operation]);

    expect(timeline.executionAttemptIds).toEqual(["attempt-a", "attempt-b"]);
    expect(timeline.cursor).toBe(1);
  });
});
