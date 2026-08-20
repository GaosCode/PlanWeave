import {
  canvasRuntimeStatusProjectionSchema,
  type CanvasRuntimeStatusProjection
} from "@planweave-ai/collaboration-protocol/canvas/status";
import { type CompleteContentVersion } from "@planweave-ai/collaboration-protocol/content/version";
import { decodeCanvasReplicaDocument, projectCanvasReplicaDocument } from "@planweave-ai/runtime";

/**
 * Projects the collaborator runtime-status surface from an authoritative content
 * version when this host has no readable local package. Dispatchability stays
 * fail-closed because claim readiness never leaves the owner Runtime.
 */
export function projectCanvasRuntimeStatusFromContent(input: {
  content: CompleteContentVersion;
  scope: CanvasRuntimeStatusProjection["scope"];
  capturedAt: string;
}): CanvasRuntimeStatusProjection {
  const projected = projectCanvasReplicaDocument(decodeCanvasReplicaDocument(input.content));
  return canvasRuntimeStatusProjectionSchema.parse({
    schemaVersion: "canvas-runtime-status/v2",
    scope: input.scope,
    packageFingerprint: projected.packageFingerprint,
    capturedAt: input.capturedAt,
    tasks: projected.tasks.map((task) => ({
      taskId: task.taskId,
      status: "planned",
      openFeedbackCount: 0
    })),
    blocks: projected.tasks.flatMap((task) =>
      task.blocks.map((block) => ({
        ref: block.ref,
        status: "planned",
        completionReason: null,
        blockedReason: null,
        divergenceReason: null,
        dispatchable: false
      }))
    )
  });
}
