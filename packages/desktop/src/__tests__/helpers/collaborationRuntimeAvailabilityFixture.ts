import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol";

export function statusProjection(input: {
  taskStatus: "ready" | "in_progress" | "implemented";
  blocks: Array<{
    ref: string;
    status: "ready" | "planned" | "completed" | "in_progress";
    dispatchable?: boolean;
  }>;
}): CanvasRuntimeStatusProjection {
  return {
    schemaVersion: "canvas-runtime-status/v2",
    scope: { workspaceId: "workspace-1", projectId: "project-server", canvasId: "canvas-main" },
    packageFingerprint: `pkg-${"a".repeat(64)}`,
    capturedAt: "2026-08-05T00:00:00.000Z",
    tasks: [{ taskId: "T-001", status: input.taskStatus, openFeedbackCount: 0 }],
    blocks: input.blocks.map((block) => ({
      ref: block.ref,
      status: block.status,
      completionReason: block.status === "completed" ? "passed" : null,
      blockedReason: null,
      divergenceReason: null,
      dispatchable: block.dispatchable ?? block.status === "ready"
    }))
  };
}

export function availableRuntime(
  status = statusProjection({
    taskStatus: "ready",
    blocks: [{ ref: "T-001#B-001", status: "ready" }]
  })
) {
  return {
    schemaVersion: "canvas-runtime-availability/v1" as const,
    kind: "available" as const,
    status,
    sourceRevision: "source-revision-1",
    graphFingerprint: `pkg-${"b".repeat(64)}`
  };
}
