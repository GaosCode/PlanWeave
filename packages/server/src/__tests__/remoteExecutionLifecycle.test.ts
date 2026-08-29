import { describe, expect, it } from "vitest";
import {
  decideRemoteExecutionAction,
  nextRemoteExecutionActionState,
  type RemoteExecutionLifecycleSnapshot
} from "../remoteExecutionLifecycle.js";

const recovery = { acpSessionId: "session-1", recoveryId: "recovery-1" };

function snapshot(
  overrides: Partial<RemoteExecutionLifecycleSnapshot> = {}
): RemoteExecutionLifecycleSnapshot {
  return {
    dispatchState: "persisted",
    operationId: "operation-1",
    dispatchId: "dispatch-1",
    executionAttemptId: "attempt-1",
    attemptStatus: "interrupted",
    attemptVersion: 3,
    leaseId: "lease-1",
    leaseFenced: true,
    interruption: { resumable: true, recovery },
    hostCapabilities: ["acp.codex", "acp.session.load"],
    ...overrides
  };
}

function action(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const kind = overrides.kind ?? "block";
  return {
    actionId: "action-1",
    operationId: "operation-1",
    dispatchId: "dispatch-1",
    executionAttemptId: "attempt-1",
    expectedAttemptVersion: 3,
    kind,
    ...(["fail", "block", "cancel"].includes(String(kind)) ? { leaseId: "lease-1" } : {}),
    reason: "operator requested a blocked state",
    ...overrides
  };
}

describe("remote execution lifecycle policy", () => {
  it("allows same-session resume only with a fresh lease and exact recovery evidence", () => {
    const resume = action({
      kind: "resume_same_session",
      priorLeaseId: "lease-1",
      leaseId: "lease-2",
      leaseExpiresAt: "2030-01-01T00:05:00.000Z",
      recovery,
      reason: "operator authorized resume"
    });
    expect(decideRemoteExecutionAction(resume, snapshot())).toEqual({
      transition: "resume",
      sendsCommand: true
    });
    expect(() =>
      decideRemoteExecutionAction(resume, snapshot({ hostCapabilities: ["acp.codex"] }))
    ).toThrowError("remote_resume_session_load_unsupported");
    expect(() =>
      decideRemoteExecutionAction(
        { ...resume, recovery: { ...recovery, recoveryId: "recovery-foreign" } },
        snapshot()
      )
    ).toThrowError("remote_resume_recovery_identity_mismatch");
  });

  it("requires a fenced prior attempt and a distinct identity for retry", () => {
    const retry = action({
      kind: "retry_new_attempt",
      priorLeaseId: "lease-1",
      newDispatchId: "dispatch-2",
      newExecutionAttemptId: "attempt-2",
      reason: "operator requested a clean retry"
    });
    expect(
      decideRemoteExecutionAction(retry, snapshot({ interruption: { resumable: false } }))
    ).toEqual({
      transition: "retry",
      sendsCommand: false
    });
    expect(() =>
      decideRemoteExecutionAction(
        retry,
        snapshot({ leaseFenced: false, interruption: { resumable: false } })
      )
    ).toThrowError("remote_retry_prior_attempt_not_fenced");
    expect(() => decideRemoteExecutionAction(retry, snapshot())).toThrowError(
      "remote_retry_resume_still_available"
    );
    expect(() =>
      decideRemoteExecutionAction({ ...retry, newExecutionAttemptId: "attempt-1" }, snapshot())
    ).toThrowError();
  });

  it("allows only a new-attempt retry while dispatch is still in preparation", () => {
    const preparation = snapshot({
      dispatchState: "preparation",
      interruption: { resumable: false }
    });
    expect(
      decideRemoteExecutionAction(
        action({
          kind: "retry_new_attempt",
          priorLeaseId: "lease-1",
          newDispatchId: "dispatch-2",
          newExecutionAttemptId: "attempt-2",
          reason: "retry preparation"
        }),
        preparation
      )
    ).toEqual({ transition: "retry", sendsCommand: false });

    for (const rejected of [
      action({ kind: "block", leaseId: "lease-1" }),
      action({
        kind: "fail",
        leaseId: "lease-1",
        failure: { code: "manual_failure", message: "Stopped.", retryable: false }
      }),
      action({
        kind: "resume_same_session",
        priorLeaseId: "lease-1",
        leaseId: "lease-2",
        leaseExpiresAt: "2030-01-01T00:05:00.000Z",
        recovery
      }),
      action({ kind: "cancel", leaseId: "lease-1" })
    ]) {
      expect(() => decideRemoteExecutionAction(rejected, preparation)).toThrowError(
        "remote_preparation_action_requires_retry"
      );
    }
  });

  it("keeps fail, block, and cancel as separate decisions", () => {
    expect(
      decideRemoteExecutionAction(
        action({
          kind: "fail",
          leaseId: "lease-1",
          failure: { code: "operator_failed", message: "Stopped manually.", retryable: false },
          reason: "operator confirmed failure"
        }),
        snapshot()
      ).transition
    ).toBe("fail");
    expect(decideRemoteExecutionAction(action(), snapshot()).transition).toBe("block");
    expect(
      decideRemoteExecutionAction(
        action({ kind: "cancel", leaseId: "lease-1", reason: "operator requested cancel" }),
        snapshot({ attemptStatus: "running", leaseFenced: false })
      )
    ).toEqual({ transition: "cancel", sendsCommand: true });
    expect(() =>
      decideRemoteExecutionAction(
        action({ kind: "cancel", leaseId: "lease-1", reason: "operator requested cancel" }),
        snapshot()
      )
    ).toThrowError("remote_cancel_attempt_not_active");
  });

  it("rejects stale action identities and conflicting attempt versions", () => {
    expect(() =>
      decideRemoteExecutionAction(action({ dispatchId: "dispatch-foreign" }), snapshot())
    ).toThrowError("remote_action_identity_mismatch");
    expect(() =>
      decideRemoteExecutionAction(action({ expectedAttemptVersion: 2 }), snapshot())
    ).toThrowError("remote_action_attempt_version_conflict");
    expect(() =>
      decideRemoteExecutionAction(action({ leaseId: "lease-foreign" }), snapshot())
    ).toThrowError("remote_action_lease_mismatch");
  });

  it("models delivery, settlement, and terminal rejection without shortcuts", () => {
    expect(nextRemoteExecutionActionState("recorded", "delivered")).toBe("delivered");
    expect(nextRemoteExecutionActionState("delivered", "acknowledged")).toBe("acknowledged");
    expect(nextRemoteExecutionActionState("acknowledged", "settled")).toBe("settled");
    expect(nextRemoteExecutionActionState("recorded", "settled")).toBe("settled");
    expect(nextRemoteExecutionActionState("recorded", "rejected")).toBe("rejected");
    expect(() => nextRemoteExecutionActionState("recorded", "acknowledged")).toThrowError(
      "remote_action_state_transition_invalid"
    );
    expect(() => nextRemoteExecutionActionState("settled", "delivered")).toThrowError(
      "remote_action_state_transition_invalid"
    );
    expect(() => nextRemoteExecutionActionState("rejected", "settled")).toThrowError(
      "remote_action_state_transition_invalid"
    );
  });
});
