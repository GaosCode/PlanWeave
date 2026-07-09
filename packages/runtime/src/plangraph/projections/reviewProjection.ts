import type { ExecutionStatus } from "../../taskManager/executionStatus.js";
import type { RuntimeContext } from "../../taskManager/runtimeContext.js";
import type { ReviewGateHint } from "../../types.js";
import { getBlock } from "../../desktop/graph/graphHelpers.js";
import type { PlanGraph } from "../domain/types.js";

export type ReviewProjectionItem = {
  ref: string;
  taskId: string;
  blockId: string;
  title: string;
  status:
    | "planned"
    | "ready"
    | "in_progress"
    | "completed"
    | "needs_changes"
    | "blocked"
    | "diverged";
  dependencyBlockers: string[];
  reviewGate: ReviewGateHint | null;
};

export type ReviewProjection = {
  graphVersion: string;
  items: ReviewProjectionItem[];
  ready: ReviewProjectionItem[];
};

export function buildReviewProjection(input: {
  graphVersion: string;
  runtime: RuntimeContext;
  status: ExecutionStatus;
  planGraph?: PlanGraph;
}): ReviewProjection {
  const claimHintByRef = new Map(input.status.claimHints.map((hint) => [hint.ref, hint]));
  const items = input.status.blocks.flatMap((blockStatus): ReviewProjectionItem[] => {
    if (blockStatus.type !== "review") {
      return [];
    }
    const claimHint = claimHintByRef.get(blockStatus.ref);
    const dependencyBlockers = claimHint
      ? [...claimHint.blockedByTasks, ...claimHint.blockedByBlocks, ...claimHint.blockedByProject]
      : [];
    const title =
      input.planGraph?.blocks.get(blockStatus.ref)?.title ??
      getBlock(input.runtime.graph, blockStatus.ref).title;
    return [
      {
        ref: blockStatus.ref,
        taskId: blockStatus.taskId,
        blockId: blockStatus.blockId,
        title,
        status: blockStatus.status,
        dependencyBlockers,
        reviewGate: claimHint?.reviewGate ?? null
      }
    ];
  });
  return {
    graphVersion: input.graphVersion,
    items,
    ready: items.filter((item) => item.status === "ready" && item.dependencyBlockers.length === 0)
  };
}
