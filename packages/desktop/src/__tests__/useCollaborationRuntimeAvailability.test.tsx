// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { graph as graphFixture } from "./helpers/graphFixtures";
import {
  COLLABORATION_RUNTIME_AVAILABILITY_POLL_MS,
  mergeAvailableCollaborationRuntimeStatus,
  useCollaborationRuntimeAvailability
} from "../renderer/hooks/useCollaborationRuntimeAvailability";

afterEach(() => vi.useRealTimers());

const scope = { workspaceId: "w", projectId: "remote-project", canvasId: "default" };
const graphWithBlock = {
  ...graphFixture,
  tasks: graphFixture.tasks.map((task) =>
    task.taskId === "T-ALPHA"
      ? {
          ...task,
          blocks: [
            {
              ref: "T-ALPHA#B-001",
              blockId: "B-001",
              type: "implementation" as const,
              title: "Alpha implementation",
              status: "ready" as const,
              executor: null,
              requiredCapabilities: [],
              promptMissing: false,
              exceptionReason: null,
              dispatchable: true,
              remoteExecution: null
            }
          ],
          blockPreview: []
        }
      : task
  )
};
const status = {
  schemaVersion: "canvas-runtime-status/v2" as const,
  scope,
  packageFingerprint: graphFixture.packageFingerprint,
  capturedAt: "2026-08-20T00:00:00.000Z",
  tasks: [
    { taskId: "T-ALPHA", status: "implemented" as const, openFeedbackCount: 0 },
    { taskId: "T-BETA", status: "ready" as const, openFeedbackCount: 0 }
  ],
  blocks: [
    {
      ref: "T-ALPHA#B-001",
      status: "completed" as const,
      completionReason: "submitted" as const,
      blockedReason: null,
      divergenceReason: null,
      dispatchable: true
    }
  ]
};
const available = {
  schemaVersion: "canvas-runtime-availability/v1" as const,
  kind: "available" as const,
  status,
  sourceRevision: "src-revision-001",
  graphFingerprint: `graph-${"a".repeat(64)}`
};

function api(read = vi.fn().mockResolvedValue(available)) {
  return {
    readCollaborationCanvasRuntimeAvailability: read,
    resolveCollaborationCanvasScope: vi.fn().mockResolvedValue(scope)
  };
}

const defaultApi = api();

function hookInput(
  override: Partial<Parameters<typeof useCollaborationRuntimeAvailability>[0]> = {}
) {
  return {
    enabled: true,
    sessionConnected: true,
    profileId: "profile-1",
    activeProjectId: "remote-project",
    localProjectId: "local-replica",
    localCanvasId: "default",
    graph: graphWithBlock,
    api: defaultApi,
    ...override
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("collaboration runtime availability", () => {
  it("keeps local runtime behavior not applicable without calling collaboration APIs", () => {
    const bridge = api();
    const { result } = renderHook(() =>
      useCollaborationRuntimeAvailability(
        hookInput({ api: bridge, enabled: false, sessionConnected: false })
      )
    );

    expect(bridge.resolveCollaborationCanvasScope).not.toHaveBeenCalled();
    expect(bridge.readCollaborationCanvasRuntimeAvailability).not.toHaveBeenCalled();
    expect(result.current.availability).toEqual({ kind: "not_applicable" });
    expect(result.current.graph).toBe(graphWithBlock);
    expect(result.current.graph?.tasks[0]?.blocks[0]?.dispatchable).toBe(true);
  });

  it("treats server disconnect as distinct and never reads cached availability", () => {
    const bridge = api();
    const { result } = renderHook(() =>
      useCollaborationRuntimeAvailability(hookInput({ api: bridge, sessionConnected: false }))
    );

    expect(bridge.resolveCollaborationCanvasScope).not.toHaveBeenCalled();
    expect(bridge.readCollaborationCanvasRuntimeAvailability).not.toHaveBeenCalled();
    expect(result.current.availability).toEqual({ kind: "server_disconnected" });
    expect(result.current.graph?.tasks[0]?.status).toBe("ready");
    expect(result.current.graph?.tasks[0]?.blocks[0]?.dispatchable).toBe(false);
  });

  it.each([
    "runtime_not_attached",
    "host_offline",
    "content_out_of_sync"
  ] as const)("maps unavailable reason %s without changing graph statuses", async (reason) => {
    const bridge = api(
      vi.fn().mockResolvedValue({
        schemaVersion: "canvas-runtime-availability/v1",
        kind: "unavailable",
        reason
      })
    );
    const { result } = renderHook(() =>
      useCollaborationRuntimeAvailability(hookInput({ api: bridge }))
    );
    await settle();

    expect(result.current.availability).toEqual({ kind: "unavailable", reason });
    expect(result.current.graph?.tasks[0]?.status).toBe("ready");
    expect(result.current.graph?.tasks[0]?.blocks[0]?.status).toBe("ready");
    expect(result.current.graph?.tasks[0]?.blocks[0]?.dispatchable).toBe(false);
  });

  it("overlays exact available status and allows runtime dispatchability", async () => {
    const { result } = renderHook(() => useCollaborationRuntimeAvailability(hookInput()));
    await settle();

    expect(result.current.availability).toEqual({ kind: "available" });
    expect(result.current.graph?.tasks[0]?.status).toBe("implemented");
    expect(result.current.graph?.tasks[0]?.blocks[0]?.status).toBe("completed");
    expect(result.current.graph?.tasks[0]?.blocks[0]?.dispatchable).toBe(true);
  });

  it("fails closed on identity mismatch without applying the status overlay", () => {
    const merged = mergeAvailableCollaborationRuntimeStatus(graphWithBlock, status, {
      ...scope,
      canvasId: "other"
    });
    expect(merged.tasks[0]?.status).toBe("ready");
    expect(merged.tasks[0]?.blocks[0]?.dispatchable).toBe(false);
  });

  it("clears an available overlay when availability becomes unavailable", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(available).mockResolvedValueOnce({
      schemaVersion: "canvas-runtime-availability/v1",
      kind: "unavailable",
      reason: "host_offline"
    });
    const bridge = api(read);
    const { result } = renderHook(() =>
      useCollaborationRuntimeAvailability(hookInput({ api: bridge }))
    );
    await settle();
    expect(result.current.graph?.tasks[0]?.status).toBe("implemented");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(COLLABORATION_RUNTIME_AVAILABILITY_POLL_MS);
    });
    expect(result.current.availability).toEqual({ kind: "unavailable", reason: "host_offline" });
    expect(result.current.graph?.tasks[0]?.status).toBe("ready");
    expect(result.current.graph?.tasks[0]?.blocks[0]?.status).toBe("ready");
  });

  it("reports transport errors without fabricating runtime unavailable", async () => {
    const bridge = api(vi.fn().mockRejectedValue(new Error("network_down")));
    const { result } = renderHook(() =>
      useCollaborationRuntimeAvailability(hookInput({ api: bridge }))
    );
    await settle();

    expect(result.current.availability).toEqual({ kind: "error", message: "network_down" });
    expect(result.current.graph?.tasks[0]?.status).toBe("ready");
    expect(result.current.graph?.tasks[0]?.blocks[0]?.dispatchable).toBe(false);
  });
});
