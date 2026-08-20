import type { DesktopBlockPreview } from "@planweave-ai/runtime";
import { MessageSquareIcon, PlayIcon, ScanSearchIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from "@/components/ui/context-menu";
import type { CompactAssigneeChip } from "../collaboration/assigneeSurfaceViewModels";
import { CompactAssigneeChipView } from "../team/CompactAssigneeChip";
import { WorkItemCommentPopover } from "../team/WorkItemCommentPopover";
import type { createTranslator } from "../i18n";
import type { TaskNodeData } from "../types";
import { statusVariant } from "../viewHelpers";

export function BlockPreviewButton({
  assigneeChip = null,
  block,
  commentUi = null,
  labels,
  onDelete,
  onInspect,
  onRun,
  onSelect,
  runtimeOperationsAllowed,
  runtimeStatusKnown,
  selectedBlockRef
}: {
  assigneeChip?: CompactAssigneeChip | null;
  block: DesktopBlockPreview;
  commentUi?: {
    canvasId: string;
    commentCount: number;
    t: ReturnType<typeof createTranslator>;
  } | null;
  labels: TaskNodeData["labels"];
  onDelete: (ref: string) => void;
  onInspect: (ref: string) => void;
  onRun: (ref: string) => void;
  onSelect: (ref: string) => void;
  runtimeOperationsAllowed: boolean;
  runtimeStatusKnown: boolean;
  selectedBlockRef: string | null;
}) {
  const isSelected = selectedBlockRef === block.ref;
  const [commentsOpen, setCommentsOpen] = useState(false);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="flex h-7 items-center justify-between gap-2 rounded-md border bg-background px-2 text-left text-xs hover:bg-muted data-[selected=true]:border-foreground"
          data-selected={isSelected}
        >
          <button
            className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
            data-block-id={block.blockId}
            data-block-ref={block.ref}
            data-testid="task-node-block"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onSelect(block.ref);
            }}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate">{block.title}</span>
              {assigneeChip ? (
                <CompactAssigneeChipView chip={assigneeChip} label={labels.assignee} />
              ) : null}
            </span>
            <Badge
              className="shrink-0"
              data-runtime-status-known={runtimeStatusKnown ? "true" : "false"}
              title={runtimeStatusKnown ? block.status : labels.runtimeStatusUnavailable}
              variant={runtimeStatusKnown ? statusVariant[block.status] : "outline"}
            >
              {runtimeStatusKnown
                ? block.blockId
                : `${block.blockId} · ${labels.runtimeStatusUnavailable}`}
            </Badge>
          </button>
          {commentUi ? (
            <WorkItemCommentPopover
              className="-mr-1 size-6"
              workItem={{
                kind: "block",
                canvasId: commentUi.canvasId,
                blockRef: block.ref
              }}
              commentCount={commentUi.commentCount}
              open={commentsOpen}
              onOpenChange={setCommentsOpen}
              t={commentUi.t}
            />
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onInspect(block.ref)}>
          <ScanSearchIcon data-icon="inline-start" />
          {labels.inspectBlock}
        </ContextMenuItem>
        {commentUi ? (
          <ContextMenuItem onSelect={() => setCommentsOpen(true)}>
            <MessageSquareIcon data-icon="inline-start" />
            {commentUi.commentCount > 0
              ? commentUi.t("commentsViewCount").replace("{count}", String(commentUi.commentCount))
              : commentUi.t("commentsAdd")}
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem disabled={!runtimeOperationsAllowed} onSelect={() => onRun(block.ref)}>
          <PlayIcon data-icon="inline-start" />
          {labels.runBlock}
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => onDelete(block.ref)}>
          <Trash2Icon data-icon="inline-start" />
          {labels.deleteBlock}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
