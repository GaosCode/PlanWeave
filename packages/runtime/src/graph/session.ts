import { loadPackage } from "../package/loadPackage.js";
import {
  createPackageFileSnapshot,
  createPackageFileSnapshotFromLoadedPackage
} from "../package/fileChanges.js";
import type {
  DrainGraphReadQueueResult,
  ExecutionGraphSession,
  GraphEditOperation,
  PackageFileChange,
  PackageFileSnapshot,
  PackageWorkspaceRef,
  ProjectWorkspace,
  ValidationIssue
} from "../types.js";
import { applyGraphEditOperation } from "./session/applyOperation.js";
import { dedupeFileChanges, normalizePackagePath, promptPathToRefs } from "./session/fileQueue.js";
import {
  alignGraphOrder,
  rebuildEdgeIndexes,
  refreshReachability
} from "./session/graphIndexes.js";
import { diffManifestToGraphOps } from "./session/manifestDiff.js";
import { readManifest, rebuildSessionFromPackage } from "./session/rebuild.js";

export async function createExecutionGraphSession(
  projectRoot: PackageWorkspaceRef
): Promise<ExecutionGraphSession> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const snapshot = await createPackageFileSnapshotFromLoadedPackage({ workspace, manifest });
  return createExecutionGraphSessionFromSnapshot({ projectRoot, workspace, snapshot });
}

export function createExecutionGraphSessionFromSnapshot(input: {
  projectRoot: PackageWorkspaceRef;
  workspace: ProjectWorkspace;
  snapshot: PackageFileSnapshot;
}): ExecutionGraphSession {
  return {
    projectRoot: input.projectRoot,
    projectId: input.workspace.id,
    packageRoot: input.workspace.packageDir,
    graph: input.snapshot.graph,
    fileSnapshot: input.snapshot,
    readQueue: {
      fileChanges: [],
      graphOps: [],
      enqueuedAt: new Date().toISOString()
    },
    dirtyPromptRefs: new Set(),
    diagnostics: [
      ...input.snapshot.graph.diagnostics.errors,
      ...input.snapshot.graph.diagnostics.warnings
    ]
  };
}

export function enqueuePackageFileChanges(
  session: ExecutionGraphSession,
  changes: PackageFileChange[]
): void {
  session.readQueue.fileChanges.push(...changes);
  session.readQueue.enqueuedAt = new Date().toISOString();
}

export function enqueueGraphEditOperations(
  session: ExecutionGraphSession,
  operations: GraphEditOperation[]
): void {
  session.readQueue.graphOps.push(...operations);
  session.readQueue.enqueuedAt = new Date().toISOString();
}

async function applyQueuedGraphOperations(
  session: ExecutionGraphSession,
  operations: GraphEditOperation[]
): Promise<ValidationIssue[]> {
  const diagnostics: ValidationIssue[] = [];
  for (const operation of operations) {
    diagnostics.push(...applyGraphEditOperation(session, operation));
    rebuildEdgeIndexes(session.graph, session.fileSnapshot.manifest);
    refreshReachability(session.graph);
  }
  if (diagnostics.length > 0) {
    await rebuildSessionFromPackage(session);
  }
  return diagnostics;
}

function drainResult(
  session: ExecutionGraphSession,
  refreshed: boolean
): DrainGraphReadQueueResult {
  return {
    session,
    refreshed,
    dirtyPromptRefs: [...session.dirtyPromptRefs],
    diagnostics: session.diagnostics
  };
}

export async function drainGraphReadQueue(
  session: ExecutionGraphSession
): Promise<DrainGraphReadQueueResult> {
  const fileChanges = dedupeFileChanges(session.readQueue.fileChanges);
  const graphOps = session.readQueue.graphOps;
  session.readQueue = {
    fileChanges: [],
    graphOps: [],
    enqueuedAt: new Date().toISOString()
  };

  if (graphOps.length > 0) {
    const diagnostics = await applyQueuedGraphOperations(session, graphOps);
    session.fileSnapshot.graph = session.graph;
    session.diagnostics = diagnostics;
    return drainResult(session, session.dirtyPromptRefs.size > 0 || diagnostics.length > 0);
  }

  const normalizedChanges = fileChanges.map((change) => ({
    ...change,
    path: normalizePackagePath(session, change.path)
  }));
  const manifestChanged = normalizedChanges.some(
    (change) => change.path === "manifest.json" || change.path.endsWith("/manifest.json")
  );
  if (manifestChanged) {
    const nextManifest = await readManifest(session.packageRoot);
    const operations = diffManifestToGraphOps(session.fileSnapshot.manifest, nextManifest);
    const diagnostics = await applyQueuedGraphOperations(session, operations);
    if (diagnostics.length > 0) {
      session.diagnostics = diagnostics;
      return drainResult(session, true);
    }
    session.fileSnapshot.manifest = nextManifest;
    session.fileSnapshot.graph = session.graph;
    alignGraphOrder(session.graph, nextManifest);
    rebuildEdgeIndexes(session.graph, nextManifest);
    refreshReachability(session.graph);
    session.diagnostics = [
      ...session.graph.diagnostics.errors,
      ...session.graph.diagnostics.warnings
    ];
    return drainResult(session, session.dirtyPromptRefs.size > 0 || operations.length > 0);
  }

  for (const change of normalizedChanges) {
    for (const ref of promptPathToRefs(session.graph, change.path)) {
      session.dirtyPromptRefs.add(ref);
    }
  }
  if (normalizedChanges.length > 0) {
    session.fileSnapshot = await createPackageFileSnapshot(session.projectRoot);
  }
  return drainResult(session, session.dirtyPromptRefs.size > 0);
}
