import { join } from "node:path";
import { resolveTaskCanvasWorkspace } from "../desktop/canvasApi.js";
import { readJsonFile } from "../json.js";
import { manifestSchema } from "../schema/manifest.js";
import type { PackageWorkspaceRef, PlanPackageManifest, ProjectWorkspace } from "../types.js";

export type LoadedPlanPackage = {
  workspace: ProjectWorkspace;
  manifest: PlanPackageManifest;
};

export async function resolvePackageWorkspace(workspaceRef: PackageWorkspaceRef): Promise<ProjectWorkspace> {
  return typeof workspaceRef === "string" ? resolveTaskCanvasWorkspace(workspaceRef) : workspaceRef;
}

export async function loadPackage(workspaceRef: PackageWorkspaceRef): Promise<LoadedPlanPackage> {
  const workspace = await resolvePackageWorkspace(workspaceRef);
  const raw = await readJsonFile<unknown>(join(workspace.packageDir, "manifest.json"));
  const manifest = manifestSchema.parse(raw) as PlanPackageManifest;
  return { workspace, manifest };
}
