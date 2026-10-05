import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { MessageSquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useCommentPopoverDismissal } from "../hooks/useCommentPopoverDismissal";
import type { createTranslator } from "../i18n";
import { WorkItemCollaborationPanel } from "./WorkItemCollaborationPanel";

type WorkItemCommentPopoverProps = {
  workItem: WorkItemRef;
  commentCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  t: ReturnType<typeof createTranslator>;
  className?: string;
};

export function WorkItemCommentPopover({
  workItem,
  commentCount,
  open,
  onOpenChange,
  t,
  className
}: WorkItemCommentPopoverProps) {
  const { triggerRef, contentRef } = useCommentPopoverDismissal(open, onOpenChange);
  const label =
    commentCount > 0
      ? t("commentsViewCount").replace("{count}", String(commentCount))
      : t("commentsAdd");

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          size="icon-sm"
          variant="ghost"
          className={cn(
            "nodrag nowheel relative text-muted-foreground hover:text-foreground",
            commentCount > 0 && "text-blue-600 dark:text-blue-400",
            className
          )}
          aria-label={label}
          title={label}
          data-graph-interaction="work-item-comments"
          data-testid="work-item-comments-trigger"
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <MessageSquareIcon data-icon="inline-start" />
          {commentCount > 0 ? (
            <span
              className="absolute -right-1 -top-1 min-w-4 rounded-full bg-blue-600 px-1 text-center text-[9px] font-semibold leading-4 text-white"
              data-testid="work-item-comments-count"
            >
              {commentCount > 99 ? "99+" : commentCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="end"
        className="nodrag nowheel w-[min(420px,calc(100vw-32px))] p-3"
        data-testid="work-item-comments-popover"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <WorkItemCollaborationPanel
          workItem={workItem}
          t={t}
          open={open}
          commentsOnly
          autoFocusComposer
        />
      </PopoverContent>
    </Popover>
  );
}
