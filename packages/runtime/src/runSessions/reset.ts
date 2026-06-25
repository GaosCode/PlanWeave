import { loadPackage } from "../package/loadPackage.js";
import { createEmptyState, ensureStateForManifest, readState, writeState } from "../state.js";
import type { BlockState, RuntimeState } from "../types.js";
import { appendRunSessionEvent, assertValidRunSessionId, updateRunSession } from "./repository.js";
import type { ResetRuntimeStateOptions, ResetRuntimeStateResult, RunSessionResetSummary } from "./types.js";

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function runtimeBlocks(state: RuntimeState): Record<string, BlockState> {
  return state.blocks && typeof state.blocks === "object" ? state.blocks : {};
}

function inProgressRefs(blocks: Record<string, BlockState>): string[] {
  return Object.entries(blocks)
    .filter(([, block]) => block.status === "in_progress")
    .map(([ref]) => ref)
    .sort();
}

function activeWorkMessage(summary: RunSessionResetSummary): string {
  const parts = [
    summary.previousCurrentRefs.length > 0 ? `currentRefs=${summary.previousCurrentRefs.join(",")}` : null,
    summary.previousCurrentFeedbackId ? `currentFeedbackId=${summary.previousCurrentFeedbackId}` : null,
    summary.previousCurrentReviewBlockRef ? `currentReviewBlockRef=${summary.previousCurrentReviewBlockRef}` : null,
    summary.previousInProgressRefs.length > 0 ? `inProgress=${summary.previousInProgressRefs.join(",")}` : null
  ].filter((part): part is string => part !== null);
  return `Cannot reset runtime state while active work exists${parts.length > 0 ? ` (${parts.join("; ")})` : ""}.`;
}

export async function resetRuntimeState(options: ResetRuntimeStateOptions): Promise<ResetRuntimeStateResult> {
  const { workspace, manifest } = await loadPackage(options.projectRoot);
  const sessionId = options.session?.sessionId ?? options.sessionId ?? null;
  if (sessionId) {
    assertValidRunSessionId(sessionId);
  }
  const previousState = await readState(workspace.stateFile);
  const summary: RunSessionResetSummary = {
    performed: true,
    statePath: workspace.stateFile,
    previousCurrentRefs: stringArray(previousState.currentRefs),
    previousCurrentFeedbackId: nullableString(previousState.currentFeedbackId),
    previousCurrentReviewBlockRef: nullableString(previousState.currentReviewBlockRef),
    previousInProgressRefs: inProgressRefs(runtimeBlocks(previousState)),
    forced: options.force === true
  };
  const hasActiveWork =
    summary.previousCurrentRefs.length > 0 ||
    summary.previousCurrentFeedbackId !== null ||
    summary.previousCurrentReviewBlockRef !== null ||
    summary.previousInProgressRefs.length > 0;

  if (hasActiveWork && !summary.forced) {
    throw new Error(activeWorkMessage(summary));
  }

  await writeState(workspace.stateFile, ensureStateForManifest(manifest, createEmptyState()));

  if (sessionId) {
    await appendRunSessionEvent(workspace, sessionId, "reset_completed", {
      phase: "resetting",
      reset: summary
    });
    await updateRunSession(workspace, sessionId, { phase: "resetting", reset: summary });
  }

  return {
    statePath: workspace.stateFile,
    forced: summary.forced,
    previousCurrentRefs: summary.previousCurrentRefs,
    previousCurrentFeedbackId: summary.previousCurrentFeedbackId,
    previousCurrentReviewBlockRef: summary.previousCurrentReviewBlockRef,
    previousInProgressRefs: summary.previousInProgressRefs,
    sessionId
  };
}
