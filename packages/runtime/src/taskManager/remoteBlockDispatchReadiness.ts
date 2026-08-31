import type { CompiledExecutionGraph, PlanPackageManifest, RuntimeState } from "../types.js";
import { reviewClaimForm } from "./claimReadiness.js";
import { canDispatchImplementationBlock } from "./selectors.js";

export type RemoteBlockDispatchReadiness =
  | { dispatchable: true; reason: null }
  | { dispatchable: false; reason: string };

/** Applies the same implementation and review readiness rules as remote inspection. */
export function remoteBlockDispatchReadiness(input: {
  graph: CompiledExecutionGraph;
  manifest: PlanPackageManifest;
  state: RuntimeState;
  ref: string;
}): RemoteBlockDispatchReadiness {
  const block = input.graph.blocksByRef.get(input.ref);
  if (block?.type === "implementation") {
    return canDispatchImplementationBlock(input.graph, input.state, input.ref, {
      maxConcurrent: input.manifest.execution.parallel.maxConcurrent
    })
      ? { dispatchable: true, reason: null }
      : {
          dispatchable: false,
          reason: `Block '${input.ref}' is not dispatchable right now.`
        };
  }
  if (block?.type === "review") {
    const form = reviewClaimForm(input.graph, input.state, input.ref);
    return form.kind === "not_claimable"
      ? { dispatchable: false, reason: form.reason }
      : { dispatchable: true, reason: null };
  }
  return {
    dispatchable: false,
    reason: `Block '${input.ref}' is not remotely executable.`
  };
}
