import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withCanvasLock } from "../fs/withCanvasLock.js";
import { isNodeFileNotFoundError } from "../fs/optionalFile.js";
import { writeJsonFile } from "../json.js";
import { loadPackage } from "../package/loadPackage.js";
import { writeState } from "../state.js";
import type {
  ClaimScope,
  ManifestReviewBlock,
  PackageWorkspaceRef,
  PlanPackageManifest,
  RetryReviewResult
} from "../types.js";
import { loadRuntime, loadRuntimeReadonly, refreshDerivedState } from "./runtimeContext.js";
import { clearReviewCompletionReason } from "./resultIndex.js";
import { blockDependenciesCompleted, blockInScope } from "./selectors.js";

type FileSnapshot = { path: string; content: Buffer | null };

export type MaxCycleReviewResetTransaction = {
  refs: string[];
  rollback: () => Promise<void>;
};

async function snapshotFile(path: string): Promise<FileSnapshot> {
  try {
    return { path, content: await readFile(path) };
  } catch (error) {
    if (isNodeFileNotFoundError(error)) {
      return { path, content: null };
    }
    throw error;
  }
}

async function restoreFile(snapshot: FileSnapshot): Promise<void> {
  if (snapshot.content === null) {
    await rm(snapshot.path, { force: true });
    return;
  }
  await mkdir(dirname(snapshot.path), { recursive: true });
  await writeFile(snapshot.path, snapshot.content);
}

export async function resetMaxCycleReviewsForRetryWithRollback(options: {
  projectRoot: PackageWorkspaceRef;
  scope: ClaimScope;
}): Promise<MaxCycleReviewResetTransaction> {
  const { workspace: lockWorkspace } = await loadPackage(options.projectRoot);
  return withCanvasLock(dirname(lockWorkspace.stateFile), async () => {
    const context = await loadRuntime({ projectRoot: options.projectRoot });
    const { workspace, manifest, graph, state } = context;
    const refs: string[] = [];
    const taskIds = new Set<string>();

    for (const ref of graph.blockRefsInManifestOrder) {
      const block = graph.blocksByRef.get(ref);
      const blockState = state.blocks[ref];
      if (
        block?.type !== "review" ||
        blockState?.completionReason !== "max_cycles_reached" ||
        !blockInScope(ref, graph, options.scope)
      ) {
        continue;
      }
      refs.push(ref);
      const taskId = graph.blockTaskByRef.get(ref);
      if (taskId) taskIds.add(taskId);
      state.blocks[ref] = {
        ...blockState,
        status: blockDependenciesCompleted(graph, state, ref) ? "ready" : "planned",
        activeFeedbackId: null,
        pendingFeedbackId: null,
        blockedReason: null,
        completionReason: null,
        passedWorkRevision: null
      };
    }

    const snapshots =
      refs.length > 0
        ? await Promise.all([
            snapshotFile(workspace.stateFile),
            ...[...taskIds].map((taskId) =>
              snapshotFile(join(workspace.resultsDir, taskId, "index.json"))
            )
          ])
        : [];
    let rolledBack = false;
    const rollback = async () => {
      if (rolledBack) {
        return;
      }
      rolledBack = true;
      const restored = await Promise.allSettled(snapshots.map(restoreFile));
      const restoreErrors = restored.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (restoreErrors.length > 0) {
        throw new AggregateError(
          restoreErrors,
          "Review retry reset could not restore its prior runtime state."
        );
      }
    };

    if (refs.length > 0) {
      const resetRefs = new Set(refs);
      try {
        for (const ref of refs) {
          const taskId = graph.blockTaskByRef.get(ref);
          if (taskId) {
            await clearReviewCompletionReason(workspace, taskId, ref);
          }
        }
        for (const [feedbackId, feedback] of Object.entries(state.feedback)) {
          if (resetRefs.has(feedback.sourceReviewBlockRef)) {
            delete state.feedback[feedbackId];
          }
        }
        if (state.currentFeedbackId && !state.feedback[state.currentFeedbackId]) {
          state.currentFeedbackId = null;
        }
        if (state.currentReviewBlockRef && resetRefs.has(state.currentReviewBlockRef)) {
          state.currentReviewBlockRef = null;
        }
        state.currentRefs = state.currentRefs.filter((ref) => !resetRefs.has(ref));
        await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
      } catch (error) {
        try {
          await rollback();
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Review retry reset failed.");
        }
        throw error;
      }
    }

    return { refs, rollback };
  });
}

export async function resetMaxCycleReviewsForRetry(options: {
  projectRoot: PackageWorkspaceRef;
  scope: ClaimScope;
}): Promise<{ refs: string[] }> {
  const transaction = await resetMaxCycleReviewsForRetryWithRollback(options);
  return { refs: transaction.refs };
}

function requireMaxFeedbackCycles(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("retry-review --max-feedback-cycles must be a non-negative integer.");
  }
  return value;
}

function updateReviewBlockMaxCycles(
  manifest: PlanPackageManifest,
  ref: string,
  maxFeedbackCycles: number
): PlanPackageManifest {
  const [taskId, blockId] = ref.split("#");
  let found = false;
  const nodes = manifest.nodes.map((node) => {
    if (node.type !== "task" || node.id !== taskId) {
      return node;
    }
    return {
      ...node,
      blocks: node.blocks.map((block) => {
        if (block.id !== blockId) {
          return block;
        }
        if (block.type !== "review") {
          throw new Error(`Block '${ref}' is not a review block.`);
        }
        found = true;
        return {
          ...block,
          review: {
            ...block.review,
            maxFeedbackCycles
          }
        } satisfies ManifestReviewBlock;
      })
    };
  });
  if (!found) {
    throw new Error(`Review block '${ref}' does not exist.`);
  }
  return { ...manifest, nodes };
}

export async function retryReview(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  maxFeedbackCycles: number;
}): Promise<RetryReviewResult> {
  const maxFeedbackCycles = requireMaxFeedbackCycles(options.maxFeedbackCycles);
  const context = await loadRuntimeReadonly({ projectRoot: options.projectRoot });
  const { workspace, manifest, graph } = context;
  const block = graph.blocksByRef.get(options.ref);
  if (!block) {
    throw new Error(`Block '${options.ref}' does not exist.`);
  }
  if (block.type !== "review") {
    throw new Error(`Block '${options.ref}' is not a review block.`);
  }

  await writeJsonFile(
    workspace.manifestFile,
    updateReviewBlockMaxCycles(manifest, options.ref, maxFeedbackCycles)
  );
  const reset = await resetMaxCycleReviewsForRetry({
    projectRoot: workspace,
    scope: { kind: "block", blockRef: options.ref }
  });
  const updated = await loadRuntimeReadonly({ projectRoot: workspace });
  const status = updated.state.blocks[options.ref]?.status ?? "planned";
  return {
    ref: options.ref,
    status,
    maxFeedbackCycles,
    reset: reset.refs.includes(options.ref)
  };
}
