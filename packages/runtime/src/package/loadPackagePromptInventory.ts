import { loadPackage } from "./loadPackage.js";
import { withPackageFileConsistency } from "./packageFileConsistency.js";
import { originalPromptPaths, packagePromptOwners } from "./promptInventory.js";
import type { ProjectWorkspace } from "../types.js";

export async function loadPackagePromptReferenceInventory(
  workspace: ProjectWorkspace
): Promise<{ paths: ReadonlyMap<string, string>; manifestHash?: string }> {
  return withPackageFileConsistency([workspace.packageDir], async () => {
    const loaded = await loadPackage(workspace, { manifestContentHash: true });
    return {
      paths: originalPromptPaths(packagePromptOwners(loaded.manifest)),
      manifestHash: loaded.manifestHash
    };
  });
}
