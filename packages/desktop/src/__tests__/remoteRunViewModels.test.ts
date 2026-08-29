import { describe, expect, it } from "vitest";
import type { AssignmentDisplayProjection } from "@planweave-ai/collaboration-protocol/work/assignment";
import type {
  RemoteInteractionView,
  RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import type { ProjectedRemoteAcpEvent } from "@planweave-ai/runtime";
import {
  adaptRemoteAcpEvents,
  buildRemoteActionIdentity,
  isLocalAutoRunActiveFromBlockRecords,
  projectRemoteLifecyclePhase,
  projectRemoteRunActions,
  projectRemoteRunIdentity,
  projectRemoteRunPanelViewModel,
  REMOTE_RUN_ACTION_STATE_TABLE
} from "../renderer/collaboration/remoteRunViewModels";
import { remoteRunLifecyclePhaseLabel } from "../renderer/collaboration/remoteRunLifecycleCopy";
import { createTranslator } from "../renderer/i18n";

function assignment(
  overrides: Partial<AssignmentDisplayProjection> = {}
): AssignmentDisplayProjection {
  return {
    projectId: "project-1",
    workItem: { kind: "block", canvasId: "default", blockRef: "T-1#B-1" },
    target: { kind: "exact_host", hostId: "host-1" },
    revision: 1,
    availability: { status: "ready", reason: "ready" },
    host: {
      hostId: "host-1",
      displayName: "Host One",
      online: true,
      authorizedForProject: true,
      revoked: false,
      capabilitiesSatisfied: true
    },
    ...overrides
  };
}

function observation(
  overrides: Partial<RemoteOperationObservation> = {}
): RemoteOperationObservation {
  return {
    operationId: "op-1",
    projectId: "project-1",
    canvasId: "default",
    blockRef: "T-1#B-1",
    state: "running",
    dispatchId: "dispatch-1",
    executionAttemptId: "attempt-1",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:01:00.000Z",
    attempt: {
      executionAttemptId: "attempt-1",
      dispatchId: "dispatch-1",
      status: "running",
      hostId: "host-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2030-01-01T01:00:00.000Z",
      stateVersion: 3
    },
    dispatchStatus: "running",
    runtime: {
      ref: "T-1#B-1",
      status: "in_progress"
    },
    ...overrides
  };
}

function projectedMessage(
  cursor: number,
  summary: string,
  overrides: Partial<ProjectedRemoteAcpEvent> = {}
): ProjectedRemoteAcpEvent {
  return {
    eventProtocolVersion: 1,
    executionAttemptId: "attempt-1",
    cursor,
    sourceSequence: cursor,
    timestamp: "1970-01-01T00:00:00.000Z",
    kind: "agent_message",
    summary,
    body: {
      kind: "message",
      role: "assistant",
      messageId: null,
      chunk: true,
      content: summary,
      redaction: { state: "clear", reasons: [], matchedKeyCount: 0 }
    },
    engineEvidence: null,
    engineTerminal: null,
    ...overrides
  };
}

describe("remoteRunViewModels", () => {
  it("exposes an explicit action/state table", () => {
    expect(REMOTE_RUN_ACTION_STATE_TABLE.length).toBeGreaterThanOrEqual(6);
    const interrupted = REMOTE_RUN_ACTION_STATE_TABLE.find(
      (row) => row.operationState === "interrupted"
    );
    expect(interrupted).toMatchObject({
      resume: true,
      fail: true,
      retry: true,
      cancel: false,
      dispatch: false
    });
  });

  it("keeps local Auto Run and remote dispatch as separate authorities", () => {
    const vm = projectRemoteRunPanelViewModel({
      observation: observation(),
      runtime: {
        identity: { operationId: "op-1" },
        phase: "active",
        status: "owned",
        actionRequired: false,
        source: { revision: "rev-1", graphFingerprint: "fp-1" },
        dispatchAttempt: { dispatchId: "dispatch-1", executionAttemptId: "attempt-1" }
      },
      assignment: assignment(),
      observerRun: null,
      pendingInteractions: [],
      eventProtocolVersion: null,
      events: [],
      replayDiagnostics: [],
      eventCursor: 0,
      eventsHasMore: false,
      authorized: true,
      offline: false,
      localAutoRunActive: true,
      endpointDispatchAvailable: true
    });
    expect(vm.authority).toBe("remote_dispatch");
    expect(vm.localAutoRunCoexisting).toBe(true);
    expect(vm.actions.find((a) => a.kind === "dispatch")).toMatchObject({
      available: false,
      reason: "local_run_active"
    });
  });

  it("projects preparing and running from the Server runtime projection without an observation", () => {
    const runtime = {
      identity: { operationId: "op-1" },
      phase: "preparing" as const,
      status: "owned" as const,
      actionRequired: false,
      source: { revision: "rev-1", graphFingerprint: "fp-1" },
      dispatchAttempt: { dispatchId: "dispatch-1", executionAttemptId: "attempt-1" }
    };

    expect(projectRemoteLifecyclePhase({ observation: null, runtime, canDispatch: false })).toBe(
      "preparing"
    );
    expect(
      projectRemoteLifecyclePhase({
        observation: null,
        runtime: { ...runtime, phase: "active" },
        canDispatch: false
      })
    ).toBe("running");
  });

  it("uses the shared execution-environment copy for Server preparing projections", () => {
    expect(remoteRunLifecyclePhaseLabel("preparing", createTranslator("en"))).toBe(
      "Preparing the execution environment"
    );
    expect(remoteRunLifecyclePhaseLabel("preparing", createTranslator("zh-CN"))).toBe(
      "正在准备执行环境"
    );
  });

  it("dedupes and orders ACP events by cursor", () => {
    const adapted = adaptRemoteAcpEvents(
      [
        projectedMessage(3, "third"),
        projectedMessage(1, "first"),
        projectedMessage(2, "second-old"),
        projectedMessage(2, "second-new")
      ],
      { afterCursor: 0 }
    );
    expect(adapted.map((e) => e.cursor)).toEqual([1, 2, 3]);
    expect(adapted[1]).toMatchObject({ summary: "second-new" });
  });

  it("gates dispatch only on explicit Endpoint availability", () => {
    const input = {
      observation: null,
      runtime: null,
      assignment: assignment(),
      observerRun: null,
      pendingInteractions: [],
      eventProtocolVersion: null,
      events: [],
      replayDiagnostics: [],
      eventCursor: 0,
      eventsHasMore: false,
      authorized: true,
      offline: false,
      localAutoRunActive: false,
      hostOnline: true
    };
    const dispatch = (endpointDispatchAvailable: boolean, target = input.assignment) =>
      projectRemoteRunPanelViewModel({
        ...input,
        assignment: target,
        endpointDispatchAvailable
      }).actions.find((action) => action.kind === "dispatch");

    expect(dispatch(false)).toMatchObject({ available: false, reason: "assignment_ineligible" });
    expect(
      dispatch(
        false,
        assignment({
          target: { kind: "automatic_host" },
          availability: { status: "pending", reason: "automatic_pending_selection" }
        })
      )
    ).toMatchObject({ available: false, reason: "assignment_ineligible" });
    expect(dispatch(true)).toMatchObject({ available: true });

    const missing = Reflect.apply(projectRemoteRunPanelViewModel, undefined, [input]);
    expect(missing.actions.find((action) => action.kind === "dispatch")).toMatchObject({
      available: false,
      reason: "assignment_ineligible"
    });
  });

  it("shows interruption as action_required style phase and enables resume/fail/retry", () => {
    const obs = observation({
      state: "interrupted",
      attempt: {
        executionAttemptId: "attempt-1",
        dispatchId: "dispatch-1",
        status: "interrupted",
        hostId: "host-1",
        leaseId: "lease-1",
        stateVersion: 4
      },
      runtime: {
        ref: "T-1#B-1",
        status: "interrupted",
        interruption: {
          reason: "transport_lost",
          resumable: true,
          recovery: { acpSessionId: "session-1", recoveryId: "recovery-1" }
        }
      }
    });
    expect(
      projectRemoteLifecyclePhase({ observation: obs, runtime: null, canDispatch: false })
    ).toBe("interrupted");
    const actions = projectRemoteRunActions({
      observation: obs,
      pendingInteractions: [],
      authorized: true,
      offline: false,
      localAutoRunActive: false,
      assignmentEligible: true,
      interruptionResumable: true
    });
    expect(actions.find((a) => a.kind === "resume_same_session")?.available).toBe(true);
    expect(actions.find((a) => a.kind === "fail_interruption")?.available).toBe(true);
    expect(actions.find((a) => a.kind === "retry_new_attempt")).toMatchObject({
      available: true,
      requiresConfirm: true
    });
    expect(actions.find((a) => a.kind === "cancel")?.available).toBe(false);
  });

  it("requires pending interaction for answer action", () => {
    const pending: RemoteInteractionView = {
      request: {
        type: "interaction.permission_requested",
        title: "Write file",
        description: "Allow write",
        actionId: "action-1",
        dispatchId: "dispatch-1",
        leaseId: "lease-1",
        executionAttemptId: "attempt-1",
        acpSessionId: "session-1",
        expiresAt: "2030-01-01T02:00:00.000Z"
      },
      operationId: "op-1",
      hostId: "host-1",
      status: "pending",
      createdAt: "2030-01-01T00:30:00.000Z"
    };
    const without = projectRemoteRunActions({
      observation: observation(),
      pendingInteractions: [],
      authorized: true,
      offline: false,
      localAutoRunActive: false,
      assignmentEligible: true,
      interruptionResumable: false
    });
    const withPending = projectRemoteRunActions({
      observation: observation(),
      pendingInteractions: [pending],
      authorized: true,
      offline: false,
      localAutoRunActive: false,
      assignmentEligible: true,
      interruptionResumable: false
    });
    expect(without.find((a) => a.kind === "answer_interaction")).toMatchObject({
      available: false,
      reason: "no_pending_interaction"
    });
    expect(withPending.find((a) => a.kind === "answer_interaction")?.available).toBe(true);
  });

  it("builds cancel action identity from observation lease/version", () => {
    const action = buildRemoteActionIdentity({
      observation: observation(),
      kind: "cancel",
      actionId: "action-cancel-1",
      reason: "stop"
    });
    expect(action).toMatchObject({
      kind: "cancel",
      operationId: "op-1",
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      expectedAttemptVersion: 3,
      leaseId: "lease-1"
    });
  });

  it("marks offline actions unavailable without inventing state from text", () => {
    const actions = projectRemoteRunActions({
      observation: observation(),
      pendingInteractions: [],
      authorized: true,
      offline: true,
      localAutoRunActive: false,
      assignmentEligible: true,
      interruptionResumable: false
    });
    expect(actions.every((a) => !a.available && a.reason === "offline")).toBe(true);
  });

  it("projects recovery identity from observation interruption evidence", () => {
    const obs = observation({
      state: "interrupted",
      attempt: {
        executionAttemptId: "attempt-1",
        dispatchId: "dispatch-1",
        status: "interrupted",
        hostId: "host-1",
        leaseId: "lease-1",
        stateVersion: 4
      },
      runtime: {
        ref: "T-1#B-1",
        status: "interrupted",
        interruption: {
          reason: "transport_lost",
          resumable: true,
          recovery: { acpSessionId: "session-1", recoveryId: "recovery-1" }
        }
      }
    });
    const identity = projectRemoteRunIdentity(obs);
    expect(identity.acpSessionId).toBe("session-1");
    expect(identity.recoveryId).toBe("recovery-1");
    expect(identity.leaseId).toBe("lease-1");
  });

  it("builds a server-owned resume command from observation CAS identity", () => {
    const obs = observation({
      state: "interrupted",
      attempt: {
        executionAttemptId: "attempt-1",
        dispatchId: "dispatch-1",
        status: "interrupted",
        hostId: "host-1",
        leaseId: "lease-1",
        leaseExpiresAt: "2030-01-01T01:00:00.000Z",
        stateVersion: 4
      },
      runtime: {
        ref: "T-1#B-1",
        status: "interrupted",
        interruption: {
          reason: "transport_lost",
          resumable: true,
          recovery: { acpSessionId: "session-1", recoveryId: "recovery-1" }
        }
      }
    });
    const action = buildRemoteActionIdentity({
      observation: obs,
      kind: "resume_same_session",
      actionId: "resume-command-1",
      reason: "continue"
    });
    expect(action).toEqual({
      actionId: "resume-command-1",
      operationId: "op-1",
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      expectedAttemptVersion: 4,
      kind: "resume_same_session",
      priorLeaseId: "lease-1",
      reason: "continue"
    });
    expect(action).not.toHaveProperty("leaseId");
    expect(action).not.toHaveProperty("leaseExpiresAt");
    expect(action).not.toHaveProperty("recovery");
  });

  it("detects local Auto Run activity from unfinished block run records", () => {
    expect(isLocalAutoRunActiveFromBlockRecords([])).toBe(false);
    expect(isLocalAutoRunActiveFromBlockRecords([{ finishedAt: "2030-01-01T00:00:00.000Z" }])).toBe(
      false
    );
    expect(isLocalAutoRunActiveFromBlockRecords([{ finishedAt: null }])).toBe(true);
  });
});
