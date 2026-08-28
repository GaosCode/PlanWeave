import {
  claimBlock,
  getAutoRunRetrospective,
  getAutoRunState,
  getLatestAutoRunRetrospective,
  getLatestAutoRunSummary,
  getLatestAutoRunSummaryWithDiagnostics,
  markBlockBlocked,
  pauseAutoRun,
  previewClaimNext,
  resetDesktopRuntimeState,
  resumeAutoRun,
  startAutoRun,
  stopAutoRun,
  unblockBlock,
  desktopAutoRunOptionsSchema,
  desktopAutoRunScopeSchema,
  desktopAutoRunStepLimitSchema,
  desktopCanvasReferenceSchema,
  desktopRuntimeResetOptionsSchema
} from "@planweave-ai/runtime";
import { resolveDesktopCanvasReference } from "./runtimeBridgeCanvasReference.js";
import type { RuntimeBridgeHandlerMap } from "./runtimeBridgeHandlerTypes.js";

export const runtimeBridgeAutoRunHandlers = {
  startAutoRun: async (_event, ref, scope, stepLimit, options) => {
    const parsedRef = desktopCanvasReferenceSchema.parse(ref);
    return startAutoRun(
      parsedRef.projectRoot,
      parsedRef.canvasId,
      desktopAutoRunScopeSchema.parse(scope),
      stepLimit === undefined ? undefined : desktopAutoRunStepLimitSchema.parse(stepLimit),
      options === undefined ? undefined : desktopAutoRunOptionsSchema.parse(options)
    );
  },
  previewClaimNext: async (_event, ref, scope, options) => {
    const parsedRef = desktopCanvasReferenceSchema.parse(ref);
    return previewClaimNext(
      parsedRef.projectRoot,
      parsedRef.canvasId,
      desktopAutoRunScopeSchema.parse(scope),
      options === undefined ? undefined : { parallel: options.parallel }
    );
  },
  resetRuntimeState: async (_event, ref, options) => {
    const parsedRef = desktopCanvasReferenceSchema.parse(ref);
    return resetDesktopRuntimeState(
      parsedRef.projectRoot,
      parsedRef.canvasId,
      options === undefined ? undefined : desktopRuntimeResetOptionsSchema.parse(options)
    );
  },
  unblockBlock: async (_event, ref, blockRef, reason) => {
    await unblockBlock({
      projectRoot: await resolveDesktopCanvasReference(ref),
      ref: blockRef,
      reason,
      allowAlreadyCompleted: true
    });
  },
  markBlockedBlock: async (_event, ref, blockRef, reason) => {
    await markBlockBlocked({
      projectRoot: await resolveDesktopCanvasReference(ref),
      ref: blockRef,
      reason
    });
  },
  dispatchBlock: async (_event, ref, blockRef) =>
    claimBlock({
      projectRoot: await resolveDesktopCanvasReference(ref),
      ref: blockRef,
      dispatch: true
    }),
  pauseAutoRun: (_event, runId) => pauseAutoRun(runId),
  resumeAutoRun: (_event, runId) => resumeAutoRun(runId),
  stopAutoRun: (_event, runId) => stopAutoRun(runId),
  getAutoRunState: (_event, runId) => getAutoRunState(runId),
  getLatestAutoRunSummary: (_event, ref) => getLatestAutoRunSummary(ref.projectRoot, ref.canvasId),
  getLatestAutoRunSummaryWithDiagnostics: (_event, ref) =>
    getLatestAutoRunSummaryWithDiagnostics(ref.projectRoot, ref.canvasId),
  getAutoRunRetrospective: (_event, ref, runId) =>
    getAutoRunRetrospective(ref.projectRoot, ref.canvasId, runId),
  getLatestAutoRunRetrospective: (_event, ref) =>
    getLatestAutoRunRetrospective(ref.projectRoot, ref.canvasId)
} satisfies Partial<RuntimeBridgeHandlerMap>;
