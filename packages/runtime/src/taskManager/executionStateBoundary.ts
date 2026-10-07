import { withCanvasLock } from "../fs/withCanvasLock.js";
import { loadPackage } from "../package/loadPackage.js";
import { withPackageFileConsistency } from "../package/packageFileConsistency.js";
import type { PackageExecutionSnapshot } from "../package/packageExecutionSnapshot.js";
import type { PlanPackageManifest, RuntimeState } from "../types.js";

export class PackageExecutionStateConflictError extends Error {
  readonly code = "package_execution_state_conflict";
  constructor() {
    super("The canonical package execution structure changed after authorization.");
    this.name = "PackageExecutionStateConflictError";
  }
}

// Presentation and captured executor content may change while an authorized read model runs.
// State identities, dependencies, review rules and scheduling semantics must remain compatible.
function executionStructure(manifest: PlanPackageManifest): string {
  const { executors: _executors, project, execution, nodes, ...rest } = manifest;
  const { title: _projectTitle, ...projectIdentity } = project;
  const { defaultExecutor: _defaultExecutor, ...scheduling } = execution;
  return JSON.stringify({
    ...rest,
    project: projectIdentity,
    execution: scheduling,
    nodes: nodes.map((node) => {
      const { title: _title, prompt: _prompt, ...identity } = node;
      if (identity.type !== "task") return identity;
      const { executor: _executor, blocks, ...task } = identity;
      return {
        ...task,
        blocks: blocks.map(
          ({ title: _blockTitle, prompt: _blockPrompt, executor: _blockExecutor, ...block }) =>
            block
        )
      };
    })
  });
}

export async function assertExecutionStateCompatible(
  snapshot: PackageExecutionSnapshot,
  state?: RuntimeState
): Promise<void> {
  const { manifest } = await loadPackage(snapshot.workspace);
  if (executionStructure(manifest) !== executionStructure(snapshot.manifest))
    throw new PackageExecutionStateConflictError();
  if (
    state &&
    (Object.keys(state.tasks).some((id) => !snapshot.graph.tasksById.has(id)) ||
      Object.keys(state.blocks).some((ref) => !snapshot.graph.blocksByRef.has(ref)) ||
      state.currentRefs.some((ref) => !snapshot.graph.blocksByRef.has(ref)) ||
      (state.currentReviewBlockRef !== null &&
        !snapshot.graph.blocksByRef.has(state.currentReviewBlockRef)) ||
      Object.values(state.feedback).some(
        (feedback) => !snapshot.graph.blocksByRef.has(feedback.sourceReviewBlockRef)
      ))
  )
    throw new PackageExecutionStateConflictError();
}

/** Package first, canvas second; release both before any executor invocation. */
export async function withExecutionStateLock<T>(
  options: { executionSnapshot?: PackageExecutionSnapshot },
  canvasDir: string,
  action: () => Promise<T>
): Promise<T> {
  const snapshot = options.executionSnapshot;
  if (!snapshot) return withCanvasLock(canvasDir, action);
  return withPackageFileConsistency([snapshot.workspace.packageDir], () =>
    withCanvasLock(canvasDir, async () => {
      await assertExecutionStateCompatible(snapshot);
      return action();
    })
  );
}
