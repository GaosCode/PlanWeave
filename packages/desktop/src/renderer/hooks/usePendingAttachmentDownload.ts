import type { CollaborationOperationScope } from "../../shared/collaborationOperationScope.js";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import type { StagedAttachment } from "../collaboration/attachmentUpload";
import { saveCommentAttachment } from "./saveCommentAttachment";

/** Downloads remain bound to the ready upload and the live composer scope. */
export function usePendingAttachmentDownload(args: {
  api: PlanWeaveCollaborationApi | null;
  operationScope: CollaborationOperationScope | null;
  stagedAttachments: StagedAttachment[];
  isCurrentScope: () => boolean;
  isCancelled: (localId: string) => boolean;
  onStart: () => void;
  onError: (error: unknown) => void;
}) {
  const attachments = useRef(args.stagedAttachments);
  const pending = useRef(new Set<string>());
  const [downloading, setDownloading] = useState<string[]>([]);
  useLayoutEffect(() => {
    attachments.current = args.stagedAttachments;
  }, [args.stagedAttachments]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the scope guard identity retires pending UI state
  useLayoutEffect(() => {
    pending.current = new Set();
    setDownloading([]);
  }, [args.isCurrentScope]);
  const download = useCallback(
    async (localId: string) => {
      const attachment = attachments.current.find((item) => item.localId === localId);
      if (
        !args.api ||
        !args.operationScope ||
        !args.isCurrentScope() ||
        args.isCancelled(localId) ||
        !attachment ||
        attachment.phase !== "ready" ||
        !attachment.pendingUploadId ||
        !attachment.digestSha256 ||
        pending.current.has(localId)
      )
        return;
      const requests = pending.current;
      requests.add(localId);
      args.onStart();
      setDownloading([...requests]);
      try {
        const body = await args.api.readCollaborationPendingAttachment({
          operationScope: args.operationScope,
          pendingUploadId: attachment.pendingUploadId,
          digestSha256: attachment.digestSha256
        });
        const current = attachments.current.find((item) => item.localId === localId);
        if (!args.isCurrentScope() || args.isCancelled(localId) || current !== attachment) return;
        saveCommentAttachment(attachment.displayName, body);
      } catch (error) {
        if (
          args.isCurrentScope() &&
          !args.isCancelled(localId) &&
          attachments.current.includes(attachment)
        )
          args.onError(error);
      } finally {
        requests.delete(localId);
        if (args.isCurrentScope() && pending.current === requests) setDownloading([...requests]);
      }
    },
    [
      args.api,
      args.operationScope,
      args.isCurrentScope,
      args.isCancelled,
      args.onStart,
      args.onError
    ]
  );
  return { download, downloading };
}
