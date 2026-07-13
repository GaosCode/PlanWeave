/* @vitest-environment jsdom */

import { renderHook, waitFor } from "@testing-library/react";
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
});
