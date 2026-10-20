import { assertExecutionStateCompatible } from "./executionStateBoundary.js";
import { optionalReadFile, optionalStat } from "../fs/optionalFile.js";
import { createExecutionGraphSessionFromSnapshot, drainGraphReadQueue } from "../graph/session.js";
import { loadPackage, resolvePackageWorkspace } from "../package/loadPackage.js";
import { createPackageFileSnapshotFromLoadedPackage } from "../package/fileChanges.js";
import { canonicalPackageFileTarget } from "../package/packageFileConsistency.js";
import { assertCurrentCanvasWorkspaceIdentity } from "../package/assertCurrentCanvasWorkspace.js";
import { assertCurrentProjectWorkspace } from "../project.js";
import { ensureStateForManifest, readState, writeState } from "../state.js";
import type {
  CompiledExecutionGraph,
  ExecutionGraphSession,
  PackageWorkspaceRef,
  PlanPackageManifest,
  ProjectWorkspace,
  RuntimeState
} from "../types.js";

export type RuntimeContext = {
  workspace: ProjectWorkspace;
  manifest: PlanPackageManifest;
  graph: CompiledExecutionGraph;
  /** Schema-validated state file before manifest reconciliation. */
  rawState: RuntimeState;
  /** Runtime state reconciled to the loaded manifest. */
  state: RuntimeState;
};

export type RuntimeOptions = {
  projectRoot: PackageWorkspaceRef;
  session?: ExecutionGraphSession;
  executionSnapshot?: import("../package/packageExecutionSnapshot.js").PackageExecutionSnapshot;
};

export async function exists(path: string): Promise<boolean> {
  return (await optionalStat(path)) !== null;
}

export async function readOptionalFile(path: string): Promise<string> {
  return (await optionalReadFile(path, "utf8")) ?? "";
}

async function assertSessionWorkspace(
  session: ExecutionGraphSession,
  requested: PackageWorkspaceRef
): Promise<void> {
  const workspace = await resolvePackageWorkspace(requested);
  const captured = session.workspace;
  const paths = (value: ProjectWorkspace) => [
    value.projectFile,
    value.packageDir,
    value.stateFile,
    value.resultsDir
  ];
  const [requestedPaths, capturedPaths] = await Promise.all([
    Promise.all(paths(workspace).map(canonicalPackageFileTarget)),
    Promise.all(paths(captured).map(canonicalPackageFileTarget))
  ]);
  if (
    workspace.id !== captured.id ||
    workspace.projectCreatedAt !== captured.projectCreatedAt ||
    workspace.packageStorageIdentity !== captured.packageStorageIdentity ||
    requestedPaths.some((path, index) => path !== capturedPaths[index])
  ) {
    throw new Error("Execution graph session workspace does not match the requested workspace.");
  }
  await assertCurrentProjectWorkspace(captured);
  await assertCurrentCanvasWorkspaceIdentity(captured);
}

async function loadRuntimeContext(options: RuntimeOptions): Promise<{
  context: RuntimeContext;
  rawState: RuntimeState;
  derivedState: RuntimeState;
}> {
  if (options.executionSnapshot) {
    const { workspace, manifest, graph } = options.executionSnapshot;
    const rawState = await readState(workspace.stateFile);
    await assertExecutionStateCompatible(options.executionSnapshot, rawState);
    const derivedState = ensureStateForManifest(manifest, rawState);
    return {
      context: { workspace, manifest, graph, rawState, state: derivedState },
      rawState,
      derivedState
    };
  }
  let session = options.session;
  if (session) {
    await assertSessionWorkspace(session, options.projectRoot);
  } else {
    const loaded = await loadPackage(options.projectRoot);
    const snapshot = await createPackageFileSnapshotFromLoadedPackage(loaded);
    session = createExecutionGraphSessionFromSnapshot({
      projectRoot: options.projectRoot,
      workspace: loaded.workspace,
      snapshot
    });
  }
  await drainGraphReadQueue(session);
  const workspace = session.workspace;
  const manifest = session.fileSnapshot.manifest;
  const graph = session.graph;
  const rawState = await readState(workspace.stateFile);
  const derivedState = ensureStateForManifest(manifest, rawState);
  return {
    context: { workspace, manifest, graph, rawState, state: derivedState },
    rawState,
    derivedState
  };
}

/** Read-only load: never persists `state.json`. */
export async function loadRuntimeReadonly(options: RuntimeOptions): Promise<RuntimeContext> {
  const { context } = await loadRuntimeContext(options);
  return context;
}

/**
 * Mutating load: persists `state.json` only when `ensureStateForManifest` changed content.
 */
export async function loadRuntime(options: RuntimeOptions): Promise<RuntimeContext> {
  const { context, rawState, derivedState } = await loadRuntimeContext(options);
  if (JSON.stringify(rawState) !== JSON.stringify(derivedState)) {
    await writeState(context.workspace.stateFile, derivedState);
  }
  return context;
}

export function refreshDerivedState(
  manifest: PlanPackageManifest,
  state: RuntimeState
): RuntimeState {
  return ensureStateForManifest(manifest, state);
}
