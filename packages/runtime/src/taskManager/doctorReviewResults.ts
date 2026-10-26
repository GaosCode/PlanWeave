import { join } from "node:path";
import { optionalStat } from "../fs/optionalFile.js";
import { requireMapValue } from "../graph/requireMapValue.js";
import type {
  CompiledExecutionGraph,
  DoctorIssue,
  ProjectWorkspace,
  RuntimeState,
  TaskResultIndex
} from "../types.js";
import {
  readReviewAttemptMetadataFile,
  readReviewResultArtifactFile
} from "./reviewAttemptMetadata.js";

export async function diagnoseReviewResults(options: {
  workspace: ProjectWorkspace;
  graph: CompiledExecutionGraph;
  state: RuntimeState;
  taskId: string;
  index: TaskResultIndex;
}): Promise<DoctorIssue[]> {
  const { workspace, graph, state, taskId, index } = options;
  const issues: DoctorIssue[] = [];
  const refs = requireMapValue(graph.blocksByTask, taskId, "blocksByTask");
  const reviewRefs = new Set(refs.filter((ref) => graph.blocksByRef.get(ref)?.type === "review"));
  const indexPath = join(workspace.resultsDir, taskId, "index.json");
  for (const ref of Object.keys(index.latestReviewAttemptByBlock ?? {})) {
    if (!reviewRefs.has(ref)) {
      issues.push({
        code: "result_index_block_type_mismatch",
        ref,
        taskId,
        path: indexPath,
        repaired: false,
        message: `Review attempt index contains non-review or unknown block '${ref}'.`
      });
    }
  }
  for (const ref of reviewRefs) {
    const blockState = state.blocks[ref];
    const stateAttemptId = blockState?.latestReviewAttemptId ?? null;
    const indexAttemptId = index.latestReviewAttemptByBlock?.[ref] ?? null;
    if (stateAttemptId !== indexAttemptId) {
      issues.push({
        code: "review_index_state_mismatch",
        ref,
        taskId,
        path: indexPath,
        stateReviewAttemptId: stateAttemptId,
        indexReviewAttemptId: indexAttemptId,
        repaired: false,
        message: `Review index points '${ref}' to '${indexAttemptId ?? "none"}', but state has '${stateAttemptId ?? "none"}'.`
      });
    }
    const completedReceipt = blockState?.remoteOperationReceipt;
    const receiptAttemptId =
      completedReceipt?.outcome === "completed" && completedReceipt.blockType === "review"
        ? completedReceipt.runId
        : null;
    const attemptIds = new Set([stateAttemptId, indexAttemptId, receiptAttemptId]);
    for (const attemptId of attemptIds) {
      if (!attemptId) {
        continue;
      }
      const blockId = requireMapValue(graph.blocksByRef, ref, "blocksByRef").id;
      const attemptDir = join(
        workspace.resultsDir,
        taskId,
        "reviews",
        blockId,
        "attempts",
        attemptId
      );
      const metadataPath = join(attemptDir, "metadata.json");
      const resultPath = join(attemptDir, "review-result.json");
      let matches = false;
      if ((await optionalStat(metadataPath)) && (await optionalStat(resultPath))) {
        const metadata = await readReviewAttemptMetadataFile(metadataPath);
        const result = await readReviewResultArtifactFile(resultPath);
        matches =
          metadata.reviewBlockRef === ref &&
          metadata.attemptId === attemptId &&
          result.reviewBlockRef === ref &&
          result.taskId === taskId;
      }
      if (!matches) {
        issues.push({
          code: "review_result_missing",
          ref,
          taskId,
          path: attemptDir,
          repaired: false,
          message: `Review attempt '${attemptId}' for '${ref}' is missing its matching metadata or result.`
        });
      }
    }
  }
  return issues;
}
