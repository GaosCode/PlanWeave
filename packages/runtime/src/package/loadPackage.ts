import { join } from "node:path";
import { resolveTaskCanvasWorkspace } from "../desktop/canvasApi.js";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { requireInitializedProjectWorkspace } from "../project.js";
import { manifestSchema } from "../schema/manifest.js";
import type {
  FileFingerprint,
  PackageWorkspaceRef,
  PlanPackageManifest,
  ProjectWorkspace
} from "../types.js";
import { readBoundedUtf8File, type ContentReadBudget } from "./boundedUtf8Reader.js";
import { resolvePackagePath } from "./resolvePackagePath.js";
import { MAX_FILE_READ_BYTES } from "./contentReadPolicy.js";

export type LoadedPlanPackage = {
  workspace: ProjectWorkspace;
  manifest: PlanPackageManifest;
  manifestHash?: string;
  manifestFingerprint?: FileFingerprint;
  manifestContent?: Omit<Awaited<ReturnType<typeof readBoundedUtf8File>>, "content">;
};

export async function resolvePackageWorkspace(
  workspaceRef: PackageWorkspaceRef
): Promise<ProjectWorkspace> {
  return typeof workspaceRef === "string" ? resolveTaskCanvasWorkspace(workspaceRef) : workspaceRef;
}

export async function loadPackage(
  workspaceRef: PackageWorkspaceRef,
  options: {
    boundedManifest?: boolean;
    manifestReadBudget?: ContentReadBudget;
    fingerprintManifest?: boolean;
    manifestContentHash?: boolean;
  } = {}
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
  if (bounded) {
    const { content, ...manifestContent } = bounded;
    return { workspace, manifest: manifestSchema.parse(JSON.parse(content)), manifestContent };
  }
  const path =
    options.fingerprintManifest || options.manifestContentHash
      ? await resolvePackagePath(workspace.packageDir, "manifest.json", { requireExisting: true })
      : join(workspace.packageDir, "manifest.json");
  const metadata = options.fingerprintManifest ? await stat(path) : null;
  const bytes = await readFile(path);
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (!options.fingerprintManifest && !options.manifestContentHash) return { workspace, manifest };
  const manifestHash = createHash("sha256").update(bytes).digest("hex");
  return {
    workspace,
    manifest,
    manifestHash,
    ...(metadata
      ? { manifestFingerprint: { path, hash: manifestHash, mtimeMs: metadata.mtimeMs } }
      : {})
  };
}
