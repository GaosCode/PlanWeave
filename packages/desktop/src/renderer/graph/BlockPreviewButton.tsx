import type { DesktopBlockPreview } from "@planweave-ai/runtime";
import { Badge } from "@/components/ui/badge";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from "@/components/ui/context-menu";
import type { TaskNodeData } from "../types";
import { statusVariant } from "../viewHelpers";

export function BlockPreviewButton({
  block,
  labels,
  onDelete,
  onInspect,
  onRun,
  onSelect,
  selectedBlockRef
}: {
  block: DesktopBlockPreview;
  labels: TaskNodeData["labels"];
  onDelete: (ref: string) => void;
  onInspect: (ref: string) => void;
  onRun: (ref: string) => void;
  onSelect: (ref: string) => void;
  selectedBlockRef: string | null;
}) {
  const isSelected = selectedBlockRef === block.ref;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          className="flex h-7 items-center justify-between gap-2 rounded-md border bg-background px-2 text-left text-xs hover:bg-muted data-[selected=true]:border-foreground"
          data-selected={isSelected}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onSelect(block.ref);
          }}
        >
          <span className="min-w-0 truncate">{block.title}</span>
          <Badge className="shrink-0" variant={statusVariant[block.status]}>
            {block.blockId}
          </Badge>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onInspect(block.ref)}>
          {labels.inspectBlock}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onRun(block.ref)}>{labels.runBlock}</ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => onDelete(block.ref)}>
          {labels.deleteBlock}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
