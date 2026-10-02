import { useLayoutEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import type { CollaborationCommentAttachmentBody } from "../../shared/collaboration.js";
import type { CommentRowViewModel } from "../collaboration/commentViewModels";
import type { createTranslator } from "../i18n";

type CommentAttachmentViewProps = {
  commentId: string;
  attachments: CommentRowViewModel["attachments"];
  t: ReturnType<typeof createTranslator>;
  onReadAttachment: (
    commentId: string,
    digestSha256: string
  ) => Promise<CollaborationCommentAttachmentBody>;
};

export function CommentAttachmentView({
  commentId,
  attachments,
  t,
  onReadAttachment
}: CommentAttachmentViewProps) {
  const [attachmentBody, setAttachmentBody] = useState<CollaborationCommentAttachmentBody | null>(
    null
  );
  const [attachmentLoadingId, setAttachmentLoadingId] = useState<string | null>(null);
  const [attachmentErrorId, setAttachmentErrorId] = useState<string | null>(null);
  const [expandedAttachmentId, setExpandedAttachmentId] = useState<string | null>(null);

  const generationRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: callback identity carries the project/session/work-item scope
  useLayoutEffect(() => {
    generationRef.current += 1;
    setAttachmentBody(null);
    setAttachmentLoadingId(null);
    setAttachmentErrorId(null);
    setExpandedAttachmentId(null);
    return () => {
      generationRef.current += 1;
    };
  }, [commentId, onReadAttachment]);

  const openAttachment = async (digestSha256: string) => {
    const generation = ++generationRef.current;
    if (attachmentBody?.digestSha256 === digestSha256) {
      setAttachmentBody(null);
      setExpandedAttachmentId(null);
      return;
    }
    setAttachmentBody(null);
    setExpandedAttachmentId(null);
    setAttachmentLoadingId(digestSha256);
    setAttachmentErrorId(null);
    try {
      const body = await onReadAttachment(commentId, digestSha256);
      if (generation === generationRef.current) setAttachmentBody(body);
    } catch {
      if (generation === generationRef.current) setAttachmentErrorId(digestSha256);
    } finally {
      if (generation === generationRef.current) setAttachmentLoadingId(null);
    }
  };

  const expandedAttachment =
    expandedAttachmentId && attachmentBody?.digestSha256 === expandedAttachmentId
      ? (attachments.find((attachment) => attachment.id === expandedAttachmentId) ?? null)
      : null;
  const expandedDataUrl =
    expandedAttachment && attachmentBody
      ? `data:${attachmentBody.mediaType};base64,${attachmentBody.bodyBase64}`
      : null;

  return (
    <>
      <ul className="mt-2 flex flex-col gap-1" data-testid="comments-item-attachments">
        {attachments.map((attachment) => {
          const loaded = attachmentBody?.digestSha256 === attachment.id ? attachmentBody : null;
          const dataUrl = loaded ? `data:${loaded.mediaType};base64,${loaded.bodyBase64}` : null;
          return (
            <li
              key={attachment.id}
              className="overflow-hidden rounded border border-border/50 px-2 py-1 text-[11px] text-muted-foreground"
              data-testid="comments-attachment"
            >
              <Button
                size="sm"
                variant="ghost"
                className="h-auto w-full min-w-0 justify-start truncate px-0 py-0 text-left font-medium text-text"
                aria-label={`${t("commentsViewAttachment")} ${attachment.displayName}`}
                title={attachment.displayName}
                disabled={attachmentLoadingId === attachment.id}
                onClick={() => void openAttachment(attachment.id)}
              >
                {attachment.displayName}
              </Button>
              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
                <span className="whitespace-nowrap">{attachment.mediaType}</span>
                <span className="whitespace-nowrap">{attachment.sizeBytes} B</span>
                <span className="min-w-0 truncate" title={t("commentsAttachmentDigest")}>
                  {attachment.digestShort}
                </span>
              </div>
              {attachmentLoadingId === attachment.id ? (
                <p className="mt-1">{t("commentsAttachmentLoading")}</p>
              ) : null}
              {attachmentErrorId === attachment.id ? (
                <p className="mt-1 text-destructive" role="alert">
                  {t("commentsAttachmentReadFailed")}
                </p>
              ) : null}
              {loaded && dataUrl ? (
                <div
                  className="mt-2 border-t border-border/50 pt-2"
                  data-testid="comments-attachment-preview"
                >
                  {loaded.mediaType.startsWith("image/") ? (
                    <button
                      type="button"
                      className="block w-full cursor-zoom-in overflow-hidden rounded border border-border/50 bg-muted/20 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                      aria-label={`${t("commentsExpandAttachment")} ${attachment.displayName}`}
                      onClick={() => setExpandedAttachmentId(attachment.id)}
                    >
                      <img
                        alt={attachment.displayName}
                        className="max-h-64 w-full object-contain"
                        src={dataUrl}
                      />
                    </button>
                  ) : (
                    <p>{t("commentsAttachmentPreviewUnavailable")}</p>
                  )}
                  <a
                    className="mt-1 inline-flex font-medium text-text underline underline-offset-2"
                    download={attachment.displayName}
                    href={dataUrl}
                  >
                    {t("commentsDownloadAttachment")}
                  </a>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <DialogPrimitive.Root
        open={Boolean(expandedAttachment && expandedDataUrl)}
        onOpenChange={(open) => {
          if (!open) setExpandedAttachmentId(null);
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay
            className="fixed inset-0 z-[100] bg-black/25 backdrop-blur-[2px]"
            data-testid="comments-attachment-lightbox-overlay"
          />
          <DialogPrimitive.Content
            className="fixed inset-4 z-[101] flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background text-text shadow-2xl outline-none sm:inset-8"
            data-testid="comments-attachment-lightbox"
          >
            <header className="flex min-w-0 items-center gap-3 border-b border-border px-3 py-2">
              <DialogPrimitive.Title
                className="min-w-0 flex-1 truncate text-sm font-medium"
                title={expandedAttachment?.displayName}
              >
                {expandedAttachment?.displayName}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">
                {t("commentsAttachmentPreviewHint")}
              </DialogPrimitive.Description>
              <DialogPrimitive.Close asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("commentsCloseAttachmentPreview")}
                >
                  <XIcon aria-hidden="true" />
                </Button>
              </DialogPrimitive.Close>
            </header>
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/20 p-3">
              {expandedAttachment && expandedDataUrl ? (
                <img
                  alt={expandedAttachment.displayName}
                  className="max-h-full max-w-full object-contain"
                  draggable={false}
                  src={expandedDataUrl}
                />
              ) : null}
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
