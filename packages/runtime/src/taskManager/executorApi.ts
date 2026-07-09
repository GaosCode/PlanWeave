import { join } from "node:path";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import type {
  BlockExplanation,
  CurrentWork,
  CurrentWorkItem,
  ManifestBlock,
  PackageWorkspaceRef
} from "../types.js";
import { canvasCommandFlag, commandCanvasIdForWorkspace } from "./canvasCommandScope.js";
import { getExecutionStatus } from "./executionStatus.js";
import { loadRuntimeReadonly } from "./runtimeContext.js";
import {
  effectiveBlockExecutor,
  effectiveFeedbackExecutor,
  getBlock,
  isActiveFeedbackStatus
} from "./selectors.js";

function submitCommand(ref: string, block: ManifestBlock, canvasId: string | null = null): string {
  if (block.type === "review") {
    return `planweave submit-review${canvasCommandFlag(canvasId)} ${ref} --result <review-result.json>`;
  }
  return `planweave submit-result${canvasCommandFlag(canvasId)} ${ref} --report <report.md>`;
}

function reportPath(block: ManifestBlock): string {
  if (block.type === "review") {
    return "<review-result.json>";
  }
  return "<report.md>";
}

function currentItem(
  ref: string,
  block: ManifestBlock,
  packageDir: string,
  canvasId: string | null,
  effectiveExecutor: string
): CurrentWorkItem {
  const { taskId, blockId } = parseBlockRef(ref);
  return {
    kind: "block",
    ref,
    taskId,
    blockId,
    blockType: block.type,
    effectiveExecutor,
    promptPath: join(packageDir, block.prompt),
    reportPath: reportPath(block),
    submitCommand: submitCommand(ref, block, canvasId)
  };
}

export async function explainBlock(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
}): Promise<BlockExplanation> {
  const context = await loadRuntimeReadonly(options);
  const block = getBlock(context.graph, options.ref);
  const status = await getExecutionStatus(options);
  const hint = status.claimHints.find((candidate) => candidate.ref === options.ref);
  if (!hint) {
    throw new Error(`Block '${options.ref}' does not exist.`);
  }
  return {
    ...hint,
    promptPath: join(context.workspace.packageDir, block.prompt),
    submitCommand: submitCommand(
      options.ref,
      block,
      await commandCanvasIdForWorkspace(context.workspace)
    )
  };
}

export async function getCurrentWork(options: {
  projectRoot: PackageWorkspaceRef;
}): Promise<CurrentWork> {
  const context = await loadRuntimeReadonly(options);
  const canvasId = await commandCanvasIdForWorkspace(context.workspace);
  const defaultExecutor = context.manifest.execution.defaultExecutor;
  const items = context.state.currentRefs.map((ref) =>
    currentItem(
      ref,
      getBlock(context.graph, ref),
      context.workspace.packageDir,
      canvasId,
      effectiveBlockExecutor(context.graph, ref, defaultExecutor)
    )
  );
  const activeFeedbackId =
    context.state.currentFeedbackId &&
    isActiveFeedbackStatus(context.state.feedback[context.state.currentFeedbackId]?.status)
      ? context.state.currentFeedbackId
      : null;
  if (activeFeedbackId) {
    const feedback = context.state.feedback[activeFeedbackId];
    const taskId = feedback
      ? context.graph.blockTaskByRef.get(feedback.sourceReviewBlockRef)
      : null;
    if (feedback && taskId) {
      items.push({
        kind: "feedback",
        ref: activeFeedbackId,
        feedbackId: activeFeedbackId,
        sourceReviewBlockRef: feedback.sourceReviewBlockRef,
        taskId,
        effectiveExecutor: effectiveFeedbackExecutor(
          context.graph,
          feedback.sourceReviewBlockRef,
          defaultExecutor
        ),
        promptPath: join(
          context.workspace.resultsDir,
          taskId,
          "feedback",
          activeFeedbackId,
          "feedback.json"
        ),
        reportPath: "<feedback-report.md>",
        submitCommand: `planweave submit-feedback${canvasCommandFlag(canvasId)} --report <feedback-report.md>`
      });
    }
  }
  const taskIds = Array.from(new Set(items.map((item) => item.taskId)));
  const blockingReason =
    items.length > 0 || activeFeedbackId
      ? null
      : "No current claim. Run `planweave claim-next`, `planweave claim <ref>`, or `planweave status`.";
  return {
    currentRefs: context.state.currentRefs,
    currentFeedbackId: activeFeedbackId,
    currentReviewBlockRef: context.state.currentReviewBlockRef,
    owner: {
      projectRoot: context.workspace.rootPath,
      canvasId,
      taskIds
    },
    items,
    blockingReason
  };
}
