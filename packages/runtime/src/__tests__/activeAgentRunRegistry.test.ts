import { describe, expect, it } from "vitest";
import {
  ActiveAgentRunRegistry,
  type ActiveAgentRunHandle
} from "../autoRun/activeAgentRunRegistry.js";
import type { AcpConnection } from "../autoRun/acpConnection.js";
import { createLiveOwnership } from "../autoRun/liveControl.js";

interface InMemoryLifecycle {
  closed: string[];
  cancelledSessions: string[];
  terminated: string[];
}

function unexpectedTransport(operation: string): Promise<never> {
  return Promise.reject(new Error(`Unexpected ACP transport operation: ${operation}`));
}

function createInMemoryHandle(
  scope: string,
  runId: string,
  sessionId: string,
  records: InMemoryLifecycle
): ActiveAgentRunHandle {
  const ownership = createLiveOwnership(`${scope}:${runId}`, 1);
  const pendingOperations: AcpConnection["pendingOperations"] = new Map();
  const connection = {
    processId: null,
    pendingOperationCount: 0,
    pendingOperations,
    stderr: [],
    closed: Promise.resolve(),
    initialize: () => unexpectedTransport("initialize"),
    authenticate: () => unexpectedTransport("authenticate"),
    newSession: () => unexpectedTransport("newSession"),
    loadSession: () => unexpectedTransport("loadSession"),
    prompt: () => unexpectedTransport("prompt"),
    cancel: () => unexpectedTransport("cancel"),
    closeSession: () => unexpectedTransport("closeSession"),
    setSessionMode: () => unexpectedTransport("setSessionMode"),
    setSessionConfigOption: () => unexpectedTransport("setSessionConfigOption"),
    dispose: () => unexpectedTransport("dispose")
  } satisfies AcpConnection;
  return {
    identity: { scope, executorRunId: runId, claimRef: "T-001#B-001", sessionId },
    connection,
    abortController: new AbortController(),
    eventSink: () => undefined,
    ownership,
    lifecycleState: "initializing",
    control: {
      ownership,
      process: {
        pid: connection.processId,
        terminate: (reason) => {
          records.terminated.push(reason);
          return Promise.resolve();
        }
      },
      connection: {
        send: () => unexpectedTransport("control.send"),
        close: (reason) => {
          records.closed.push(reason);
          return Promise.resolve();
        },
        cancelSession: (boundSessionId) => {
          records.cancelledSessions.push(boundSessionId);
          return Promise.resolve();
        },
        closeSession: () => unexpectedTransport("control.closeSession"),
        supportsSessionClose: false
      },
      interventionCapabilities: { cancel: true, permission: true, elicitationPreview: true },
      sessionId,
      pendingRequests: new Map(),
      pendingOperations
    }
  } satisfies ActiveAgentRunHandle;
}

