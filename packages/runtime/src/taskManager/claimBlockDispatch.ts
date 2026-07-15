import { dirname } from "node:path";
import { withCanvasLock } from "../fs/withCanvasLock.js";
import { loadPackage } from "../package/loadPackage.js";
import { writeState } from "../state.js";
import type { ClaimResult, ExecutionGraphSession, PackageWorkspaceRef } from "../types.js";
import { projectBlockerReason } from "./claimReadinessRules.js";
import { createProjectGraphClaimGuard } from "./projectGraphClaimGuard.js";
import { loadRuntime, refreshDerivedState } from "./runtimeContext.js";
import {
  canDispatchImplementationBlock,
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
}): Promise<ClaimResult> {
  const { workspace } = await loadPackage(options.projectRoot);
  return withCanvasLock(dirname(workspace.stateFile), async () => {
    const context = await loadRuntime(options);
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
    state.blocks[options.ref] = { ...state.blocks[options.ref], status: "in_progress" };
    state.currentRefs = withCurrentRef(state.currentRefs, options.ref);
    await writeState(lockedWorkspace.stateFile, refreshDerivedState(manifest, state));
    return claimResultForBlock(
      options.ref,
      graph,
      "dispatched",
      manifest.execution.defaultExecutor
    );
  });
}
