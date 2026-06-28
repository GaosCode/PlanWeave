import { join } from "node:path";
import { readJsonFile } from "../../json.js";
import { createPackageFileSnapshotFromPackageRoot } from "../../package/fileChanges.js";
import type { ExecutionGraphSession, PlanPackageManifest } from "../../types.js";

export async function readManifest(packageRoot: string): Promise<PlanPackageManifest> {
  return readJsonFile<PlanPackageManifest>(join(packageRoot, "manifest.json"));
}

export async function rebuildSessionFromPackage(session: ExecutionGraphSession): Promise<void> {
  const manifest = await readManifest(session.packageRoot);
  const snapshot = await createPackageFileSnapshotFromPackageRoot({
    packageDir: session.packageRoot,
    manifestFile: join(session.packageRoot, "manifest.json"),
    manifest
  });
  session.graph = snapshot.graph;
  session.fileSnapshot = snapshot;
  session.diagnostics = [...snapshot.graph.diagnostics.errors, ...snapshot.graph.diagnostics.warnings];
  session.dirtyPromptRefs = new Set(session.graph.blockRefsInManifestOrder);
}
