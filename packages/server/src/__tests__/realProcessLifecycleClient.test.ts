import { describe, expect, it } from "vitest";
import {
  expectedDispatchStatusReached,
  type OperatorOperationView
} from "./support/realProcessLifecycleClient.js";

function operationView(overrides: Partial<OperatorOperationView> = {}): OperatorOperationView {
  return {
    operationId: "operation-1",
    projectId: "project-1",
    canvasId: "default",
    blockRef: "T-001#B-001",
    state: "activated",
    dispatchId: "dispatch-1",
    executionAttemptId: "attempt-1",
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    attempt: {
      executionAttemptId: "attempt-1",
      dispatchId: "dispatch-1",
      status: "running",
      stateVersion: 1
    },
    dispatchStatus: "running",
    runtime: { ref: "T-001#B-001", status: "in_progress" },
    ...overrides
  };
}

describe("real-process lifecycle dispatch waits", () => {
  it("accepts an expected non-terminal dispatch status", () => {
    expect(expectedDispatchStatusReached(operationView(), new Set(["running"]))).toBe(true);
  });

  it("fails immediately when a terminal failure cannot reach the expected status", () => {
    const view = operationView({
      state: "failed",
      dispatchStatus: "failed",
      failure: {
        code: "remote_runtime_writeback_failed",
        message: "writeback rejected",
        retryable: false
      },
      runtime: {
        ref: "T-001#B-001",
        status: "failed",
        terminalReceipt: {
          outcome: "failed",
          operationId: "operation-1"
        }
      }
    });

    expect(() => expectedDispatchStatusReached(view, new Set(["running"]))).toThrow(
      "real_process_lifecycle_terminal_dispatch_mismatch:operation_state=failed:dispatch_status=failed:failure_code=remote_runtime_writeback_failed"
    );
  });
});
