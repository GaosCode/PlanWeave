import {
  remoteOperationObservationSchema,
  type RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import { describe, expect, it, vi } from "vitest";
import type { CollaborationObserverSignal } from "../../shared/collaborationReadModels";
import { waitForRemoteOperationTerminal } from "./remoteTaskEndpointRun";

function operation(
  blockRef: string,
  state: RemoteOperationObservation["state"]
): RemoteOperationObservation {
  const operationSuffix = blockRef.replace("#", ":");
  const attemptStatus =
    state === "completed" || state === "failed" || state === "cancelled" || state === "interrupted"
      ? state
      : state === "awaiting_writeback"
        ? "awaiting_writeback"
        : "running";
  return remoteOperationObservationSchema.parse({
    operationId: `operation-${operationSuffix}`,
    projectId: "project-1",
    canvasId: "canvas-1",
    blockRef,
    state,
    dispatchId: `dispatch-${operationSuffix}`,
    executionAttemptId: `attempt-${operationSuffix}`,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:01.000Z",
    attempt: {
      executionAttemptId: `attempt-${operationSuffix}`,
      dispatchId: `dispatch-${operationSuffix}`,
      status: attemptStatus,
      stateVersion: 1
    },
    runtime: {
      ref: blockRef,
      status:
        state === "completed"
          ? "completed"
          : state === "interrupted"
            ? "interrupted"
            : "in_progress"
    }
  });
}

describe("waitForRemoteOperationTerminal", () => {
  it("refreshes an operation through the observer API until it reaches a terminal state", async () => {
    const unsubscribe = vi.fn();
    const observeCollaborationRemoteOperation = vi.fn(async () =>
      operation("T-001#B-001", "completed")
    );

    const result = await waitForRemoteOperationTerminal({
      api: {
        observeCollaborationRemoteOperation,
        onCollaborationObserverSignal: vi.fn(() => unsubscribe)
      },
      initial: operation("T-001#B-001", "running")
    });

    expect(result.state).toBe("completed");
    expect(observeCollaborationRemoteOperation).toHaveBeenCalledWith({
      operationId: "operation-T-001:B-001"
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("queues a refresh when a terminal observer event arrives during an in-flight read", async () => {
    const unsubscribe = vi.fn();
    let emitSignal: ((signal: CollaborationObserverSignal) => void) | undefined;
    let resolveFirstRead: ((value: RemoteOperationObservation) => void) | undefined;
    const firstRead = new Promise<RemoteOperationObservation>((resolve) => {
      resolveFirstRead = resolve;
    });
    const observeCollaborationRemoteOperation = vi
      .fn()
      .mockImplementationOnce(() => firstRead)
      .mockResolvedValueOnce(operation("T-001#B-001", "completed"));

    const terminal = waitForRemoteOperationTerminal({
      api: {
        observeCollaborationRemoteOperation,
        onCollaborationObserverSignal: vi.fn((listener) => {
          emitSignal = listener;
          return unsubscribe;
        })
      },
      initial: operation("T-001#B-001", "running")
    });

    await vi.waitFor(() => expect(observeCollaborationRemoteOperation).toHaveBeenCalledTimes(1));
    emitSignal?.({
      type: "human.observer.event",
      profileId: "profile-1",
      projectId: "project-1",
      event: {
        type: "human.observer.event",
        protocolVersion: 1,
        cursor: 2,
        previousCursor: 1,
        occurredAt: "2026-08-05T00:00:02.000Z",
        kind: "remote_run",
        dispatchId: "dispatch-T-001:B-001",
        remoteRunStatus: "succeeded"
      }
    });
    resolveFirstRead?.(operation("T-001#B-001", "running"));

    await expect(terminal).resolves.toMatchObject({ state: "completed" });
    expect(observeCollaborationRemoteOperation).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("settles cleanup once when cancellation races an in-flight terminal read", async () => {
    const unsubscribe = vi.fn();
    const controller = new AbortController();
    let resolveRead: ((value: RemoteOperationObservation) => void) | undefined;
    const pendingRead = new Promise<RemoteOperationObservation>((resolve) => {
      resolveRead = resolve;
    });
    const observeCollaborationRemoteOperation = vi.fn(() => pendingRead);

    const terminal = waitForRemoteOperationTerminal({
      api: {
        observeCollaborationRemoteOperation,
        onCollaborationObserverSignal: vi.fn(() => unsubscribe)
      },
      initial: operation("T-001#B-001", "running"),
      signal: controller.signal
    });

    await vi.waitFor(() => expect(observeCollaborationRemoteOperation).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(terminal).rejects.toThrow("remote_task_run_cancelled");
    resolveRead?.(operation("T-001#B-001", "completed"));
    await Promise.resolve();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("resolves immediately when the initial observation is already terminal", async () => {
    const observeCollaborationRemoteOperation = vi.fn();
    const result = await waitForRemoteOperationTerminal({
      api: {
        observeCollaborationRemoteOperation,
        onCollaborationObserverSignal: vi.fn(() => () => undefined)
      },
      initial: operation("T-001#B-001", "completed")
    });
    expect(result.state).toBe("completed");
    expect(observeCollaborationRemoteOperation).not.toHaveBeenCalled();
  });

  it("treats interrupted without pending writeback as wait-terminal", async () => {
    const observeCollaborationRemoteOperation = vi.fn();
    const result = await waitForRemoteOperationTerminal({
      api: {
        observeCollaborationRemoteOperation,
        onCollaborationObserverSignal: vi.fn(() => () => undefined)
      },
      initial: {
        ...operation("T-001#B-001", "interrupted"),
        dispatchStatus: "interrupted"
      }
    });
    expect(result.state).toBe("interrupted");
    expect(observeCollaborationRemoteOperation).not.toHaveBeenCalled();
  });

  it("keeps waiting when interrupted but dispatch is still awaiting_writeback", async () => {
    const unsubscribe = vi.fn();
    const observeCollaborationRemoteOperation = vi
      .fn()
      .mockResolvedValueOnce({
        ...operation("T-001#R-001", "interrupted"),
        dispatchStatus: "awaiting_writeback"
      })
      .mockResolvedValueOnce(operation("T-001#R-001", "completed"));

    const result = await waitForRemoteOperationTerminal({
      api: {
        observeCollaborationRemoteOperation,
        onCollaborationObserverSignal: vi.fn(() => unsubscribe)
      },
      initial: {
        ...operation("T-001#R-001", "interrupted"),
        dispatchStatus: "awaiting_writeback"
      },
      fallbackRefreshMs: 1
    });

    expect(result.state).toBe("completed");
    expect(observeCollaborationRemoteOperation).toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
