import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withCanvasStorageMutation } from "../package/withCanvasStorageMutation.js";
import { isNodeFileNotFoundError } from "../fs/optionalFile.js";
import { commitPlanPackageGraphMutation } from "../graph/editGraph.js";
import { buildPlanPackageBlockFieldEditMutation } from "../graph/fieldEditMutation.js";
import { loadPackage, resolvePackageWorkspace } from "../package/loadPackage.js";
import { writeState } from "../state.js";
import type { ClaimScope, PackageWorkspaceRef, RetryReviewResult } from "../types.js";
import {
  loadRuntime,
  loadRuntimeReadonly,
  refreshDerivedState,
  type RuntimeContext
} from "./runtimeContext.js";
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

async function resetMaxCycleReviewsUnderCanvasLock(
  context: RuntimeContext,
  scope: ClaimScope
): Promise<MaxCycleReviewResetTransaction> {
  const { workspace, manifest, graph, state } = context;
  const refs: string[] = [];
  const taskIds = new Set<string>();

  for (const ref of graph.blockRefsInManifestOrder) {
    const block = graph.blocksByRef.get(ref);
    const blockState = state.blocks[ref];
    if (
      block?.type !== "review" ||
      blockState?.completionReason !== "max_cycles_reached" ||
      !blockInScope(ref, graph, scope)
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
}

export async function resetMaxCycleReviewsForRetryWithRollback(options: {
  projectRoot: PackageWorkspaceRef;
  scope: ClaimScope;
}): Promise<MaxCycleReviewResetTransaction> {
  const { workspace } = await loadPackage(options.projectRoot);
  return withCanvasStorageMutation(workspace, async () =>
    resetMaxCycleReviewsUnderCanvasLock(
      await loadRuntime({ projectRoot: workspace }),
      options.scope
    )
  );
}

export async function resetMaxCycleReviewsForRetry(options: {
  projectRoot: PackageWorkspaceRef;
  scope: ClaimScope;
}): Promise<{ refs: string[] }> {
  const transaction = await resetMaxCycleReviewsForRetryWithRollback(options);
  return { refs: transaction.refs };
}

export async function retryReview(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  maxFeedbackCycles: number;
}): Promise<RetryReviewResult> {
  if (options.maxFeedbackCycles === undefined) {
    throw new Error("retry-review requires maxFeedbackCycles.");
  }
  const workspace = await resolvePackageWorkspace(options.projectRoot);
  return withCanvasStorageMutation(workspace, async () => {
    const context = await loadRuntimeReadonly({ projectRoot: workspace });
    const block = context.graph.blocksByRef.get(options.ref);
    if (!block) throw new Error(`Block '${options.ref}' does not exist.`);
    if (block.type !== "review") throw new Error(`Block '${options.ref}' is not a review block.`);
    const mutation = buildPlanPackageBlockFieldEditMutation(context.manifest, {
      blockRef: options.ref,
      maxFeedbackCycles: options.maxFeedbackCycles
    });
    const taskId = context.graph.blockTaskByRef.get(options.ref);
    if (!taskId) throw new Error(`Task for review block '${options.ref}' does not exist.`);
    const snapshots = await Promise.all([
      snapshotFile(workspace.manifestFile),
      snapshotFile(workspace.stateFile),
      snapshotFile(join(workspace.resultsDir, taskId, "index.json"))
    ]);
    try {
      const edit = await commitPlanPackageGraphMutation({ projectRoot: workspace, mutation });
      if (!edit.ok) throw new Error(edit.diagnostics.map((item) => item.message).join("\n"));
      const reset = await resetMaxCycleReviewsUnderCanvasLock(
        await loadRuntimeReadonly({ projectRoot: workspace }),
        { kind: "block", blockRef: options.ref }
      );
      const updated = await loadRuntimeReadonly({ projectRoot: workspace });
      const blockState = updated.state.blocks[options.ref];
      if (!blockState)
        throw new Error(`Runtime state for review block '${options.ref}' does not exist.`);
      return {
        ref: options.ref,
        status: blockState.status,
        maxFeedbackCycles: options.maxFeedbackCycles,
        reset: reset.refs.includes(options.ref)
      };
    } catch (error) {
      const restored = await Promise.allSettled(snapshots.map(restoreFile));
      const restoreErrors = restored.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (restoreErrors.length > 0) {
        throw new AggregateError(
          [error, ...restoreErrors],
          "Review retry failed and could not restore its prior package/runtime files."
        );
      }
      throw error;
    }
  });
}
