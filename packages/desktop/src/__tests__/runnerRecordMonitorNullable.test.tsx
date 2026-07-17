/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import {
  projectAcpConversation,
  projectAcpTimeline,
  type DesktopBridgeApi,
  type DesktopRunnerRecordSubscriptionUpdate,
  type RunnerRecordReadModel
} from "@planweave-ai/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRunnerRecordMonitor } from "../renderer/hooks/useRunnerRecordMonitor";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

function liveModel(): RunnerRecordReadModel {
  return {
    events: [],
    conversation: [],
    timeline: [],
    diagnostics: [],
    cursor: {
      version: "planweave.runner-event-cursor/v1",
      runId: "RUN-001",
      afterSequence: 0,
      canonicalIdentity: null,
      terminal: false
    },
    terminal: false,
    intervention: {
      prompt: {
        available: false,
        reason: "No live prompt capability.",
        identity: null,
        inFlight: false
      },
      cancel: {
        available: false,
        reason: "No live cancel capability.",
        identity: null
      }
    },
    interaction: {
      persisted: false,
      active: false,
      stale: false,
      activeRequests: []
    }
  };
}

function modelWithEvent(sequence: number, content: string): RunnerRecordReadModel {
  const model = liveModel();
  return {
    ...model,
    events: [
      {
        version: "planweave.runner-event/v1",
        sequence,
        timestamp: "2026-07-13T00:00:00.000Z",
        identity: {
          projectId: "project-a",
          canvasId: "canvas-main",
          taskId: "T-001",
          blockId: "B-001",
          claimRef: "T-001#B-001",
          runId: "RUN-001",
          runOwner: "executor",
          runSessionId: "SESSION-001",
          desktopRunId: "DESKTOP-RUN-001",
          executorRunId: "RUN-001"
        },
        runner: { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" },
        body: {
          kind: "message",
          role: "assistant",
          messageId: null,
          chunk: true,
          content,
          redaction: { classes: [], replaced: 0 }
        }
      }
    ],
    cursor: { ...model.cursor, afterSequence: sequence }
  };
}

describe("nullable runner record monitoring", () => {
  it("keeps a null read model explicit and never subscribes", () => {
    const subscribeRunnerRecord = vi.fn<DesktopBridgeApi["subscribeRunnerRecord"]>();
    const { result } = renderHook(() =>
      useRunnerRecordMonitor({
        api: { subscribeRunnerRecord },
        canvasRef: { projectRoot: "/projects/demo", canvasId: "canvas-main" },
        initialModel: null,
        recordId: "T-001#B-001::RUN-001"
      })
    );

    expect(result.current).toEqual({ model: null, subscriptionError: null });
    expect(subscribeRunnerRecord).not.toHaveBeenCalled();
  });

  it("preserves live subscription cleanup for a non-null read model", async () => {
    const unsubscribe = vi.fn(async () => undefined);
    const subscribeRunnerRecord = vi.fn<DesktopBridgeApi["subscribeRunnerRecord"]>(async () => ({
      subscriptionId: "subscription-1",
      updateSequence: 0,
      snapshot: null,
      unsubscribe
    }));
    const rendered = renderHook(() =>
      useRunnerRecordMonitor({
        api: { subscribeRunnerRecord },
        canvasRef: { projectRoot: "/projects/demo", canvasId: "canvas-main" },
        initialModel: liveModel(),
        recordId: "T-001#B-001::RUN-001"
      })
    );

    await waitFor(() => expect(subscribeRunnerRecord).toHaveBeenCalledOnce());
    rendered.unmount();
    await waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
  });

  it("merges an immediate incremental subscription snapshot with the selected persisted model", async () => {
    const initialModel = modelWithEvent(1, "persisted");
    const incrementalModel = modelWithEvent(2, "incremental");
    const subscribeRunnerRecord = vi.fn<DesktopBridgeApi["subscribeRunnerRecord"]>(async () => ({
      subscriptionId: "subscription-1",
      updateSequence: 0,
      snapshot: incrementalModel,
      unsubscribe: vi.fn(async () => undefined)
    }));
    const { result } = renderHook(() =>
      useRunnerRecordMonitor({
        api: { subscribeRunnerRecord },
        canvasRef: { projectRoot: "/projects/demo", canvasId: "canvas-main" },
        initialModel,
        recordId: "T-001#B-001::RUN-001"
      })
    );

    await waitFor(() => expect(result.current.model?.events).toHaveLength(2));
    expect(result.current.model?.events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("does not roll a newer subscription snapshot back to an older revised initial model", async () => {
    let onUpdate: Parameters<DesktopBridgeApi["subscribeRunnerRecord"]>[1] | null = null;
    const subscribeRunnerRecord = vi.fn<DesktopBridgeApi["subscribeRunnerRecord"]>(
      async (_input, callback) => {
        onUpdate = callback;
        return {
          subscriptionId: "subscription-1",
          updateSequence: 0,
          snapshot: null,
          unsubscribe: vi.fn(async () => undefined)
        };
      }
    );
    const initialModel = modelWithEvent(1, "persisted");
    const rendered = renderHook(
      ({ model }) =>
        useRunnerRecordMonitor({
          api: { subscribeRunnerRecord },
          canvasRef: { projectRoot: "/projects/demo", canvasId: "canvas-main" },
          initialModel: model,
          recordId: "T-001#B-001::RUN-001"
        }),
      { initialProps: { model: initialModel } }
    );

    await waitFor(() => expect(onUpdate).not.toBeNull());
    await act(async () => {
      onUpdate!({ kind: "snapshot", updateSequence: 1, snapshot: modelWithEvent(2, "live") });
    });
    expect(rendered.result.current.model?.cursor.afterSequence).toBe(2);

    rendered.rerender({
      model: {
        ...initialModel,
        diagnostics: [{ code: "persisted_revision", message: "Persisted model revised." }]
      }
    });

    expect(rendered.result.current.model?.cursor.afterSequence).toBe(2);
    expect(rendered.result.current.model?.events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  describe("bounded reconnect on recoverable closed push", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("reconnects from the last merged cursor with fixed backoff and a fresh updateSequence generation", async () => {
      const callbacks: Array<(update: DesktopRunnerRecordSubscriptionUpdate) => void> = [];
      const subscribeRunnerRecord = vi.fn<DesktopBridgeApi["subscribeRunnerRecord"]>(
        async (input, callback) => {
          callbacks.push(callback);
          return {
            subscriptionId: `subscription-${callbacks.length}`,
            updateSequence: 0,
            snapshot: null,
            unsubscribe: vi.fn(async () => undefined)
          };
        }
      );
      const bridgeApi = { subscribeRunnerRecord };
      const canvasRef = { projectRoot: "/projects/demo", canvasId: "canvas-main" };
      const initialModel = modelWithEvent(1, "persisted");
      const { result } = renderHook(() =>
        useRunnerRecordMonitor({
          api: bridgeApi,
          canvasRef,
          initialModel,
          recordId: "T-001#B-001::RUN-001"
        })
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(subscribeRunnerRecord).toHaveBeenCalledTimes(1);
      expect(subscribeRunnerRecord.mock.calls[0]?.[0].cursor?.afterSequence).toBe(1);

      await act(async () => {
        callbacks[0]!({
          kind: "snapshot",
          updateSequence: 1,
          snapshot: modelWithEvent(2, "live")
        });
      });
      expect(result.current.model?.cursor.afterSequence).toBe(2);

      await act(async () => {
        callbacks[0]!({
          kind: "closed",
          updateSequence: 2,
          close: {
            reason: "subscriber_backpressure",
            lastSequence: 2,
            recoverable: true,
            message: "Subscriber exceeded pending capacity."
          }
        });
      });
      expect(result.current.subscriptionError).toBeNull();
      expect(result.current.model?.cursor.afterSequence).toBe(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(subscribeRunnerRecord).toHaveBeenCalledTimes(2);
      expect(subscribeRunnerRecord.mock.calls.map((call) => call[0].cursor?.afterSequence)).toEqual(
        [1, 2]
      );

      // Stale generation updateSequence must not pollute the new subscription generation.
      await act(async () => {
        callbacks[0]!({
          kind: "snapshot",
          updateSequence: 99,
          snapshot: modelWithEvent(99, "stale-generation")
        });
        callbacks[1]!({
          kind: "snapshot",
          updateSequence: 1,
          snapshot: modelWithEvent(3, "reconnected")
        });
      });
      expect(result.current.model?.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(result.current.model?.events.some((event) => event.sequence === 99)).toBe(false);
    });

    it("stops after the fixed max attempts and keeps the last valid model with subscriptionError", async () => {
      const callbacks: Array<(update: DesktopRunnerRecordSubscriptionUpdate) => void> = [];
      const subscribeRunnerRecord = vi.fn<DesktopBridgeApi["subscribeRunnerRecord"]>(
        async (_input, callback) => {
          callbacks.push(callback);
          return {
            subscriptionId: `subscription-${callbacks.length}`,
            updateSequence: 0,
            snapshot: null,
            unsubscribe: vi.fn(async () => undefined)
          };
        }
      );
      const bridgeApi = { subscribeRunnerRecord };
      const canvasRef = { projectRoot: "/projects/demo", canvasId: "canvas-main" };
      const initialModel = modelWithEvent(1, "kept");
      const { result } = renderHook(() =>
        useRunnerRecordMonitor({
          api: bridgeApi,
          canvasRef,
          initialModel,
          recordId: "T-001#B-001::RUN-001"
        })
      );

      await act(async () => {
        await Promise.resolve();
      });

      // Drive recoverable closes until the fixed attempt budget is exhausted.
      let safety = 0;
      while (result.current.subscriptionError === null && safety < 12) {
        safety += 1;
        const callback = callbacks.at(-1);
        expect(callback).toBeTypeOf("function");
        await act(async () => {
          callback!({
            kind: "closed",
            updateSequence: 1,
            close: {
              reason: "subscriber_callback_failed",
              lastSequence: 1,
              recoverable: true,
              message: "Subscriber callback failed: boom"
            }
          });
        });
        if (result.current.subscriptionError) break;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_500);
        });
      }

      expect(result.current.subscriptionError).toContain("boom");
      expect(result.current.model?.events.map((event) => event.sequence)).toEqual([1]);
      // 1 initial + at most 4 reconnects.
      expect(subscribeRunnerRecord.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(subscribeRunnerRecord.mock.calls.length).toBeLessThanOrEqual(5);
      const callsAfterError = subscribeRunnerRecord.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(subscribeRunnerRecord).toHaveBeenCalledTimes(callsAfterError);
    });

    it("does not reset reconnect budget when each generation returns the same-cursor start snapshot", async () => {
      // Mirrors active runtime: every subscribe returns an authoritativeSnapshot with the
      // current cursor even when no new events arrived. Recoverable closes must still exhaust.
      const callbacks: Array<(update: DesktopRunnerRecordSubscriptionUpdate) => void> = [];
      const sameCursorSnapshot = modelWithEvent(1, "authoritative");
      const subscribeRunnerRecord = vi.fn<DesktopBridgeApi["subscribeRunnerRecord"]>(
        async (_input, callback) => {
          callbacks.push(callback);
          return {
            subscriptionId: `subscription-${callbacks.length}`,
            updateSequence: 0,
            snapshot: sameCursorSnapshot,
            unsubscribe: vi.fn(async () => undefined)
          };
        }
      );
      const bridgeApi = { subscribeRunnerRecord };
      const canvasRef = { projectRoot: "/projects/demo", canvasId: "canvas-main" };
      const { result } = renderHook(() =>
        useRunnerRecordMonitor({
          api: bridgeApi,
          canvasRef,
          initialModel: modelWithEvent(1, "kept"),
          recordId: "T-001#B-001::RUN-001"
        })
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(subscribeRunnerRecord).toHaveBeenCalledTimes(1);
      expect(result.current.subscriptionError).toBeNull();

      let safety = 0;
      while (result.current.subscriptionError === null && safety < 12) {
        safety += 1;
        const callback = callbacks.at(-1);
        expect(callback).toBeTypeOf("function");
        await act(async () => {
          callback!({
            kind: "closed",
            updateSequence: 1,
            close: {
              reason: "subscriber_backpressure",
              lastSequence: 1,
              recoverable: true,
              message: "Subscriber exceeded pending capacity."
            }
          });
        });
        if (result.current.subscriptionError) break;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_500);
        });
      }

      expect(result.current.subscriptionError).toContain("pending capacity");
      expect(result.current.model?.cursor.afterSequence).toBe(1);
      // 1 initial + exactly 4 reconnects under a fixed budget.
      expect(subscribeRunnerRecord).toHaveBeenCalledTimes(5);
      const callsAfterError = subscribeRunnerRecord.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(subscribeRunnerRecord).toHaveBeenCalledTimes(callsAfterError);
    });

    it("keeps reconnect budget across same-cursor diagnostics/interaction parent revisions", async () => {
      // Real seam: onAutoRunChanged re-fetches the same record; diagnostics/interaction revise
      // without cursor advance. Budget must still exhaust at 1+4 and not restart.
      const callbacks: Array<(update: DesktopRunnerRecordSubscriptionUpdate) => void> = [];
      const subscribeRunnerRecord = vi.fn<DesktopBridgeApi["subscribeRunnerRecord"]>(
        async (_input, callback) => {
          callbacks.push(callback);
          return {
            subscriptionId: `subscription-${callbacks.length}`,
            updateSequence: 0,
            snapshot: modelWithEvent(1, "authoritative"),
            unsubscribe: vi.fn(async () => undefined)
          };
        }
      );
      const bridgeApi = { subscribeRunnerRecord };
      const baseModel = modelWithEvent(1, "kept");
      const rendered = renderHook(
        ({ model }) =>
          useRunnerRecordMonitor({
            api: bridgeApi,
            // BlockInspectorWindow allocates this value inline on every parent refresh.
            canvasRef: { projectRoot: "/projects/demo", canvasId: "canvas-main" },
            initialModel: model,
            recordId: "T-001#B-001::RUN-001"
          }),
        { initialProps: { model: baseModel } }
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(subscribeRunnerRecord).toHaveBeenCalledTimes(1);

      let closes = 0;
      while (rendered.result.current.subscriptionError === null && closes < 12) {
        closes += 1;
        const callback = callbacks.at(-1);
        expect(callback).toBeTypeOf("function");
        await act(async () => {
          callback!({
            kind: "closed",
            updateSequence: 1,
            close: {
              reason: "subscriber_backpressure",
              lastSequence: 1,
              recoverable: true,
              message: "Subscriber exceeded pending capacity."
            }
          });
        });
        // Mid-budget external model refresh at the same cursor (diagnostics + interaction).
        if (closes === 2 || closes === 4) {
          rendered.rerender({
            model: {
              ...baseModel,
              diagnostics: [
                {
                  code: `diag-${closes}`,
                  message: `External diagnostics revision ${closes}.`
                }
              ],
              interaction: {
                ...baseModel.interaction,
                stale: closes === 4,
                active: closes === 2
              }
            }
          });
        }
        if (rendered.result.current.subscriptionError) break;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_500);
        });
      }

      expect(rendered.result.current.subscriptionError).toContain("pending capacity");
      expect(rendered.result.current.model?.cursor.afterSequence).toBe(1);
      expect(subscribeRunnerRecord).toHaveBeenCalledTimes(5);
      const callsAfterError = subscribeRunnerRecord.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      // Further same-cursor parent revisions must not reopen after budget exhaustion.
      rendered.rerender({
        model: {
          ...baseModel,
          diagnostics: [{ code: "post-exhaust", message: "Still same cursor." }],
          interaction: { ...baseModel.interaction, persisted: true }
        }
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(subscribeRunnerRecord).toHaveBeenCalledTimes(callsAfterError);
      expect(rendered.result.current.subscriptionError).toContain("pending capacity");
    });

    it("keeps nonrecoverable closed error when start snapshot arrives later with advanced cursor", async () => {
      // Preload delivers closed push before invoke resolves; start snapshot may advance cursor.
      // Error must remain sticky while the complete disk-replay projection is still adopted.
      const startSnapshotBase = modelWithEvent(5, "start-advanced");
      const promptIdentity = {
        ref: { projectRoot: "/projects/demo", canvasId: "canvas-main" },
        recordId: "T-001#B-001::RUN-001",
        executorRunId: "RUN-001",
        claimRef: "T-001#B-001",
        sessionId: "session-1"
      } satisfies NonNullable<RunnerRecordReadModel["intervention"]["prompt"]["identity"]>;
      const requestIdentity = {
        scope: "/projects/demo",
        executorRunId: "RUN-001",
        desktopRunId: "DESKTOP-RUN-001",
        runSessionId: "SESSION-001",
        claimRef: "T-001#B-001",
        sessionId: "session-1",
        requestId: "permission-1"
      } satisfies RunnerRecordReadModel["interaction"]["activeRequests"][number]["identity"];
      const { requestId: _requestId, ...sessionIdentity } = requestIdentity;
      const authoritativeStartSnapshot: RunnerRecordReadModel = {
        ...startSnapshotBase,
        conversation: projectAcpConversation(startSnapshotBase.events),
        timeline: projectAcpTimeline(startSnapshotBase.events),
        intervention: {
          prompt: { available: true, reason: null, identity: promptIdentity, inFlight: false },
          cancel: {
            available: true,
            reason: null,
            identity: sessionIdentity
          }
        },
        interaction: {
          persisted: true,
          active: true,
          stale: false,
          activeRequests: [
            {
              requestId: "permission-1",
              interactionId: "permission-1",
              kind: "permission",
              requestedAt: "2026-07-13T00:00:00.000Z",
              summary: "Approve the replayed action?",
              identity: requestIdentity,
              availability: { available: true, reason: null },
              permissionOptions: [{ optionId: "allow", label: "Allow", decision: "approve" }]
            }
          ]
        }
      };
      const subscribeRunnerRecord = vi.fn<DesktopBridgeApi["subscribeRunnerRecord"]>(
        async (_input, callback) => {
          callback({
            kind: "closed",
            updateSequence: 1,
            close: {
              reason: "not_subscribable",
              lastSequence: 0,
              recoverable: false,
              message: "Runner record is not live-subscribable."
            }
          });
          return {
            subscriptionId: "subscription-1",
            updateSequence: 0,
            snapshot: authoritativeStartSnapshot,
            unsubscribe: vi.fn(async () => undefined)
          };
        }
      );
      const bridgeApi = { subscribeRunnerRecord };
      const canvasRef = { projectRoot: "/projects/demo", canvasId: "canvas-main" };
      const { result } = renderHook(() =>
        useRunnerRecordMonitor({
          api: bridgeApi,
          canvasRef,
          initialModel: modelWithEvent(1, "persisted"),
          recordId: "T-001#B-001::RUN-001"
        })
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.subscriptionError).toContain("not live-subscribable");
      expect(result.current.model?.cursor.afterSequence).toBe(5);
      expect(result.current.model?.terminal).toBe(false);
      expect(result.current.model?.conversation).toEqual(authoritativeStartSnapshot.conversation);
      expect(result.current.model?.timeline).toEqual(authoritativeStartSnapshot.timeline);
      expect(result.current.model?.intervention).toEqual(authoritativeStartSnapshot.intervention);
      expect(result.current.model?.interaction).toEqual(authoritativeStartSnapshot.interaction);
      expect(subscribeRunnerRecord).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(subscribeRunnerRecord).toHaveBeenCalledTimes(1);
      expect(result.current.subscriptionError).toContain("not live-subscribable");
    });

    it("adopts a complete terminal start snapshot after a silent terminal close", async () => {
      const startSnapshotBase = modelWithEvent(5, "terminal replay");
      const requestIdentity = {
        scope: "/projects/demo",
        executorRunId: "RUN-001",
        desktopRunId: "DESKTOP-RUN-001",
        runSessionId: "SESSION-001",
        claimRef: "T-001#B-001",
        sessionId: "session-1",
        requestId: "permission-1"
      } satisfies RunnerRecordReadModel["interaction"]["activeRequests"][number]["identity"];
      const terminalStartSnapshot: RunnerRecordReadModel = {
        ...startSnapshotBase,
        conversation: projectAcpConversation(startSnapshotBase.events),
        timeline: projectAcpTimeline(startSnapshotBase.events),
        cursor: { ...startSnapshotBase.cursor, terminal: true },
        terminal: true,
        intervention: {
          prompt: {
            available: false,
            reason: "Terminal replay has no prompt capability.",
            identity: null,
            inFlight: false
          },
          cancel: {
            available: false,
            reason: "Terminal replay cannot be cancelled.",
            identity: null
          }
        },
        interaction: {
          persisted: true,
          active: false,
          stale: true,
          activeRequests: [
            {
              requestId: "permission-1",
              interactionId: "permission-1",
              kind: "permission",
              requestedAt: "2026-07-13T00:00:00.000Z",
              summary: "Persisted terminal interaction",
              identity: requestIdentity,
              availability: { available: false, reason: "Terminal replay is read-only." },
              permissionOptions: [{ optionId: "allow", label: "Allow", decision: "approve" }]
            }
          ]
        }
      };
      let onUpdate: ((update: DesktopRunnerRecordSubscriptionUpdate) => void) | null = null;
      let resolveStart:
        | ((value: Awaited<ReturnType<DesktopBridgeApi["subscribeRunnerRecord"]>>) => void)
        | null = null;
      const unsubscribe = vi.fn(async () => undefined);
      const subscribeRunnerRecord = vi.fn<DesktopBridgeApi["subscribeRunnerRecord"]>(
        async (_input, callback) =>
          new Promise((resolve) => {
            onUpdate = callback;
            resolveStart = resolve;
          })
      );
      const bridgeApi = { subscribeRunnerRecord };
      const { result } = renderHook(() =>
        useRunnerRecordMonitor({
          api: bridgeApi,
          canvasRef: { projectRoot: "/projects/demo", canvasId: "canvas-main" },
          initialModel: modelWithEvent(1, "persisted"),
          recordId: "T-001#B-001::RUN-001"
        })
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(onUpdate).toBeTypeOf("function");
      await act(async () => {
        onUpdate!({
          kind: "closed",
          updateSequence: 1,
          close: {
            reason: "terminal",
            lastSequence: 5,
            recoverable: false,
            message: "Runner record has no live subscription."
          }
        });
      });
      expect(result.current.subscriptionError).toBeNull();

      await act(async () => {
        resolveStart!({
          subscriptionId: "subscription-1",
          updateSequence: 0,
          snapshot: terminalStartSnapshot,
          unsubscribe
        });
        await Promise.resolve();
      });

      expect(result.current.model?.conversation).toEqual(terminalStartSnapshot.conversation);
      expect(result.current.model?.timeline).toEqual(terminalStartSnapshot.timeline);
      expect(result.current.model?.interaction).toEqual(terminalStartSnapshot.interaction);
      expect(result.current.model?.intervention).toEqual(terminalStartSnapshot.intervention);
      expect(result.current.model?.terminal).toBe(true);
      expect(result.current.model?.cursor.terminal).toBe(true);
      expect(result.current.subscriptionError).toBeNull();
      expect(unsubscribe).toHaveBeenCalledOnce();

      await act(async () => {
        onUpdate!({
          kind: "snapshot",
          updateSequence: 1,
          snapshot: modelWithEvent(6, "must remain ignored after close")
        });
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(result.current.model?.cursor.afterSequence).toBe(5);
      expect(subscribeRunnerRecord).toHaveBeenCalledTimes(1);
      expect(result.current.subscriptionError).toBeNull();
    });

    it("does not reconnect for terminal close or after unmount", async () => {
      let onUpdate: ((update: DesktopRunnerRecordSubscriptionUpdate) => void) | null = null;
      const subscribeRunnerRecord = vi.fn<DesktopBridgeApi["subscribeRunnerRecord"]>(
        async (_input, callback) => {
          onUpdate = callback;
          return {
            subscriptionId: "subscription-1",
            updateSequence: 0,
            snapshot: null,
            unsubscribe: vi.fn(async () => undefined)
          };
        }
      );
      const terminalApi = { subscribeRunnerRecord };
      const canvasRef = { projectRoot: "/projects/demo", canvasId: "canvas-main" };
      const rendered = renderHook(() =>
        useRunnerRecordMonitor({
          api: terminalApi,
          canvasRef,
          initialModel: modelWithEvent(1, "live"),
          recordId: "T-001#B-001::RUN-001"
        })
      );
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        onUpdate?.({
          kind: "closed",
          updateSequence: 1,
          close: {
            reason: "terminal",
            lastSequence: 1,
            recoverable: false,
            message: "terminal"
          }
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(subscribeRunnerRecord).toHaveBeenCalledTimes(1);

      const unmountSubscribe = vi.fn<DesktopBridgeApi["subscribeRunnerRecord"]>(
        async (_input, callback) => {
          onUpdate = callback;
          return {
            subscriptionId: "subscription-2",
            updateSequence: 0,
            snapshot: null,
            unsubscribe: vi.fn(async () => undefined)
          };
        }
      );
      const unmountApi = { subscribeRunnerRecord: unmountSubscribe };
      const live = renderHook(() =>
        useRunnerRecordMonitor({
          api: unmountApi,
          canvasRef,
          initialModel: modelWithEvent(1, "live"),
          recordId: "T-001#B-001::RUN-002"
        })
      );
      await act(async () => {
        await Promise.resolve();
      });
      live.unmount();
      await act(async () => {
        onUpdate?.({
          kind: "closed",
          updateSequence: 1,
          close: {
            reason: "subscriber_backpressure",
            lastSequence: 1,
            recoverable: true,
            message: "backpressure"
          }
        });
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(unmountSubscribe).toHaveBeenCalledTimes(1);
      expect(rendered.result.current.subscriptionError).toBeNull();
    });
  });
});
