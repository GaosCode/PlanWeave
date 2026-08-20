import { Handle, Position, type NodeProps } from "@xyflow/react";
import { type CSSProperties, type KeyboardEvent, useState } from "react";
import {
  ClipboardIcon,
  FolderOpenIcon,
  MessageSquareIcon,
  MessageSquareWarningIcon,
  PlayIcon,
  ScanSearchIcon,
  Trash2Icon
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger
} from "@/components/ui/popover";
import { AgentEndpointSelect } from "../collaboration/AgentEndpointSelect";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { TaskFlowNode } from "../types";
import { BlockPreviewButton } from "./BlockPreviewButton";
import { CompactAssigneeChipView } from "../team/CompactAssigneeChip";
import { WorkItemCommentPopover } from "../team/WorkItemCommentPopover";
import { SharedResourceBadges } from "./sharedResourceBadges";
import { sharedResourceColor } from "./sharedResourceColors";
import { taskNodeStatusVisual, TaskNodeStatusMarker } from "./taskNodeStatus";

export const taskNodeSelectedClassName = "outline-2 outline-offset-2 outline-state-selected";

const taskDependencyHandleClassName = "size-3 border-2 border-surface-base bg-text-strong";
const taskDependencySourceHandleTopPercent = 44;
const taskDependencyTargetHandleTopPercent = 56;

function taskDependencyHandleStyle(topPercent: number): CSSProperties {
  return { top: `${topPercent}%` };
}

