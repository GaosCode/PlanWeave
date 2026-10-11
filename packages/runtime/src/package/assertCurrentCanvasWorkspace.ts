import { assertPackageStorageIdentity } from "./packageStorageIdentity.js";
import { optionalStat } from "../fs/optionalFile.js";
import { listRegisteredCanvasWorkspacesForProject } from "../desktop/projectCanvasStore.js";
import { resolveProjectWorkspaceInHome } from "../project.js";
import type { ProjectWorkspace } from "../types.js";
import { canonicalPackageFileTarget } from "./packageFileConsistency.js";

/** Caller holds the parent project and captured package/state/results storage locks. */
export async function assertCurrentCanvasWorkspace(workspace: ProjectWorkspace): Promise<void> {
  const project = await resolveProjectWorkspaceInHome(workspace.rootPath, workspace.planweaveHome);
  const registered = await listRegisteredCanvasWorkspacesForProject(project);
  const paths = [
    workspace.packageDir,
    workspace.manifestFile,
    workspace.stateFile,
    workspace.resultsDir
  ];
  const captured = await Promise.all(paths.map(canonicalPackageFileTarget));
  let matched = false;
  for (const canvas of registered) {
    const current = await Promise.all(
      [canvas.packageDir, canvas.manifestFile, canvas.stateFile, canvas.resultsDir].map(
        canonicalPackageFileTarget
      )
    );
    if (current.every((target, index) => target === captured[index])) {
      matched = true;
      break;
    }
  }
  if (!matched)
    throw new Error(`PlanWeave canvas storage identity changed at '${workspace.packageDir}'.`);
  await assertPackageStorageIdentity(workspace);
  const [packageDir, manifest, state, results] = await Promise.all(paths.map(optionalStat));
  if (
    !packageDir?.isDirectory() ||
    !manifest?.isFile() ||
    (state !== null && !state.isFile()) ||
    (results !== null && !results.isDirectory())
  ) {
    throw new Error(`PlanWeave canvas storage is unavailable at '${workspace.packageDir}'.`);
  }
}
