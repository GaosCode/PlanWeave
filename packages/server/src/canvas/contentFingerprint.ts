import { decodeCanvasReplicaDocument, projectCanvasReplicaDocument } from "@planweave-ai/runtime";
import type { ContentAuthorityStore } from "./contentAuthorityStore.js";

export function readStableCanvasContentFingerprint(
  contentVersions: ContentAuthorityStore,
  scope: { workspaceId: string; projectId: string; canvasId: string }
): string | undefined {
  const head = contentVersions.head(scope);
  if (!head) return undefined;
  const authoritative = contentVersions.readVersion(scope, head.content);
  if (
    authoritative.completed.versionId !== head.content.versionId ||
    authoritative.content.canonicalDigest !== head.content.canonicalDigest
  ) {
    throw new Error("canvas_content_head_mismatch");
  }
  const fingerprint = projectCanvasReplicaDocument(
    decodeCanvasReplicaDocument(authoritative.content)
  ).packageFingerprint;
  const currentHead = contentVersions.head(scope);
  if (
    !currentHead ||
    currentHead.revision !== head.revision ||
    currentHead.content.versionId !== head.content.versionId ||
    currentHead.content.canonicalDigest !== head.content.canonicalDigest
  ) {
    return undefined;
  }
  return fingerprint;
}
