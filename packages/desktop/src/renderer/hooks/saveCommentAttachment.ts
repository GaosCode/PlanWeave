import type { CollaborationCommentAttachmentBody } from "../../shared/collaboration.js";

/** Browser download boundary; content comes from the authenticated Server read. */
export function saveCommentAttachment(
  displayName: string,
  body: CollaborationCommentAttachmentBody
) {
  const link = document.createElement("a");
  link.href = `data:${body.mediaType};base64,${body.bodyBase64}`;
  link.download = displayName;
  link.click();
}
