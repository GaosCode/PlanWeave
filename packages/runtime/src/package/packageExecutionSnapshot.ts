import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { manifestSchema } from "../schema/manifest.js";
import type { CompiledExecutionGraph, PlanPackageManifest, ProjectWorkspace } from "../types.js";
import type { CapturedPackageSnapshot } from "./packageSnapshot.js";

/** Private execution read model; state/results continue to use the canonical workspace. */
export type PackageExecutionSnapshot = {
  workspace: ProjectWorkspace;
  manifest: PlanPackageManifest;
  graph: CompiledExecutionGraph;
  promptMarkdownByPath: ReadonlyMap<string, string>;
};

export function packageExecutionSnapshot(
  workspace: ProjectWorkspace,
  snapshot: CapturedPackageSnapshot
): PackageExecutionSnapshot {
  const manifestFile = snapshot.files.find((file) => file.path === "manifest.json");
  if (!manifestFile) throw new Error("package_snapshot_manifest_missing");
  const manifest = manifestSchema.parse(JSON.parse(manifestFile.content));
  return {
    workspace,
    manifest,
    graph: compileTaskGraph(manifest),
    promptMarkdownByPath: new Map(
      snapshot.files
        .filter((file) => file.path !== "manifest.json")
        .map((file) => [file.path, file.content])
    )
  };
}
