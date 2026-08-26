import {
  canvasRuntimeStatusProjectionSchema,
  type CanvasRuntimeStatusProjection
} from "@planweave-ai/collaboration-protocol/canvas/status";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { createEmptyState, ensureStateForManifest } from "../state.js";
import { buildClaimReadiness } from "../taskManager/claimReadiness.js";
import { validateAuthoritativeCanvasContent } from "./contentVersionValidation.js";

/** Builds the deterministic empty Runtime projection for a Server-authoritative reset. */
export function buildResetCanvasRuntimeStatusProjection(input: {
  content: unknown;
  scope: CanvasRuntimeStatusProjection["scope"];
  packageFingerprint: string;
  capturedAt?: string;
}): CanvasRuntimeStatusProjection {
  const { manifest } = validateAuthoritativeCanvasContent(input.content);
  const graph = compileTaskGraph(manifest);
  const state = ensureStateForManifest(manifest, createEmptyState());
  const claimHintByRef = new Map(
    buildClaimReadiness({ graph, manifest, state }).claimHints.map((hint) => [hint.ref, hint])
  );
  return canvasRuntimeStatusProjectionSchema.parse({
    schemaVersion: "canvas-runtime-status/v2",
    scope: input.scope,
    packageFingerprint: input.packageFingerprint,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    tasks: graph.taskNodesInManifestOrder.map((taskId) => {
      const task = state.tasks[taskId];
      if (!task) throw new Error(`runtime_task_state_missing:${taskId}`);
      return {
        taskId,
        status: task.status,
        openFeedbackCount: task.openFeedbackCount
      };
    }),
    blocks: graph.blockRefsInManifestOrder.map((ref) => {
      const block = state.blocks[ref];
      const claimHint = claimHintByRef.get(ref);
      if (!block) throw new Error(`runtime_block_state_missing:${ref}`);
      if (!claimHint) throw new Error(`runtime_claim_hint_missing:${ref}`);
      return {
        ref,
        status: block.status,
        completionReason: block.completionReason ?? null,
        blockedReason: block.blockedReason ?? null,
        divergenceReason: block.divergenceReason ?? null,
        dispatchable: claimHint.dispatchable
      };
    })
  });
}
