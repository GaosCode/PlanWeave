import { join } from "node:path";
import { resolveTaskCanvasWorkspace } from "../desktop/canvasApi.js";
import { readJsonFile } from "../json.js";
import { requireInitializedProjectWorkspace } from "../project.js";
import { manifestSchema } from "../schema/manifest.js";
import type { PackageWorkspaceRef, PlanPackageManifest, ProjectWorkspace } from "../types.js";
import { readBoundedUtf8File, type ContentReadBudget } from "./boundedUtf8Reader.js";
import { resolvePackagePath } from "./resolvePackagePath.js";
import { MAX_FILE_READ_BYTES } from "./contentReadPolicy.js";

export type LoadedPlanPackage = {
  workspace: ProjectWorkspace;
  manifest: PlanPackageManifest;
  manifestContent?: Omit<Awaited<ReturnType<typeof readBoundedUtf8File>>, "content">;
};

export async function resolvePackageWorkspace(
  workspaceRef: PackageWorkspaceRef
): Promise<ProjectWorkspace> {
  return typeof workspaceRef === "string" ? resolveTaskCanvasWorkspace(workspaceRef) : workspaceRef;
}

export async function loadPackage(
  workspaceRef: PackageWorkspaceRef,
  options: { boundedManifest?: boolean; manifestReadBudget?: ContentReadBudget } = {}
): Promise<LoadedPlanPackage> {
  if (typeof workspaceRef === "string") {
    await requireInitializedProjectWorkspace(workspaceRef);
  }
  const workspace = await resolvePackageWorkspace(workspaceRef);
  // One invalid input byte can decode to a three-byte replacement character.
  const bounded = options.boundedManifest
    ? await readBoundedUtf8File(
        await resolvePackagePath(workspace.packageDir, "manifest.json", { requireExisting: true }),
        { maxBytes: MAX_FILE_READ_BYTES * 3, pageBudget: options.manifestReadBudget }
      )
    : undefined;
  const raw: unknown = bounded
    ? JSON.parse(bounded.content)
    : await readJsonFile<unknown>(join(workspace.packageDir, "manifest.json"));
  const manifest = manifestSchema.parse(raw) as PlanPackageManifest;
  if (bounded) {
    const { content: _content, ...manifestContent } = bounded;
    return { workspace, manifest, manifestContent };
  }
  return { workspace, manifest };
}
