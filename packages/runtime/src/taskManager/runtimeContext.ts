import { optionalReadFile, optionalStat } from "../fs/optionalFile.js";
import { createExecutionGraphSession, drainGraphReadQueue } from "../graph/session.js";
import { loadPackage } from "../package/loadPackage.js";
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
};

export async function exists(path: string): Promise<boolean> {
  return (await optionalStat(path)) !== null;
}

export async function readOptionalFile(path: string): Promise<string> {
  return (await optionalReadFile(path, "utf8")) ?? "";
}

async function loadRuntimeContext(options: RuntimeOptions): Promise<{
  context: RuntimeContext;
  rawState: RuntimeState;
  derivedState: RuntimeState;
}> {
  const session = options.session ?? (await createExecutionGraphSession(options.projectRoot));
  const loadedPackage =
    options.session && typeof options.projectRoot !== "string"
      ? { workspace: options.projectRoot, manifest: session.fileSnapshot.manifest }
      : await loadPackage(options.projectRoot);
  const { workspace, manifest: packageManifest } = loadedPackage;
  await drainGraphReadQueue(session);
  const manifest = options.session ? session.fileSnapshot.manifest : packageManifest;
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
