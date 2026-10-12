import { withExecutionStateLock } from "./executionStateBoundary.js";
import { loadPackage } from "../package/loadPackage.js";
import { writeState } from "../state.js";
import type { ClaimResult, ExecutionGraphSession, PackageWorkspaceRef } from "../types.js";
import { projectBlockerReason } from "./claimReadinessRules.js";
import { createProjectGraphClaimGuard } from "./projectGraphClaimGuard.js";
import { loadRuntime, refreshDerivedState } from "./runtimeContext.js";
import {
  canDispatchImplementationBlock,
  claimedBlockState,
  claimResultForBlock,
  validateClaimScope
} from "./selectors.js";

function withCurrentRef(currentRefs: string[], ref: string): string[] {
  return currentRefs.includes(ref) ? currentRefs : [...currentRefs, ref];
}

export async function claimDispatchedBlock(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  session?: ExecutionGraphSession;
  executionSnapshot?: import("../package/packageExecutionSnapshot.js").PackageExecutionSnapshot;
}): Promise<ClaimResult> {
  const { workspace } = options.executionSnapshot ?? (await loadPackage(options.projectRoot));
  return withExecutionStateLock(options, workspace, async () => {
    const context = await loadRuntime({ ...options, projectRoot: workspace });
    const { workspace: lockedWorkspace, manifest, graph, state } = context;
    const invalidScope = validateClaimScope({ kind: "block", blockRef: options.ref }, graph);
    if (invalidScope) {
      return invalidScope;
    }
    const block = graph.blocksByRef.get(options.ref);
    if (block?.type !== "implementation") {
      return {
        kind: "blocked",
        ref: options.ref,
        reason: "dispatch claims only support implementation blocks."
      };
    }
    const taskId = graph.blockTaskByRef.get(options.ref);
    const projectBlocker = projectBlockerReason(
      await createProjectGraphClaimGuard(context),
      taskId
    );
    if (projectBlocker) {
      return { kind: "blocked", ref: options.ref, reason: projectBlocker };
    }
    if (
      !canDispatchImplementationBlock(graph, state, options.ref, {
        maxConcurrent: manifest.execution.parallel.maxConcurrent
      })
    ) {
      return {
        kind: "blocked",
        ref: options.ref,
        reason: `Block '${options.ref}' is not dispatchable right now.`
      };
    }
    state.blocks[options.ref] = claimedBlockState(state.blocks[options.ref], block.type);
    state.currentRefs = withCurrentRef(state.currentRefs, options.ref);
    await writeState(lockedWorkspace.stateFile, refreshDerivedState(manifest, state));
    const result = claimResultForBlock(
      options.ref,
      graph,
      "dispatched",
      manifest.execution.defaultExecutor
    );
    if (result.kind !== "block") throw new Error(`Expected block claim for '${options.ref}'.`);
    return { ...result, submissionAttemptId: state.blocks[options.ref].submissionAttemptId };
  });
}
