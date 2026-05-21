import { join } from "node:path";
import { compilePackageGraph } from "../compileTaskGraph.js";
import { readJsonFile } from "../../json.js";
import { createPackageFileSnapshot } from "../../package/fileChanges.js";
import type { CompiledExecutionGraph, ExecutionGraphSession, PlanPackageManifest, ValidationIssue } from "../../types.js";

export async function readManifest(packageRoot: string): Promise<PlanPackageManifest> {
  return readJsonFile<PlanPackageManifest>(join(packageRoot, "manifest.json"));
}

async function rebuildGraph(packageRoot: string): Promise<{ graph: CompiledExecutionGraph; diagnostics: ValidationIssue[] }> {
  const manifest = await readManifest(packageRoot);
  const graph = await compilePackageGraph(manifest, packageRoot);
  return { graph, diagnostics: [...graph.diagnostics.errors, ...graph.diagnostics.warnings] };
}

export async function rebuildSessionFromPackage(session: ExecutionGraphSession): Promise<void> {
  const rebuilt = await rebuildGraph(session.packageRoot);
  session.graph = rebuilt.graph;
  session.fileSnapshot = await createPackageFileSnapshot(session.projectRoot);
  session.diagnostics = rebuilt.diagnostics;
  session.dirtyPromptRefs = new Set(session.graph.blockRefsInManifestOrder);
}
