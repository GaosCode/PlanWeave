import { getRunSession } from "../runSessions/repository.js";
import { projectWorkspaceExecutionCoordinatorView } from "../workspaceExecution/nodeView.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import {
  fixture,
  request,
  pendingInteraction,
  deferred,
  observation
} from "./workspaceExecutionCoordinatorTestFixture.js";
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
  it("projects only public interaction status during a response and after network failure", async () => {
    const { root } = await createTestWorkspace();
    const entered = deferred<void>();
    const released = deferred<void>();
    const f = fixture({
      packageWorkspace: root,
      observe: async () => observation({ state: "running", revision: 2 }),
      interactions: async () => pendingInteraction("attempt-1"),
      respond: async () => {
        entered.resolve();
        await released.promise;
        throw new Error("network response failed");
      }
    });
    const started = await f.coordinator.execute(request(root));
    const response = {
      type: "interaction.permission_response" as const,
      dispatchId: "dispatch-attempt-1",
      leaseId: "lease-1",
      executionAttemptId: "attempt-1",
      actionId: "action-1",
      acpSessionId: "acp-session-1",
      decision: "select_option" as const,
      optionId: "tool-approve-once"
    };
    const answering = f.coordinator.respond({
      request: request(root),
      sessionId: started.session.sessionId,
      response
    });
    const failed = expect(answering).rejects.toMatchObject({
      code: "remote_interaction_response_unavailable"
    });
    await entered.promise;
    try {
      const refreshed = await f.coordinator.follow(request(root), started.session.sessionId);
      expect(
        refreshed.session.workspaceExecution?.interactions[0]?.responseIntent?.response
      ).toEqual(response);
      const view = projectWorkspaceExecutionCoordinatorView(refreshed);
      expect(view.session.interactionStatus).toEqual([
        { key: refreshed.session.workspaceExecution?.interactions[0]?.key, status: "pending" }
      ]);
      expect(() =>
        workspaceExecutionCoordinatorViewSchema.parse({
          ...view,
          session: {
            ...view.session,
            interactionStatus: [
              { ...view.session.interactionStatus[0], responseIntent: { response } }
            ]
          }
        })
      ).toThrow();
    } finally {
      released.resolve();
      await failed;
    }
    const persisted = (await getRunSession(root, started.session.sessionId)).session;
    expect(persisted.workspaceExecution?.interactions[0]?.responseIntent?.response).toEqual(
      response
    );
    expect(
      projectWorkspaceExecutionCoordinatorView({ ...started, session: persisted }).session
        .interactionStatus
    ).toEqual([{ key: persisted.workspaceExecution?.interactions[0]?.key, status: "pending" }]);
  });

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
