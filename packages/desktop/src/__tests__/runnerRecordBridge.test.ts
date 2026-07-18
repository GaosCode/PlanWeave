import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizedRunnerEventSchema,
  projectAcpConversation,
  projectAcpTimeline,
  RunnerInteractionApiError,
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
    timeline: projectAcpTimeline(events),
    diagnostics: [],
    cursor: {
      version: "planweave.runner-event-cursor/v1",
      runId: "RUN-001",
      afterSequence: last?.sequence ?? 0,
      canonicalIdentity: last ? { identity: last.identity, runner: last.runner } : null,
      terminal: last?.body.kind === "terminal"
    },
    terminal: last?.body.kind === "terminal",
    actualConfiguration: {
      available: false,
      reason: "No authoritative ACP session configuration snapshot was recorded for this run."
    },
    intervention: {
      prompt: {
        available: false,
        reason: "No completed ACP session is available.",
        identity: null,
        inFlight: false
      },
      cancel: {
        available: false,
        reason: "No live owned ACP session is available.",
        identity: null
      }
    },
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
  it("registers the ACP prompt handler and rejects malformed identities before dispatch", async () => {
    const sendPrompt = electronMock.handlers.get(desktopBridgeInvokeChannels.sendAgentPrompt);

    expect(sendPrompt).toBeTypeOf("function");
    expect(() =>
      sendPrompt?.({ sender: sender(99) }, { recordId: "../../escape" }, "continue")
    ).toThrow();
  });
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
      handler?.({}, { projectRoot: "/tmp/project", canvasId: "canvas-a" }, "T-001#B-001::RUN-001", {
        ...reference,
        relativePath: "../outside.md"
      })
    ).rejects.toThrow("outside");
    expect(electronMock.shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("returns replay before forwarding ordered live events and releases on terminal", async () => {
    const webContents = sender(1);
    let receive: ((snapshot: ReturnType<typeof readModel>) => void) | null = null;
    const unsubscribe = vi.fn();
    let close!: (result: {
      reason: string;
      lastSequence: number;
      recoverable: boolean;
      message: string;
    }) => void;
    const closed = new Promise<{
      reason: string;
      lastSequence: number;
      recoverable: boolean;
      message: string;
    }>((resolve) => {
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
    expect(
      webContents.send.mock.calls
        .filter((call) => call[1].kind === "snapshot")
        .map((call) => call[1].snapshot.cursor.afterSequence)
    ).toEqual([2, 3]);
    expect(
      webContents.send.mock.calls
        .filter((call) => call[1].kind === "snapshot")
        .map((call) => call[1].updateSequence)
    ).toEqual([1, 2]);
    expect(webContents.send).toHaveBeenCalledWith(
      runnerRecordEventChannel,
      expect.objectContaining({ kind: "snapshot", subscriptionId: "subscription-1" })
    );
    close({
      reason: "terminal",
      lastSequence: 3,
      recoverable: false,
      message: "ACP event subscription closed after terminal event."
    });
    await closed;
    await vi.waitFor(() => {
      expect(webContents.send).toHaveBeenCalledWith(
        runnerRecordEventChannel,
        expect.objectContaining({
          kind: "closed",
          subscriptionId: "subscription-1",
          close: expect.objectContaining({ reason: "terminal", recoverable: false })
        })
      );
    });
  });

  it("surfaces not_subscribable for non-terminal snapshot with null subscription", async () => {
    const webContents = sender(1);
    const nonTerminal = readModel([runnerEvent(1)]);
    expect(nonTerminal.terminal).toBe(false);
    runtimeMock.subscribeRunRecord.mockResolvedValue({
      snapshot: {
        ...nonTerminal,
        diagnostics: [
          {
            code: "identity_mismatch",
            line: null,
            message: "Runner event identity does not match selected record."
          }
        ]
      },
      subscription: null
    });
    const handler = electronMock.handlers.get(runnerRecordSubscribeChannel);
    const start = (await handler?.({ sender: webContents }, input)) as {
      snapshot: { terminal: boolean; cursor: { afterSequence: number } };
    };

    expect(start.snapshot.terminal).toBe(false);
    expect(start.snapshot.cursor.afterSequence).toBe(1);
    await vi.waitFor(() => {
      expect(webContents.send).toHaveBeenCalledWith(
        runnerRecordEventChannel,
        expect.objectContaining({
          kind: "closed",
          subscriptionId: "subscription-1",
          close: expect.objectContaining({
            reason: "not_subscribable",
            recoverable: false,
            lastSequence: 1,
            message: expect.stringContaining("identity")
          })
        })
      );
    });
    // Must not be forged as a silent terminal end.
    expect(
      webContents.send.mock.calls.some(
        (call) => call[1]?.kind === "closed" && call[1]?.close?.reason === "terminal"
      )
    ).toBe(false);
  });

  it("still closes as terminal when snapshot is terminal and subscription is null", async () => {
    const webContents = sender(1);
    const terminalSnapshot = readModel([runnerEvent(1), runnerEvent(2, "terminal")]);
    expect(terminalSnapshot.terminal).toBe(true);
    runtimeMock.subscribeRunRecord.mockResolvedValue({
      snapshot: terminalSnapshot,
      subscription: null
    });
    const handler = electronMock.handlers.get(runnerRecordSubscribeChannel);
    await handler?.({ sender: webContents }, input);

    await vi.waitFor(() => {
      expect(webContents.send).toHaveBeenCalledWith(
        runnerRecordEventChannel,
        expect.objectContaining({
          kind: "closed",
          close: expect.objectContaining({
            reason: "terminal",
            recoverable: false,
            lastSequence: 2
          })
        })
      );
    });
  });

  it("pushes recoverable closed before releasing ownership", async () => {
    const webContents = sender(1);
    const unsubscribe = vi.fn();
    let close!: (result: {
      reason: string;
      lastSequence: number;
      recoverable: boolean;
      message: string;
    }) => void;
    const closed = new Promise<{
      reason: string;
      lastSequence: number;
      recoverable: boolean;
      message: string;
    }>((resolve) => {
      close = resolve;
    });
    runtimeMock.subscribeRunRecord.mockResolvedValue({
      snapshot: readModel([runnerEvent(1)]),
      subscription: { unsubscribe, closed }
    });
    const handler = electronMock.handlers.get(runnerRecordSubscribeChannel);
    await handler?.({ sender: webContents }, input);

    close({
      reason: "subscriber_backpressure",
      lastSequence: 1,
      recoverable: true,
      message: "Subscriber exceeded pending capacity."
    });
    await closed;
    await vi.waitFor(() => {
      expect(webContents.send).toHaveBeenCalledWith(
        runnerRecordEventChannel,
        expect.objectContaining({
          kind: "closed",
          subscriptionId: "subscription-1",
          updateSequence: 1,
          close: expect.objectContaining({
            reason: "subscriber_backpressure",
            recoverable: true,
            lastSequence: 1
          })
        })
      );
    });
    // Publisher already closed the runtime subscription; bridge must not force a second unsubscribe.
    expect(unsubscribe).toHaveBeenCalledTimes(0);
  });

  it("unsubscribes deterministically and tears down on window destruction", async () => {
    const unsubscribeFirst = vi.fn();
    const unsubscribeSecond = vi.fn();
    const listeners: Array<(snapshot: ReturnType<typeof readModel>) => void> = [];
    let closeFirst!: (result: {
      reason: string;
      lastSequence: number;
      recoverable: boolean;
      message: string;
    }) => void;
    const closedFirst = new Promise<{
      reason: string;
      lastSequence: number;
      recoverable: boolean;
      message: string;
    }>((resolve) => {
      closeFirst = resolve;
    });
    runtimeMock.subscribeRunRecord
      .mockImplementationOnce(async (_workspace, _recordId, _cursor, listener) => {
        listeners.push(listener);
        return {
          snapshot: null,
          subscription: {
            unsubscribe: () => {
              unsubscribeFirst();
              closeFirst({
                reason: "explicit_unsubscribe",
                lastSequence: 0,
                recoverable: false,
                message: "unsubscribed"
              });
            },
            closed: closedFirst
          }
        };
      })
      .mockImplementationOnce(async (_workspace, _recordId, _cursor, listener) => {
        listeners.push(listener);
        return {
          snapshot: null,
          subscription: {
            unsubscribe: unsubscribeSecond,
            closed: new Promise(() => undefined)
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
    await closedFirst;
    await vi.waitFor(() => {
      expect(first.send).toHaveBeenCalledWith(
        runnerRecordEventChannel,
        expect.objectContaining({
          kind: "closed",
          subscriptionId: "subscription-1",
          close: expect.objectContaining({ reason: "explicit_unsubscribe" })
        })
      );
    });
    second.destroy();
    listeners[0]?.(readModel([runnerEvent(2, "terminal")]));
    listeners[1]?.(readModel([runnerEvent(2)]));

    expect(unsubscribeFirst).toHaveBeenCalledTimes(1);
    expect(first.removeListener).toHaveBeenCalledTimes(1);
    expect(unsubscribeSecond).toHaveBeenCalledTimes(1);
    expect(second.send).not.toHaveBeenCalled();
  });

  it("isolates concurrent renderer subscriptions and rejects destroyed or mismatched requests", async () => {
    const listeners: Array<(snapshot: ReturnType<typeof readModel>) => void> = [];
    runtimeMock.subscribeRunRecord.mockImplementation(
      async (_workspace, _recordId, _cursor, listener) => {
        listeners.push(listener);
        return {
          snapshot: null,
          subscription: { unsubscribe: vi.fn(), closed: new Promise(() => undefined) }
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
    expect(first.send.mock.calls[0]?.[1]).toMatchObject({
      kind: "snapshot",
      subscriptionId: "subscription-1"
    });
    expect(second.send.mock.calls[0]?.[1]).toMatchObject({
      kind: "snapshot",
      subscriptionId: "subscription-2"
    });

    const destroyed = sender(3);
    destroyed.destroy();
    await expect(handler?.({ sender: destroyed }, input)).rejects.toThrow("destroyed");
    runtimeMock.subscribeRunRecord.mockRejectedValueOnce(new Error("identity_mismatch"));
    await expect(handler?.({ sender: sender(4) }, input)).rejects.toThrow("identity_mismatch");
  });

  it("routes strict pending request, response, and cancellation calls through runtime", async () => {
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
    const authenticate = electronMock.handlers.get(
      desktopBridgeInvokeChannels.respondToAgentAuthenticationRequest
    );
    const cancel = electronMock.handlers.get(desktopBridgeInvokeChannels.cancelAgentRun);
    const ref = { projectRoot: "/tmp/project", canvasId: "canvas-a" };
    const recordId = "T-001#B-001::RUN-001";

    await expect(list?.({}, identity)).resolves.toEqual([{ requestId: "permission-1" }]);
    await respond?.({}, ref, recordId, identity, { kind: "select", optionId: "allow" });
    await authenticate?.({}, identity, { token: "credential" });
    const { requestId: _requestId, ...sessionIdentity } = identity;
    await cancel?.({}, ref, recordId, sessionIdentity);

    expect(runtimeMock.listDesktopPendingAgentRequests).toHaveBeenCalledWith(identity);
    expect(runtimeMock.respondToDesktopAgentRequest).toHaveBeenCalledWith(ref, recordId, identity, {
      kind: "select",
      optionId: "allow"
    });
    expect(runtimeMock.respondToDesktopAgentAuthenticationRequest).toHaveBeenCalledWith(identity, {
      token: "credential"
    });
    expect(runtimeMock.cancelDesktopAgentRun).toHaveBeenCalledWith(ref, recordId, sessionIdentity);
    expect(() => list?.({}, { ...identity, desktopRunId: "" })).toThrow();
    expect(() => cancel?.({}, ref, recordId, { ...sessionIdentity, runSessionId: "" })).toThrow();
  });

  it("routes canvas-scoped persisted interaction responses and validates the receipt", async () => {
    const ref = { projectRoot: "/tmp/project", canvasId: "canvas-a" };
    const action = {
      recordId: "T-001#B-001::RUN-001",
      requestId: "permission-1",
      ownerLeaseId: "11111111-1111-4111-8111-111111111111"
    };
    const decision = { kind: "select" as const, optionId: "allow-once" };
    const audit = { decisionSource: "planweave-desktop", reason: null };
    const list = electronMock.handlers.get(
      desktopBridgeInvokeChannels.listPendingRunnerInteractions
    );
    const respond = electronMock.handlers.get(
      desktopBridgeInvokeChannels.respondToRunnerInteraction
    );

    await expect(list?.({}, ref)).resolves.toEqual({ ok: true, value: [] });
    await expect(respond?.({}, ref, action, decision, audit)).resolves.toMatchObject({
      ok: true,
      value: {
        version: "planweave.runner-interaction-response-receipt/v1",
        decision,
        decisionSource: "planweave-desktop"
      }
    });
    expect(runtimeMock.listPendingRunnerInteractions).toHaveBeenCalledWith(ref);
    expect(runtimeMock.respondToRunnerInteractionAction).toHaveBeenCalledWith(
      ref,
      action,
      decision,
      audit
    );

    runtimeMock.respondToRunnerInteractionAction.mockRejectedValueOnce(
      new RunnerInteractionApiError("interaction_owner_replaced", "Runner owner was replaced.", {
        ownerGeneration: 2
      })
    );
    await expect(respond?.({}, ref, action, decision, audit)).resolves.toEqual({
      ok: false,
      error: {
        code: "interaction_owner_replaced",
        message: "Runner owner was replaced.",
        details: { ownerGeneration: 2 }
      }
    });

    await expect(list?.({}, { projectRoot: "", canvasId: "canvas-a" })).resolves.toMatchObject({
      ok: false,
      error: { code: "interaction_contract_invalid" }
    });
    await expect(
      respond?.({}, ref, { ...action, ownerLeaseId: "../escape" }, decision, audit)
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "interaction_contract_invalid" }
    });
    await expect(
      respond?.({}, ref, action, decision, { ...audit, decisionSource: "bad source" })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "interaction_contract_invalid" }
    });
  });
});