function createLifecycle(closed: string[]): InMemoryLifecycle {
  return { closed, cancelledSessions: [], terminated: [] };
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Registry cases share one in-memory handle contract.
describe("ActiveAgentRunRegistry", () => {
  it("indexes concurrent identities, rejects collisions and cross-run lookup, and removes exactly once", async () => {
    const registry = new ActiveAgentRunRegistry();
    const closed: string[] = [];
    const memory = createLifecycle(closed);
    const first = createInMemoryHandle("/project-a/results/run", "RUN-001", "session-1", memory);
    const second = createInMemoryHandle("/project-b/results/run", "RUN-001", "session-1", memory);
    registry.register(first);
    registry.register(second);
    expect(registry.lookup("sessionId", "/project-a/results/run", "session-1", "RUN-001")).toBe(
      first
    );
    expect(registry.lookup("sessionId", "/project-b/results/run", "session-1", "RUN-001")).toBe(
      second
    );
    expect(() =>
      registry.lookup("sessionId", "/project-a/results/run", "session-1", "RUN-002")
    ).toThrow("different executor run");
    const collision = createInMemoryHandle(
      "/project-a/results/run",
      "RUN-001",
      "session-1",
      memory
    );
    expect(() => registry.register(collision)).toThrow("collision");
    await expect(
      Promise.all([registry.remove(first, "done"), registry.remove(first, "again")])
    ).resolves.toEqual([true, true]);
    expect(closed).toEqual(["done"]);
    expect(memory.cancelledSessions).toEqual(["session-1"]);
    expect(memory.terminated).toEqual(["done"]);
    expect(registry.size).toBe(1);
    await registry.shutdown();
    expect(memory.cancelledSessions).toEqual(["session-1", "session-1"]);
    expect(memory.terminated).toEqual(["done", "PlanWeave runtime shutdown."]);
    expect(registry.size).toBe(0);
  });

  it("keeps persisted identities non-actionable after restart and removes ownership on cleanup failure", async () => {
    const registry = new ActiveAgentRunRegistry();
    expect(registry.lookup("executorRunId", "/stale/run", "RUN-001")).toBeNull();
    const closed: string[] = [];
    const memory = createLifecycle(closed);
    const failing = createInMemoryHandle("/live/run", "RUN-001", "session-1", memory);
    failing.control.connection.close = () => Promise.reject(new Error("cleanup failed"));
    registry.register(failing);
    const shutdownFailure = await registry.shutdown().catch((error: unknown) => error);
    expect(registry.size).toBe(0);
    const removalFailure = await registry.remove(failing, "again").catch((error: unknown) => error);
    expect(shutdownFailure).toBe(removalFailure);
    expect(removalFailure).toMatchObject({
      message: "Runner terminal cleanup did not complete cleanly."
    });
    expect(memory.cancelledSessions).toEqual(["session-1"]);
    expect(memory.terminated).toEqual(["PlanWeave runtime shutdown."]);
  });

  it("rethrows a single pre-removal failure after completing live cleanup", async () => {
    const registry = new ActiveAgentRunRegistry();
    const closed: string[] = [];
    const memory = createLifecycle(closed);
    const failing = createInMemoryHandle("/live/single-failure", "RUN-001", "session-1", memory);
    const preparationFailure = new Error("owner preparation failed");
    failing.beforeRemove = () => Promise.reject(preparationFailure);
    registry.register(failing);

    await expect(registry.remove(failing, "done")).rejects.toBe(preparationFailure);
    expect(closed).toEqual(["done"]);
    expect(memory.cancelledSessions).toEqual(["session-1"]);
    expect(memory.terminated).toEqual(["done"]);
    expect(registry.size).toBe(0);
  });

  it("rethrows a single pre-removal failure for an already absent handle", async () => {
    const registry = new ActiveAgentRunRegistry();
    const closed: string[] = [];
    const memory = createLifecycle(closed);
    const absent = createInMemoryHandle("/live/absent", "RUN-001", "session-1", memory);
    const preparationFailure = new Error("absent owner preparation failed");
    absent.beforeRemove = () => Promise.reject(preparationFailure);

    await expect(registry.remove(absent, "done")).rejects.toBe(preparationFailure);
    expect(closed).toEqual([]);
    expect(memory.cancelledSessions).toEqual([]);
    expect(memory.terminated).toEqual([]);
    expect(registry.size).toBe(0);
  });

  it("aggregates independent pre-removal and live cleanup failures", async () => {
    const registry = new ActiveAgentRunRegistry();
    const closed: string[] = [];
    const memory = createLifecycle(closed);
    const failing = createInMemoryHandle("/live/multiple-failures", "RUN-001", "session-1", memory);
    const preparationFailure = new Error("owner preparation failed");
    failing.beforeRemove = () => Promise.reject(preparationFailure);
    failing.control.connection.close = (reason) => {
      closed.push(reason);
      return Promise.reject(new Error("live cleanup failed"));
    };
    registry.register(failing);

    const failure = await registry.remove(failing, "done").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure instanceof AggregateError && failure.errors).toHaveLength(2);
    expect(failure instanceof AggregateError && failure.errors[0]).toBe(preparationFailure);
    expect(failure instanceof AggregateError && failure.errors[1]).toMatchObject({
      message: "Runner terminal cleanup did not complete cleanly."
    });
    expect(closed).toEqual(["done"]);
    expect(memory.cancelledSessions).toEqual(["session-1"]);
    expect(memory.terminated).toEqual(["done"]);
    expect(registry.size).toBe(0);
  });

  it("aggregates direct failures from independent handles during shutdown", async () => {
    const registry = new ActiveAgentRunRegistry();
    const closed: string[] = [];
    const memory = createLifecycle(closed);
    const first = createInMemoryHandle("/live/shutdown-a", "RUN-001", "session-1", memory);
    const second = createInMemoryHandle("/live/shutdown-b", "RUN-002", "session-2", memory);
    const firstFailure = new Error("first shutdown preparation failed");
    const secondFailure = new Error("second shutdown preparation failed");
    first.beforeRemove = () => Promise.reject(firstFailure);
    second.beforeRemove = () => Promise.reject(secondFailure);
    registry.register(first);
    registry.register(second);

    const failure = await registry.shutdown().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure instanceof AggregateError && failure.errors).toEqual([
      firstFailure,
      secondFailure
    ]);
    expect(closed).toEqual(["PlanWeave runtime shutdown.", "PlanWeave runtime shutdown."]);
    expect(memory.cancelledSessions).toEqual(["session-1", "session-2"]);
    expect(memory.terminated).toEqual([
      "PlanWeave runtime shutdown.",
      "PlanWeave runtime shutdown."
    ]);
    expect(registry.size).toBe(0);
  });

  it("rethrows a single Desktop-run shutdown failure by identity", async () => {
    const registry = new ActiveAgentRunRegistry();
    const closed: string[] = [];
    const memory = createLifecycle(closed);
    const failing = createInMemoryHandle("/live/desktop-single", "RUN-001", "session-1", memory);
    failing.identity.desktopRunId = "DESKTOP-RUN-001";
    const preparationFailure = new Error("Desktop owner preparation failed");
    failing.beforeRemove = () => Promise.reject(preparationFailure);
    registry.register(failing);

    await expect(registry.shutdownDesktopRun("DESKTOP-RUN-001", "Desktop shutdown")).rejects.toBe(
      preparationFailure
    );
    expect(closed).toEqual(["Desktop shutdown"]);
    expect(memory.cancelledSessions).toEqual(["session-1"]);
    expect(memory.terminated).toEqual(["Desktop shutdown"]);
    expect(registry.size).toBe(0);
  });

  it("aggregates direct failures from matching Desktop runs", async () => {
    const registry = new ActiveAgentRunRegistry();
    const closed: string[] = [];
    const memory = createLifecycle(closed);
    const first = createInMemoryHandle("/live/desktop-a", "RUN-001", "session-1", memory);
    const second = createInMemoryHandle("/live/desktop-b", "RUN-002", "session-2", memory);
    first.identity.desktopRunId = "DESKTOP-RUN-001";
    second.identity.desktopRunId = "DESKTOP-RUN-001";
    const firstFailure = new Error("first Desktop owner preparation failed");
    const secondFailure = new Error("second Desktop owner preparation failed");
    first.beforeRemove = () => Promise.reject(firstFailure);
    second.beforeRemove = () => Promise.reject(secondFailure);
    registry.register(first);
    registry.register(second);

    const failure = await registry
      .shutdownDesktopRun("DESKTOP-RUN-001", "Desktop shutdown")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure instanceof AggregateError && failure.errors).toEqual([
      firstFailure,
      secondFailure
    ]);
    expect(closed).toEqual(["Desktop shutdown", "Desktop shutdown"]);
    expect(memory.cancelledSessions).toEqual(["session-1", "session-2"]);
    expect(memory.terminated).toEqual(["Desktop shutdown", "Desktop shutdown"]);
    expect(registry.size).toBe(0);
  });
});
