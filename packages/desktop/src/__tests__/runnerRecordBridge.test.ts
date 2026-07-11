import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizedRunnerEventSchema,
  projectAcpConversation,
  runnerRecordReadModelSchema,
  type NormalizedRunnerEvent
} from "@planweave-ai/runtime";
import {
  desktopBridgeInvokeChannels,
  runnerRecordEventChannel,
  runnerRecordSubscribeChannel,
  runnerRecordUnsubscribeChannel
} from "../shared/ipcChannels";
import {
  getRuntimeBridgeMocks,
  resetRuntimeBridgeMocks,
  restoreRuntimeBridgeEnv
} from "./support/runtimeBridgeTestHarness.js";

const { electronMock, runtimeMock } = getRuntimeBridgeMocks();

function runnerEvent(sequence: number, kind: "message" | "terminal" = "message") {
  return normalizedRunnerEventSchema.parse({
    version: "planweave.runner-event/v1",
    sequence,
    timestamp: "2026-07-11T00:00:00.000Z",
    identity: {
      projectId: "project-1",
      canvasId: "canvas-a",
      taskId: "T-001",
      blockId: "B-001",
      claimRef: "T-001#B-001",
      runId: "RUN-001",
      runOwner: "executor",
      runSessionId: "SESSION-001",
      desktopRunId: "DESKTOP-001",
      executorRunId: "RUN-001"
    },
    runner: { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" },
    correlation: { sessionId: "session-1" },
    body:
      kind === "terminal"
        ? {
            kind: "terminal",
            outcome: {
              version: "planweave.runner/v1",
              state: "succeeded",
              exitCode: 0,
              finishedAt: "2026-07-11T00:00:01.000Z",
              diagnostic: null,
              artifactValidated: true
            }
          }
        : {
            kind: "message",
            role: "assistant",
            messageId: `message-${sequence}`,
            chunk: true,
            content: `message ${sequence}`,
            redaction: { classes: [], replaced: 0 }
          }
  });
}

function readModel(events: NormalizedRunnerEvent[]) {
  const last = events.at(-1);
  return runnerRecordReadModelSchema.parse({
    events,
    conversation: projectAcpConversation(events),
    diagnostics: [],
    cursor: {
      version: "planweave.runner-event-cursor/v1",
      runId: "RUN-001",
      afterSequence: last?.sequence ?? 0,
      canonicalIdentity: last ? { identity: last.identity, runner: last.runner } : null,
      terminal: last?.body.kind === "terminal"
    },
    terminal: last?.body.kind === "terminal",
    interaction: {
      persisted: false,
      active: false,
      stale: false,
      activeRequests: []
    }
  });
}

function sender(id: number) {
  let destroyed = false;
  let destroyListener: (() => void) | null = null;
  return {
    id,
    send: vi.fn(),
    isDestroyed: vi.fn(() => destroyed),
    once: vi.fn((_event: string, listener: () => void) => {
      destroyListener = listener;
    }),
    removeListener: vi.fn((_event: string, listener: () => void) => {
      if (destroyListener === listener) destroyListener = null;
    }),
    destroy: () => {
      destroyed = true;
      destroyListener?.();
    }
  };
}

const input = {
  subscriptionId: "subscription-1",
  ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
  recordId: "T-001#B-001::RUN-001"
};

describe("runner record desktop bridge", () => {
  beforeEach(async () => {
    await resetRuntimeBridgeMocks();
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();
  });

  afterEach(async () => restoreRuntimeBridgeEnv());

  it("reveals artifacts only after runtime record-boundary verification", async () => {
    const handler = electronMock.handlers.get(
      desktopBridgeInvokeChannels.revealRunnerRecordArtifact
    );
    const reference = {
      version: "planweave.runner/v1",
      kind: "implementation",
      relativePath: "report.md",
      sha256: "a".repeat(64),
      sizeBytes: 42,
      mediaType: "text/markdown"
    };
    await handler?.(
      {},
      { projectRoot: "/tmp/project", canvasId: "canvas-a" },
      "T-001#B-001::RUN-001",
      reference
    );
    expect(runtimeMock.resolveRunRecordArtifactPath).toHaveBeenCalled();
    expect(electronMock.shell.showItemInFolder).toHaveBeenCalledWith("/tmp/project/report.md");

    electronMock.shell.showItemInFolder.mockClear();
    runtimeMock.resolveRunRecordArtifactPath.mockRejectedValueOnce(
      new Error("Artifact path is outside the selected record.")
    );
    await expect(
      handler?.(
        {},
        { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        "T-001#B-001::RUN-001",
        { ...reference, relativePath: "../outside.md" }
      )
    ).rejects.toThrow("outside");
    expect(electronMock.shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("returns replay before forwarding ordered live events and releases on terminal", async () => {
    const webContents = sender(1);
    let receive: ((snapshot: ReturnType<typeof readModel>) => void) | null = null;
    const unsubscribe = vi.fn();
    let close!: () => void;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    runtimeMock.subscribeRunRecord.mockImplementation(
      async (_workspace, _recordId, _cursor, listener) => {
        receive = listener;
        return {
          snapshot: readModel([runnerEvent(1)]),
          subscription: { unsubscribe, closed }
        };
      }
    );
    const handler = electronMock.handlers.get(runnerRecordSubscribeChannel);

    const start = (await handler?.({ sender: webContents }, input)) as {
      snapshot: { events: Array<{ sequence: number }> };
    };
    receive?.(readModel([runnerEvent(2)]));
    receive?.(readModel([runnerEvent(3, "terminal")]));

    expect(start.snapshot.events.map((event) => event.sequence)).toEqual([1]);
    expect(webContents.send.mock.calls.map((call) => call[1].snapshot.cursor.afterSequence)).toEqual([2, 3]);
    expect(webContents.send.mock.calls.map((call) => call[1].updateSequence)).toEqual([1, 2]);
    expect(webContents.send).toHaveBeenCalledWith(
      runnerRecordEventChannel,
      expect.objectContaining({ subscriptionId: "subscription-1" })
    );
    close();
    await closed;
  });

  it("unsubscribes deterministically and tears down on window destruction", async () => {
    const unsubscribeFirst = vi.fn();
    const unsubscribeSecond = vi.fn();
    const listeners: Array<(snapshot: ReturnType<typeof readModel>) => void> = [];
    runtimeMock.subscribeRunRecord
      .mockImplementationOnce(async (_workspace, _recordId, _cursor, listener) => {
        listeners.push(listener);
        return {
          snapshot: null,
          subscription: {
            unsubscribe: unsubscribeFirst,
            closed: new Promise<void>(() => undefined)
          }
        };
      })
      .mockImplementationOnce(async (_workspace, _recordId, _cursor, listener) => {
        listeners.push(listener);
        return {
          snapshot: null,
          subscription: {
            unsubscribe: unsubscribeSecond,
            closed: new Promise<void>(() => undefined)
          }
        };
      });
    const first = sender(1);
    const second = sender(2);
    const subscribeHandler = electronMock.handlers.get(runnerRecordSubscribeChannel);
    const unsubscribeHandler = electronMock.handlers.get(runnerRecordUnsubscribeChannel);
    await subscribeHandler?.({ sender: first }, input);
    await subscribeHandler?.({ sender: second }, { ...input, subscriptionId: "subscription-2" });

    await unsubscribeHandler?.({ sender: first }, "subscription-1");
    second.destroy();
    listeners[0]?.(readModel([runnerEvent(2, "terminal")]));
    listeners[1]?.(readModel([runnerEvent(2)]));

    expect(unsubscribeFirst).toHaveBeenCalledTimes(1);
    expect(first.removeListener).toHaveBeenCalledTimes(1);
    expect(unsubscribeSecond).toHaveBeenCalledTimes(1);
    expect(first.send).not.toHaveBeenCalled();
    expect(second.send).not.toHaveBeenCalled();
  });

  it("isolates concurrent renderer subscriptions and rejects destroyed or mismatched requests", async () => {
    const listeners: Array<(snapshot: ReturnType<typeof readModel>) => void> = [];
    runtimeMock.subscribeRunRecord.mockImplementation(
      async (_workspace, _recordId, _cursor, listener) => {
        listeners.push(listener);
        return {
          snapshot: null,
          subscription: { unsubscribe: vi.fn(), closed: new Promise<void>(() => undefined) }
        };
      }
    );
    const first = sender(1);
    const second = sender(2);
    const handler = electronMock.handlers.get(runnerRecordSubscribeChannel);
    await handler?.({ sender: first }, input);
    await handler?.({ sender: second }, { ...input, subscriptionId: "subscription-2" });

    listeners[0]?.(readModel([runnerEvent(2)]));
    listeners[1]?.(readModel([runnerEvent(2)]));
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(second.send).toHaveBeenCalledTimes(1);

    const destroyed = sender(3);
    destroyed.destroy();
    await expect(handler?.({ sender: destroyed }, input)).rejects.toThrow("destroyed");
    runtimeMock.subscribeRunRecord.mockRejectedValueOnce(new Error("identity_mismatch"));
    await expect(handler?.({ sender: sender(4) }, input)).rejects.toThrow("identity_mismatch");
  });

  it("routes strict pending request list and response calls through runtime", async () => {
    const identity = {
      scope: "/tmp/run",
      executorRunId: "RUN-001",
      desktopRunId: "DESKTOP-001",
      runSessionId: "SESSION-001",
      claimRef: "T-001#B-001",
      sessionId: "session-1",
      requestId: "permission-1"
    };
    runtimeMock.listDesktopPendingAgentRequests.mockResolvedValue([{ requestId: "permission-1" }]);
    const list = electronMock.handlers.get(desktopBridgeInvokeChannels.listPendingAgentRequests);
    const respond = electronMock.handlers.get(desktopBridgeInvokeChannels.respondToAgentRequest);

    await expect(list?.({}, identity)).resolves.toEqual([{ requestId: "permission-1" }]);
    await respond?.({}, identity, { optionId: "allow" });

    expect(runtimeMock.listDesktopPendingAgentRequests).toHaveBeenCalledWith(identity);
    expect(runtimeMock.respondToDesktopAgentRequest).toHaveBeenCalledWith(identity, {
      optionId: "allow"
    });
    expect(() => list?.({}, { ...identity, desktopRunId: "" })).toThrow();
  });
});
