import {
  canvasRuntimeContentTargetSchema,
  type CompleteContentVersion
} from "@planweave-ai/collaboration-protocol/content/version";
import type { PackageSnapshotDigestManifest } from "@planweave-ai/collaboration-protocol/content/snapshot";
import {
  decodeCanvasReplicaDocument,
  packageSnapshotSourceRevision,
  projectCanvasReplicaDocument,
  type PlanPackageManifest
} from "@planweave-ai/runtime";
import type { ContentAuthorityStore } from "./contentAuthorityStore.js";

export function packageDigestManifestFromContent(
  content: CompleteContentVersion
): PackageSnapshotDigestManifest {
  const manifest = content.members.find((member) => member.kind === "manifest");
  if (!manifest) throw new Error("canvas_content_manifest_missing");
  const prompts = content.members
    .filter((member) => member.kind === "task_prompt" || member.kind === "block_prompt")
    .map((member) => ({
      path: member.path,
      digest: { digestSha256: member.digestSha256, sizeBytes: member.sizeBytes }
    }));
  return {
    manifest: { digestSha256: manifest.digestSha256, sizeBytes: manifest.sizeBytes },
    prompts,
    totalBytes:
      manifest.sizeBytes + prompts.reduce((total, member) => total + member.digest.sizeBytes, 0)
  };
}

export function readStableCanvasRuntimeContentTarget(
  contentVersions: ContentAuthorityStore,
  scope: { workspaceId: string; projectId: string; canvasId: string }
) {
  const head = contentVersions.head(scope);
  if (!head) throw new Error("canvas_content_head_missing");
  const authoritative = contentVersions.readVersion(scope, head.content);
  const graphFingerprint = projectCanvasReplicaDocument(
    decodeCanvasReplicaDocument(authoritative.content)
  ).packageFingerprint;
  const currentHead = contentVersions.head(scope);
  if (
    !currentHead ||
    currentHead.revision !== head.revision ||
    currentHead.content.versionId !== head.content.versionId ||
    currentHead.content.canonicalDigest !== head.content.canonicalDigest
  ) {
    throw new Error("canvas_content_head_changed");
  }
  return canvasRuntimeContentTargetSchema.parse({
    revision: head.revision,
    content: head.content,
    graphFingerprint
  });
}

export function readStableCanvasContentFingerprint(
  contentVersions: ContentAuthorityStore,
  scope: { workspaceId: string; projectId: string; canvasId: string }
): string | undefined {
  if (!contentVersions.head(scope)) return undefined;
  try {
    return readStableCanvasRuntimeContentTarget(contentVersions, scope).graphFingerprint;
  } catch (error) {
    if (error instanceof Error && error.message === "canvas_content_head_changed") return undefined;
    throw error;
  }
}

export function readStableCanvasRuntimeAuthority(
  contentVersions: ContentAuthorityStore,
  scope: { workspaceId: string; projectId: string; canvasId: string }
): { packageFingerprint: string; manifest: PlanPackageManifest } | undefined {
  if (!contentVersions.head(scope)) return undefined;
  try {
    const target = readStableCanvasRuntimeContentTarget(contentVersions, scope);
    const authoritative = contentVersions.readVersion(scope, target.content);
    return {
      packageFingerprint: target.graphFingerprint,
      manifest: decodeCanvasReplicaDocument(authoritative.content).manifest
    };
  } catch (error) {
    if (error instanceof Error && error.message === "canvas_content_head_changed") return undefined;
    throw error;
  }
}

export function readStableCanvasRuntimeEvidence(
  contentVersions: ContentAuthorityStore,
  scope: { workspaceId: string; projectId: string; canvasId: string }
) {
  if (!contentVersions.head(scope)) return undefined;
  try {
    const target = readStableCanvasRuntimeContentTarget(contentVersions, scope);
    const authoritative = contentVersions.readVersion(scope, target.content);
    return {
      target,
      sourceRevision: packageSnapshotSourceRevision(
        packageDigestManifestFromContent(authoritative.content)
      )
    };
  } catch (error) {
    if (error instanceof Error && error.message === "canvas_content_head_changed") {
      return undefined;
    }
    throw error;
  }
}
