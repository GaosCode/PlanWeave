/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type { DesktopBridgeApi, RunnerRecordReadModel } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
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
      onUpdate!({ updateSequence: 1, snapshot: modelWithEvent(2, "live") });
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
});
