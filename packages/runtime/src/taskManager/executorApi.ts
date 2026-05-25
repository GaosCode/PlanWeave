import { basename, dirname, join } from "node:path";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import type { BlockExplanation, CurrentWork, CurrentWorkItem, ManifestBlock, PackageWorkspaceRef } from "../types.js";
import { getExecutionStatus } from "./executionStatus.js";
import { loadRuntime } from "./runtimeContext.js";
import { getBlock, isActiveFeedbackStatus } from "./selectors.js";

function submitCommand(ref: string, block: ManifestBlock): string {
  if (block.type === "review") {
    return `planweave submit-review ${ref} --result <review-result.json>`;
  }
  return `planweave submit-result ${ref} --report <report.md>`;
}

function reportPath(block: ManifestBlock): string {
  if (block.type === "review") {
    return "<review-result.json>";
  }
  return "<report.md>";
}

function currentItem(ref: string, block: ManifestBlock, packageDir: string): CurrentWorkItem {
  const { taskId, blockId } = parseBlockRef(ref);
  return {
    kind: "block",
    ref,
    taskId,
    blockId,
    blockType: block.type,
    promptPath: join(packageDir, block.prompt),
    reportPath: reportPath(block),
    submitCommand: submitCommand(ref, block)
  };
}

function canvasIdForWorkspace(workspaceRoot: string): string | null {
  return basename(dirname(workspaceRoot)) === "canvases" ? basename(workspaceRoot) : null;
}

export async function explainBlock(options: { projectRoot: PackageWorkspaceRef; ref: string }): Promise<BlockExplanation> {
  const context = await loadRuntime(options);
  const block = getBlock(context.graph, options.ref);
  const status = await getExecutionStatus(options);
  const hint = status.claimHints.find((candidate) => candidate.ref === options.ref);
  if (!hint) {
    throw new Error(`Block '${options.ref}' does not exist.`);
  }
  return {
    ...hint,
    promptPath: join(context.workspace.packageDir, block.prompt),
    submitCommand: submitCommand(options.ref, block)
  };
}

export async function getCurrentWork(options: { projectRoot: PackageWorkspaceRef }): Promise<CurrentWork> {
  const context = await loadRuntime(options);
  const items = context.state.currentRefs.map((ref) => currentItem(ref, getBlock(context.graph, ref), context.workspace.packageDir));
  const activeFeedbackId =
    context.state.currentFeedbackId && isActiveFeedbackStatus(context.state.feedback[context.state.currentFeedbackId]?.status)
      ? context.state.currentFeedbackId
      : null;
  if (activeFeedbackId) {
    const feedback = context.state.feedback[activeFeedbackId];
    const taskId = feedback ? context.graph.blockTaskByRef.get(feedback.sourceReviewBlockRef) : null;
    if (feedback && taskId) {
      items.push({
        kind: "feedback",
        ref: activeFeedbackId,
        feedbackId: activeFeedbackId,
        sourceReviewBlockRef: feedback.sourceReviewBlockRef,
        taskId,
        promptPath: join(context.workspace.resultsDir, taskId, "feedback", activeFeedbackId, "feedback.json"),
        reportPath: "<feedback-report.md>",
        submitCommand: "planweave submit-feedback --report <feedback-report.md>"
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
      canvasId: canvasIdForWorkspace(context.workspace.workspaceRoot),
      taskIds
    },
    items,
    blockingReason
  };
}
