import {
  remoteOperationObservationSchema,
  type RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import { describe, expect, it, vi } from "vitest";
import type { CollaborationObserverSignal } from "../../shared/collaborationReadModels";
import { waitForRemoteOperationTerminal } from "./remoteTaskEndpointRun";

function operation(
  blockRef: string,
  state: RemoteOperationObservation["state"],
  revision = state === "completed" || state === "failed" || state === "cancelled" ? 3 : 2
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
    diagnostics: {
      stage:
        state === "completed" || state === "failed" || state === "cancelled"
          ? "terminal"
          : state === "awaiting_writeback"
            ? "writing_back"
            : "running",
      revision,
      attemptId: `attempt-${operationSuffix}`,
      locator: {
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "canvas-1"
      },
      content: { revision: "source-1", fingerprint: "fingerprint-1" },
      startedAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:01.000Z"
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

  it("recovers when the initial observer read hangs but a terminal event arrives", async () => {
    const unsubscribe = vi.fn();
    let emitSignal: ((signal: CollaborationObserverSignal) => void) | undefined;
    const neverSettles = new Promise<RemoteOperationObservation>(() => undefined);
    const observeCollaborationRemoteOperation = vi
      .fn()
      .mockImplementationOnce(() => neverSettles)
      .mockResolvedValueOnce(operation("T-001#B-001", "completed"));

    const terminal = waitForRemoteOperationTerminal({
      api: {
        observeCollaborationRemoteOperation,
        onCollaborationObserverSignal: vi.fn((listener) => {
          emitSignal = listener;
          return unsubscribe;
        })
      },
      initial: operation("T-001#B-001", "running"),
      fallbackRefreshMs: 60_000
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

    await expect(terminal).resolves.toMatchObject({ state: "completed" });
    expect(observeCollaborationRemoteOperation).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale read failure override a newer terminal recovery read", async () => {
    const unsubscribe = vi.fn();
    let emitSignal: ((signal: CollaborationObserverSignal) => void) | undefined;
    let rejectInitial: ((reason: unknown) => void) | undefined;
    let resolveRecovery: ((value: RemoteOperationObservation) => void) | undefined;
    const initialRead = new Promise<RemoteOperationObservation>((_resolve, reject) => {
      rejectInitial = reject;
    });
    const recoveryRead = new Promise<RemoteOperationObservation>((resolve) => {
      resolveRecovery = resolve;
    });
    const observeCollaborationRemoteOperation = vi
      .fn()
      .mockImplementationOnce(() => initialRead)
      .mockImplementationOnce(() => recoveryRead);

    const terminal = waitForRemoteOperationTerminal({
      api: {
        observeCollaborationRemoteOperation,
        onCollaborationObserverSignal: vi.fn((listener) => {
          emitSignal = listener;
          return unsubscribe;
        })
      },
      initial: operation("T-001#B-001", "running"),
      fallbackRefreshMs: 60_000
    });
    let settled = false;
    void terminal.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

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
    await vi.waitFor(() => expect(observeCollaborationRemoteOperation).toHaveBeenCalledTimes(2));

    rejectInitial?.(new Error("stale_observer_timeout"));
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveRecovery?.(operation("T-001#B-001", "completed"));
    await expect(terminal).resolves.toMatchObject({ state: "completed" });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does not let an older terminal response finish a newer retry attempt", async () => {
    let emitSignal: ((signal: CollaborationObserverSignal) => void) | undefined;
    let resolveOlder: ((value: RemoteOperationObservation) => void) | undefined;
    let resolveNewer: ((value: RemoteOperationObservation) => void) | undefined;
    const olderRead = new Promise<RemoteOperationObservation>((resolve) => {
      resolveOlder = resolve;
    });
    const newerRead = new Promise<RemoteOperationObservation>((resolve) => {
      resolveNewer = resolve;
    });
    const observe = vi
      .fn()
      .mockImplementationOnce(() => olderRead)
      .mockImplementationOnce(() => newerRead)
      .mockResolvedValueOnce(operation("T-001#B-001", "completed", 4));
    const terminal = waitForRemoteOperationTerminal({
      api: {
        observeCollaborationRemoteOperation: observe,
        onCollaborationObserverSignal: vi.fn((listener) => {
          emitSignal = listener;
          return () => undefined;
        })
      },
      initial: operation("T-001#B-001", "running", 1),
      fallbackRefreshMs: 60_000
    });
    const signal: CollaborationObserverSignal = {
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
        remoteRunStatus: "progress"
      }
    };

    await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(1));
    emitSignal?.(signal);
    await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(2));
    resolveNewer?.(operation("T-001#B-001", "running", 3));
    await Promise.resolve();
    resolveOlder?.(operation("T-001#B-001", "completed", 2));
    await Promise.resolve();

    let settled = false;
    void terminal.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    emitSignal?.(signal);
    await expect(terminal).resolves.toMatchObject({ state: "completed" });
  });

  it("ignores an older read failure after a newer nonterminal recovery succeeds", async () => {
    const unsubscribe = vi.fn();
    let emitSignal: ((signal: CollaborationObserverSignal) => void) | undefined;
    let rejectInitial: ((reason: unknown) => void) | undefined;
    const initialRead = new Promise<RemoteOperationObservation>((_resolve, reject) => {
      rejectInitial = reject;
    });
    const observeCollaborationRemoteOperation = vi
      .fn()
      .mockImplementationOnce(() => initialRead)
      .mockResolvedValueOnce(operation("T-001#B-001", "running"))
      .mockResolvedValueOnce(operation("T-001#B-001", "completed"));
    const matchingSignal: CollaborationObserverSignal = {
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
    };

    const terminal = waitForRemoteOperationTerminal({
      api: {
        observeCollaborationRemoteOperation,
        onCollaborationObserverSignal: vi.fn((listener) => {
          emitSignal = listener;
          return unsubscribe;
        })
      },
      initial: operation("T-001#B-001", "running"),
      fallbackRefreshMs: 60_000
    });
    let settled = false;
    void terminal.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    await vi.waitFor(() => expect(observeCollaborationRemoteOperation).toHaveBeenCalledTimes(1));
    emitSignal?.(matchingSignal);
    await vi.waitFor(() => expect(observeCollaborationRemoteOperation).toHaveBeenCalledTimes(2));
    await Promise.resolve();

    rejectInitial?.(new Error("stale_observer_timeout"));
    await Promise.resolve();
    expect(settled).toBe(false);

    emitSignal?.(matchingSignal);
    await expect(terminal).resolves.toMatchObject({ state: "completed" });
    expect(observeCollaborationRemoteOperation).toHaveBeenCalledTimes(3);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("continues after a newer recovery fails but an older read succeeds", async () => {
    const unsubscribe = vi.fn();
    let emitSignal: ((signal: CollaborationObserverSignal) => void) | undefined;
    let resolveInitial: ((value: RemoteOperationObservation) => void) | undefined;
    const initialRead = new Promise<RemoteOperationObservation>((resolve) => {
      resolveInitial = resolve;
    });
    const observeCollaborationRemoteOperation = vi
      .fn()
      .mockImplementationOnce(() => initialRead)
      .mockRejectedValueOnce(new Error("transient_recovery_failure"))
      .mockResolvedValueOnce(operation("T-001#B-001", "completed"));
    const matchingSignal: CollaborationObserverSignal = {
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
    };

    const terminal = waitForRemoteOperationTerminal({
      api: {
        observeCollaborationRemoteOperation,
        onCollaborationObserverSignal: vi.fn((listener) => {
          emitSignal = listener;
          return unsubscribe;
        })
      },
      initial: operation("T-001#B-001", "running"),
      fallbackRefreshMs: 60_000
    });
    let settled = false;
    void terminal.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    await vi.waitFor(() => expect(observeCollaborationRemoteOperation).toHaveBeenCalledTimes(1));
    emitSignal?.(matchingSignal);
    await vi.waitFor(() => expect(observeCollaborationRemoteOperation).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveInitial?.(operation("T-001#B-001", "running"));
    await Promise.resolve();
    expect(settled).toBe(false);

    emitSignal?.(matchingSignal);
    await expect(terminal).resolves.toMatchObject({ state: "completed" });
    expect(observeCollaborationRemoteOperation).toHaveBeenCalledTimes(3);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("caps concurrent recovery reads and stops refreshing after terminal", async () => {
    const unsubscribe = vi.fn();
    let emitSignal: ((signal: CollaborationObserverSignal) => void) | undefined;
    const resolvers: Array<(value: RemoteOperationObservation) => void> = [];
    const observeCollaborationRemoteOperation = vi.fn(
      () =>
        new Promise<RemoteOperationObservation>((resolve) => {
          resolvers.push(resolve);
        })
    );
    const matchingSignal: CollaborationObserverSignal = {
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
    };

    const terminal = waitForRemoteOperationTerminal({
      api: {
        observeCollaborationRemoteOperation,
        onCollaborationObserverSignal: vi.fn((listener) => {
          emitSignal = listener;
          return unsubscribe;
        })
      },
      initial: operation("T-001#B-001", "running"),
      fallbackRefreshMs: 60_000
    });

    await vi.waitFor(() => expect(observeCollaborationRemoteOperation).toHaveBeenCalledTimes(1));
    emitSignal?.(matchingSignal);
    emitSignal?.(matchingSignal);
    emitSignal?.(matchingSignal);
    await vi.waitFor(() => expect(observeCollaborationRemoteOperation).toHaveBeenCalledTimes(2));

    resolvers[0]?.(operation("T-001#B-001", "running"));
    await vi.waitFor(() => expect(observeCollaborationRemoteOperation).toHaveBeenCalledTimes(3));
    emitSignal?.(matchingSignal);
    expect(observeCollaborationRemoteOperation).toHaveBeenCalledTimes(3);

    resolvers[2]?.(operation("T-001#B-001", "completed"));
    await expect(terminal).resolves.toMatchObject({ state: "completed" });
    resolvers[1]?.(operation("T-001#B-001", "running"));
    emitSignal?.(matchingSignal);
    await Promise.resolve();

    expect(observeCollaborationRemoteOperation).toHaveBeenCalledTimes(3);
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
