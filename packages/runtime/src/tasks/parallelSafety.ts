import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import type { CompiledExecutionGraph, PlanPackageManifest } from "../types.js";
import { refsConflict } from "../taskManager/selectors.js";

export function canShareParallelBatch(
  manifest: PlanPackageManifest,
  selected: string[],
  candidateRef: string,
  graph: CompiledExecutionGraph = compileTaskGraph(manifest)
): boolean {
  if (graph.blocksByRef.get(candidateRef)?.type !== "implementation") {
    return false;
  }
  return selected.every((selectedRef) => !refsConflict(graph, candidateRef, selectedRef));
}