export function TaskNodeCard({ data, selected }: NodeProps<TaskFlowNode>) {
  const {
    task,
    titleDraft,
    promptDraft,
    saveState,
    agentEndpoints,
    agentEndpointFleetCatalogError = null,
    selectedAgentEndpointId,
    labels,
    selectedBlock,
    sharedResources = [],
    activeSharedResources = new Set(),
    highlightedResource = null,
    resourceHighlighted = false,
    dimmed = false,
    transitionEpochByResource = {},
    assigneeChip = null,
    blockAssigneeChips = {},
    commentUi = null,
    runtimeOperationsAllowed,
    runtimeStatusKnown,
    onTitleChange,
    onTitleSave,
    onAgentEndpointChange,
    onPromptChange,
    onPromptHistoryRedo,
    onPromptHistoryUndo,
    onPromptSave,
    onBlockSelect,
    onBlockWorkspaceOpen,
    onTaskOpen,
    onAgentPromptCopy,
    onRevealTaskInFinder,
    onAutoRunScopeStart,
    onTaskDelete,
    onBlockDelete,
    onResourceHover = () => undefined,
    onResourcePin = () => undefined,
    onResourceOverflow = () => undefined
  } = data;
  const [taskCommentsOpen, setTaskCommentsOpen] = useState(false);
  const hasException = task.exceptions.length > 0;
  const statusVisual = taskNodeStatusVisual(
    runtimeStatusKnown ? task.status : "unknown",
    runtimeStatusKnown && hasException
  );
  const highlightColor =
    resourceHighlighted && highlightedResource
      ? sharedResourceColor(highlightedResource).dot
      : null;
  const statusLabel = runtimeStatusKnown
    ? hasException
      ? labels.exception
      : task.status
    : labels.runtimeStatusUnavailable;
  const handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const key = event.key.toLowerCase();
    const isUndo = (event.metaKey || event.ctrlKey) && !event.shiftKey && key === "z";
    const isRedo =
      ((event.metaKey || event.ctrlKey) && event.shiftKey && key === "z") ||
      (event.ctrlKey && !event.metaKey && key === "y");
    if (!isUndo && !isRedo) {
      return;
    }
    if (promptDraft !== task.promptMarkdown) {
      return;
    }
    event.preventDefault();
    void (isUndo ? onPromptHistoryUndo() : onPromptHistoryRedo());
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Card
          className={cn(
            "h-auto min-h-[220px] w-[320px] border transition-[border-color,box-shadow,opacity] duration-[var(--motion-duration-fast)] ease-[var(--motion-ease-standard)]",
            statusVisual.cardClassName,
            selected ? taskNodeSelectedClassName : null,
            resourceHighlighted ? "ring-2" : null,
            dimmed ? "opacity-40" : null
          )}
          data-resource-highlighted={resourceHighlighted ? "true" : "false"}
          data-dimmed={dimmed ? "true" : "false"}
          data-task-id={task.taskId}
          data-testid="task-node-card"
          size="sm"
          style={
            highlightColor
              ? ({
                  ["--shared-resource-highlight-color" as string]: highlightColor,
                  boxShadow: `0 0 0 2px ${highlightColor}`
                } as CSSProperties)
              : undefined
          }
        >
          <Handle
            className={taskDependencyHandleClassName}
            data-graph-interaction="dependency-handle"
            onClick={(event) => event.stopPropagation()}
            type="target"
            position={Position.Left}
            style={taskDependencyHandleStyle(taskDependencyTargetHandleTopPercent)}
          />
          <CardHeader className="min-h-12">
            <CardTitle className="flex min-w-0 items-center justify-between gap-2">
              <Input
                aria-label={`${task.taskId} title`}
                className="h-8 min-w-0 flex-1 border-transparent bg-transparent px-1 font-semibold text-text-strong shadow-none placeholder:text-text-faint focus-visible:border-state-selected/40 focus-visible:bg-surface-base"
                value={titleDraft}
                onChange={(event) => onTitleChange(task.taskId, event.target.value)}
                onBlur={() => onTitleSave(task.taskId)}
              />
              <TaskNodeStatusMarker
                hasException={runtimeStatusKnown && hasException}
                label={statusLabel}
                status={runtimeStatusKnown ? task.status : "unknown"}
              />
            </CardTitle>
            <CardDescription className="flex flex-wrap items-center gap-2">
              <div className="flex min-w-0 flex-col gap-1">
                <AgentEndpointSelect
                  ariaLabel={labels.agent}
                  endpoints={agentEndpoints}
                  onValueChange={(value) => onAgentEndpointChange(task.taskId, value)}
                  selectedEndpointId={selectedAgentEndpointId}
                  selectedUnknownLabel={
                    selectedAgentEndpointId === "__custom" ? labels.customExecutor : undefined
                  }
                  triggerClassName="h-7 w-32 border-border/80 bg-surface-base text-xs text-text shadow-none"
                  unavailableLabel={labels.unavailable}
                />
                {agentEndpointFleetCatalogError ? (
                  <p
                    className="max-w-48 text-[10px] leading-snug text-destructive"
                    data-testid="agent-endpoint-fleet-catalog-error"
                    role="alert"
                  >
                    {agentEndpointFleetCatalogError}
                  </p>
                ) : null}
              </div>
              {assigneeChip ? (
                <CompactAssigneeChipView chip={assigneeChip} label={labels.assignee} size="sm" />
              ) : null}
            </CardDescription>
            <CardAction className="flex items-center gap-1">
              {commentUi ? (
                <WorkItemCommentPopover
                  workItem={{
                    kind: "task",
                    canvasId: commentUi.canvasId,
                    taskId: task.taskId
                  }}
                  commentCount={commentUi.taskCommentCount}
                  open={taskCommentsOpen}
                  onOpenChange={setTaskCommentsOpen}
                  t={commentUi.t}
                />
              ) : null}
              {hasException ? (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button size="icon-sm" variant="destructive" aria-label={labels.taskException}>
                      <MessageSquareWarningIcon data-icon="inline-start" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-80">
                    <PopoverHeader>
                      <PopoverTitle>{labels.exceptionOverlay}</PopoverTitle>
                      <PopoverDescription>{task.taskId}</PopoverDescription>
                    </PopoverHeader>
                    <div className="flex flex-col gap-2">
                      {task.exceptions.map((exception) => (
                        <div
                          className="rounded-md border border-state-failed/35 bg-state-failed-surface p-2"
                          key={`${exception.ref}-${exception.source}`}
                        >
                          <div className="text-sm font-medium text-text-strong">
                            {exception.ref}
                          </div>
                          <div className="text-xs text-text-muted">{exception.reason}</div>
                        </div>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              ) : null}
            </CardAction>
          </CardHeader>
          {sharedResources.length > 0 ? (
            <SharedResourceBadges
              resources={sharedResources}
              activeResources={activeSharedResources}
              highlightedResource={highlightedResource}
              transitionEpochByResource={transitionEpochByResource}
              labels={{
                sharedResource: labels.sharedResource,
                sharedResourceActive: labels.sharedResourceActive,
                moreResources: labels.moreResources
              }}
              onResourceHover={onResourceHover}
              onResourcePin={onResourcePin}
              onOverflowOpen={() => onResourceOverflow(task.taskId)}
            />
          ) : null}
          <CardContent className="flex min-h-0 flex-1 flex-col gap-2.5">
            <div className="flex flex-col gap-1">
              <div className="text-xs font-medium text-text-muted">{labels.taskPrompt}</div>
              <Textarea
                aria-label={`${task.taskId} prompt`}
                className="h-16 resize-none border-border/80 bg-surface-base text-xs text-text shadow-none placeholder:text-text-faint focus-visible:border-state-selected/40"
                value={promptDraft}
                onChange={(event) => onPromptChange(task.taskId, event.target.value)}
                onBlur={() => onPromptSave(task.taskId)}
                onKeyDown={handlePromptKeyDown}
              />
              <div className="text-xs text-text-faint">{saveState}</div>
            </div>
            <div className="flex min-h-0 flex-col gap-1">
              <div className="flex items-center justify-between gap-2 text-xs font-medium text-text-muted">
                <span>{labels.blockStack}</span>
              </div>
              <div className="flex flex-col gap-1">
                {task.blocks.map((block) => (
                  <BlockPreviewButton
                    assigneeChip={blockAssigneeChips[block.ref] ?? null}
                    block={block}
                    key={block.ref}
                    labels={labels}
                    onDelete={onBlockDelete}
                    onInspect={onBlockSelect}
                    onRun={(ref) => void onAutoRunScopeStart({ kind: "block", blockRef: ref })}
                    runtimeOperationsAllowed={runtimeOperationsAllowed}
                    runtimeStatusKnown={runtimeStatusKnown}
                    onSelect={onBlockWorkspaceOpen}
                    selectedBlockRef={selectedBlock?.ref ?? null}
                    commentUi={
                      commentUi
                        ? {
                            canvasId: commentUi.canvasId,
                            commentCount: commentUi.blockCommentCounts[block.ref] ?? 0,
                            t: commentUi.t
                          }
                        : null
                    }
                  />
                ))}
              </div>
            </div>
          </CardContent>
          <Handle
            className={taskDependencyHandleClassName}
            data-graph-interaction="dependency-handle"
            onClick={(event) => event.stopPropagation()}
            type="source"
            position={Position.Right}
            style={taskDependencyHandleStyle(taskDependencySourceHandleTopPercent)}
          />
        </Card>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onTaskOpen(task.taskId)}>
          <ScanSearchIcon data-icon="inline-start" />
          {labels.inspectTask}
        </ContextMenuItem>
        {commentUi ? (
          <ContextMenuItem onSelect={() => setTaskCommentsOpen(true)}>
            <MessageSquareIcon data-icon="inline-start" />
            {commentUi.taskCommentCount > 0
              ? commentUi
                  .t("commentsViewCount")
                  .replace("{count}", String(commentUi.taskCommentCount))
              : commentUi.t("commentsAdd")}
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem onSelect={() => onAgentPromptCopy(task.taskId)}>
          <ClipboardIcon data-icon="inline-start" />
          {labels.copyAgentPrompt}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onRevealTaskInFinder(task.taskId)}>
          <FolderOpenIcon data-icon="inline-start" />
          {labels.openTaskInFileManager}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!runtimeOperationsAllowed}
          onSelect={() => void onAutoRunScopeStart({ kind: "task", taskId: task.taskId })}
        >
          <PlayIcon data-icon="inline-start" />
          {labels.runTask}
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => onTaskDelete(task.taskId)}>
          <Trash2Icon data-icon="inline-start" />
          {labels.deleteTask}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
