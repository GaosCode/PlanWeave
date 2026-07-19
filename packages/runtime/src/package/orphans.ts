import { join } from "node:path";
import { optionalReaddir } from "../fs/optionalFile.js";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import type {
  CompiledExecutionGraph,
  OrphanResultSummary,
  OrphanStateSummary,
  PlanPackageManifest,
  ProjectWorkspace,
  RuntimeState
} from "../types.js";

const canvasResultDirectoryNames = new Set(["auto-runs", "feedback-runs", "run-sessions"]);

export type ManifestIdentitySets = {
  taskIds: Set<string>;
  blockRefs: Set<string>;
};

/**
 * Project task/block identity from an already-compiled graph.
 * Prefer this when a compile result is already in hand (status, doctor, validate).
 */
export function identitySetsFromGraph(graph: CompiledExecutionGraph): ManifestIdentitySets {
  return {
    taskIds: new Set(graph.taskNodesInManifestOrder),
    blockRefs: new Set(graph.blockRefsInManifestOrder)
  };
}

/**
 * Compile once from the manifest, then project identity sets.
 * Use only when no compiled graph is available.
 */
export function identitySetsFromManifest(manifest: PlanPackageManifest): ManifestIdentitySets {
  return identitySetsFromGraph(compileTaskGraph(manifest));
}

export function findOrphanStateFromIdentity(
  identity: ManifestIdentitySets,
  state: RuntimeState
): OrphanStateSummary[] {
  const { taskIds, blockRefs } = identity;
  return [
    ...Object.entries(state.tasks ?? {})
      .filter(([taskId]) => !taskIds.has(taskId))
      .map(([taskId, task]) => ({ taskId, status: task.status })),
    ...Object.entries(state.blocks ?? {})
      .filter(([ref]) => !blockRefs.has(ref))
      .map(([ref, block]) => ({ ref, status: block.status, lastRunId: block.lastRunId ?? null }))
  ];
}

export async function findOrphanResultsFromIdentity(
  workspace: ProjectWorkspace,
  identity: Pick<ManifestIdentitySets, "taskIds">
): Promise<OrphanResultSummary[]> {
  const entries = await optionalReaddir(workspace.resultsDir, { withFileTypes: true });
  if (!entries) {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !canvasResultDirectoryNames.has(entry.name) &&
        !identity.taskIds.has(entry.name)
    )
    .map((entry) => ({ taskId: entry.name, path: join(workspace.resultsDir, entry.name) }));
}

/** Orphan state projection against a compiled graph (no compile). */
export function findOrphanStateFromGraph(
  graph: CompiledExecutionGraph,
  state: RuntimeState
): OrphanStateSummary[] {
  return findOrphanStateFromIdentity(identitySetsFromGraph(graph), state);
}

/** Orphan result directories against a compiled graph (no compile). */
export async function findOrphanResultsFromGraph(
  workspace: ProjectWorkspace,
  graph: CompiledExecutionGraph
): Promise<OrphanResultSummary[]> {
  return findOrphanResultsFromIdentity(workspace, identitySetsFromGraph(graph));
}

/**
 * Compile once from the manifest and project orphan state.
 * Prefer `findOrphanStateFromGraph` when a graph is already available.
 */
export function findOrphanStateFromManifest(
  manifest: PlanPackageManifest,
  state: RuntimeState
): OrphanStateSummary[] {
  return findOrphanStateFromIdentity(identitySetsFromManifest(manifest), state);
}

/**
 * Compile once from the manifest and project orphan result directories.
 * Prefer `findOrphanResultsFromGraph` when a graph is already available.
 */
export async function findOrphanResultsFromManifest(
  workspace: ProjectWorkspace,
  manifest: PlanPackageManifest
): Promise<OrphanResultSummary[]> {
  return findOrphanResultsFromIdentity(workspace, identitySetsFromManifest(manifest));
}
