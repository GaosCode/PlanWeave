import { decodeCanvasReplicaDocument, projectCanvasReplicaDocument } from "@planweave-ai/runtime";
import { canvasRuntimeContentTargetSchema } from "@planweave-ai/collaboration-protocol/content/version";
import type { ContentAuthorityStore } from "./contentAuthorityStore.js";

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
