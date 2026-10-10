import { createHash } from "node:crypto";
import {
  canonicalContentVersionDigestPayload,
  compareContentVersionMemberPaths,
  completeContentVersionSchema,
  contentVersionDesktopLayoutMemberPath,
  type CompleteContentVersion
} from "@planweave-ai/collaboration-protocol/content/version";
import { type PackageSnapshotDigestManifest } from "@planweave-ai/collaboration-protocol/content/snapshot";
import { capturePackageSnapshot } from "../package/packageSnapshot.js";
import { withPackageFileConsistency } from "../package/packageFileConsistency.js";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import type { PackageWorkspaceRef } from "../types.js";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import { getDesktopLayoutDirect, layoutPathForWorkspace } from "./layoutStore.js";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export type CapturedAuthorizedCanvasContent = {
  content: CompleteContentVersion;
  digestManifest: PackageSnapshotDigestManifest;
  packageDir: string;
};

/**
 * Captures the complete semantic canvas content used by both command CAS and
 * immutable content versions. Shared layout commands carry their timestamp in
 * the durable intent, so every materializer hashes the same complete content.
 */
export async function captureAuthorizedCanvasContent(input: {
  projectRoot: PackageWorkspaceRef;
  canvasId?: string;
  expectedPackageDir?: string;
  authorityProjectId?: string;
}): Promise<CapturedAuthorizedCanvasContent> {
  const workspace =
    input.canvasId && typeof input.projectRoot === "string"
      ? await resolveTaskCanvasWorkspace(input.projectRoot, input.canvasId)
      : await resolvePackageWorkspace(input.projectRoot);
  if (input.expectedPackageDir !== undefined && workspace.packageDir !== input.expectedPackageDir) {
    throw new Error("runtime_package_location_mismatch");
  }
  const { captured, layout } = await withPackageFileConsistency(
    [workspace.packageDir, layoutPathForWorkspace(workspace)],
    async () => {
      const captured = await capturePackageSnapshot({ projectRoot: workspace });
      if (captured.resolvedPackageDir !== workspace.packageDir) {
        throw new Error("runtime_package_location_mismatch");
      }
      const layout = await getDesktopLayoutDirect(workspace);
      return { captured, layout };
    }
  );
  const canonicalLayout = `${JSON.stringify(
    {
      ...layout,
      projectId: input.authorityProjectId ?? workspace.id
    },
    null,
    2
  )}\n`;
  const members = [
    ...captured.snapshot.files.map((file) => ({
      kind:
        file.path === "manifest.json"
          ? ("manifest" as const)
          : file.path.includes("/blocks/")
            ? ("block_prompt" as const)
            : ("task_prompt" as const),
      path: file.path,
      content: file.content,
      digestSha256: file.digestSha256,
      sizeBytes: file.sizeBytes
    })),
    {
      kind: "desktop_layout" as const,
      path: contentVersionDesktopLayoutMemberPath,
      content: canonicalLayout,
      digestSha256: sha256(canonicalLayout),
      sizeBytes: Buffer.byteLength(canonicalLayout, "utf8")
    }
  ].sort((left, right) => compareContentVersionMemberPaths(left.path, right.path));
  const totalBytes = members.reduce((sum, member) => sum + member.sizeBytes, 0);
  const provisional = { members, totalBytes, canonicalDigest: "0".repeat(64) };
  const content = completeContentVersionSchema.parse({
    ...provisional,
    canonicalDigest: sha256(canonicalContentVersionDigestPayload(provisional))
  });
  return {
    content,
    digestManifest: captured.snapshot.digestManifest,
    packageDir: workspace.packageDir
  };
}
