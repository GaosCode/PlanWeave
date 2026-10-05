import { useState } from "react";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { createTranslator } from "../i18n";
import { useActivityPanelController } from "../hooks/useActivityPanelController";
import { useCommentsPanelController } from "../hooks/useCommentsPanelController";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import { ActivityPanel } from "./ActivityPanel";
import { CommentsPanel } from "./CommentsPanel";

export type WorkItemCollaborationPanelProps = {
  workItem: WorkItemRef | null;
  t: ReturnType<typeof createTranslator>;
  api?: PlanWeaveCollaborationApi | null;
  className?: string;
  /** When false, histories stay unloaded. Default true once mounted. */
  open?: boolean;
  /** Inline comment surface used by the canvas annotation popover. */
  commentsOnly?: boolean;
  autoFocusComposer?: boolean;
};

type TabId = "comments" | "activity";

/**
 * Human collaboration surface for the selected Task/Block.
 * Visually distinct from Agent conversation: labeled Comments + Activity only.
 */
export function WorkItemCollaborationPanel({
  workItem,
  t,
  api,
  className,
  open = true,
  commentsOnly = false,
  autoFocusComposer = false
}: WorkItemCollaborationPanelProps) {
  const [tab, setTab] = useState<TabId>("comments");
  const commentsOpen = open && tab === "comments";
  const activityOpen = open && !commentsOnly && tab === "activity";

  const comments = useCommentsPanelController({
    workItem,
    open: commentsOpen,
    api,
    t
  });
  const activity = useActivityPanelController({
    workItem,
    open: activityOpen,
    api,
    t
  });

  if (!workItem) {
    return null;
  }

  return (
    <section
      className={cn(
        commentsOnly
          ? "flex min-h-0 flex-col gap-2"
          : "flex min-h-0 flex-col gap-3 border-t border-border/80 pt-3",
        className
      )}
      data-testid="work-item-collaboration-panel"
      data-work-item-kind={workItem.kind}
      aria-label={t("collaborationHumanDiscussion")}
    >
      {!commentsOnly ? (
        <>
          <div
            className="flex items-center gap-5 border-b border-border/70"
            role="tablist"
            aria-label={t("collaborationHumanDiscussion")}
          >
            <Button
              role="tab"
              size="sm"
              variant="ghost"
              className="rounded-none border-b-2 border-transparent px-0 data-[active=true]:border-foreground"
              data-active={tab === "comments"}
              aria-selected={tab === "comments"}
              data-testid="collaboration-tab-comments"
              onClick={() => setTab("comments")}
            >
              {t("commentsTitle")}
            </Button>
            <Button
              role="tab"
              size="sm"
              variant="ghost"
              className="rounded-none border-b-2 border-transparent px-0 data-[active=true]:border-foreground"
              data-active={tab === "activity"}
              aria-selected={tab === "activity"}
              data-testid="collaboration-tab-activity"
              onClick={() => setTab("activity")}
            >
              {t("activityTitle")}
            </Button>
          </div>

          <p className="text-[11px] text-muted-foreground" data-testid="collaboration-human-notice">
            {t("collaborationHumanNotice")}
          </p>
        </>
      ) : null}

      {tab === "comments" ? (
        <CommentsPanel
          editScope={comments.editScope}
          mode={comments.mode}
          rows={comments.rows}
          draft={comments.draft}
          stagedAttachments={comments.stagedAttachments}
          loading={comments.loading}
          loadingMore={comments.loadingMore}
          hasMore={comments.hasMore}
          submitting={comments.submitting}
          actionError={comments.actionError}
          canCompose={comments.canCompose}
          autoFocusComposer={autoFocusComposer}
          compact={commentsOnly}
          showHeader={commentsOnly}
          t={t}
          onDraftBodyChange={comments.setDraftBody}
          onShowPreviewChange={comments.setShowPreview}
          onLoadMore={comments.loadMore}
          onRefresh={comments.refresh}
          onSubmit={comments.submitComment}
          onEdit={comments.editComment}
          onTombstone={comments.tombstoneComment}
          onReadAttachment={comments.readAttachment}
          onStageFiles={comments.stageFiles}
          onCancelAttachment={comments.cancelAttachment}
          onRemoveAttachment={comments.removeAttachment}
        />
      ) : (
        <ActivityPanel
          mode={activity.mode}
          rows={activity.rows}
          loading={activity.loading}
          loadingMore={activity.loadingMore}
          hasMore={activity.hasMore}
          actionError={activity.actionError}
          t={t}
          onLoadMore={activity.loadMore}
          onRefresh={activity.refresh}
        />
      )}
    </section>
  );
}
