import { Handle, Position, type NodeProps } from "@xyflow/react";
import { type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import {
  ClipboardIcon,
  FolderOpenIcon,
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { buildExecutorOptionViews, executorOptionName } from "../executors/executorOptionViewModel";
import type { TaskFlowNode } from "../types";
import { BlockPreviewButton } from "./BlockPreviewButton";
import { LockBadges } from "./lockBadges";
import { lockColor } from "./lockColors";
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
    agentDetections,
    agentTransport,
    executorOptions,
    packageExecutorNames,
    labels,
    selectedBlock,
    locks = [],
    lockStates = {},
    dispatchState = { kind: "none" },
    highlightedLock = null,
    lockHighlighted = false,
    dimmed = false,
    releaseEpochByLock = {},
    onTitleChange,
    onTitleSave,
    onExecutorChange,
    onPromptChange,
    onPromptHistoryRedo,
    onPromptHistoryUndo,
    onPromptSave,
    onBlockSelect,
    onBlockWorkspaceOpen,
    onTaskOpen,
    onTaskWorkspaceOpen,
    onAgentPromptCopy,
    onRevealTaskInFinder,
    onAutoRunScopeStart,
    onTaskDelete,
    onBlockDelete,
    onLockHover = () => undefined,
    onLockPin = () => undefined,
    onLockOverflow = () => undefined,
    onJumpToTask = () => undefined
  } = data;
  const hasException = task.exceptions.length > 0;
  const waiting = dispatchState.kind === "waiting";
  const selectedExecutor =
    task.executorLabel === "Mixed"
      ? "__custom"
      : executorOptionName(task.executorLabel, packageExecutorNames);
  const taskExecutorOptions = buildExecutorOptionViews({
    agentDetections,
    agentTransport,
    literalExecutorNames: packageExecutorNames,
    currentExecutorNames:
      selectedExecutor !== "__custom" && selectedExecutor ? [selectedExecutor] : [],
    executorOptions
  });
  const statusVisual = taskNodeStatusVisual(task.status, hasException, { waiting });
  const highlightColor = lockHighlighted && highlightedLock ? lockColor(highlightedLock).dot : null;
  const statusLabel = hasException
    ? labels.exception
    : waiting
      ? labels.waitingForResource
      : task.status;
  const handleTaskClick = (event: MouseEvent) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest("button, input, textarea, select, a, [role='combobox'], [role='menuitem']")
    ) {
      return;
    }
    onTaskWorkspaceOpen(task.taskId);
  };
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
            lockHighlighted ? "ring-2" : null,
            dimmed ? "opacity-40" : null
          )}
          data-lock-highlighted={lockHighlighted ? "true" : "false"}
          data-dimmed={dimmed ? "true" : "false"}
          data-testid="task-node-card"
          size="sm"
          style={
            highlightColor
              ? ({
                  ["--lock-highlight-color" as string]: highlightColor,
                  boxShadow: `0 0 0 2px ${highlightColor}`
                } as CSSProperties)
              : undefined
          }
          onClick={handleTaskClick}
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
                hasException={hasException}
                label={statusLabel}
                status={task.status}
                waiting={waiting}
              />
            </CardTitle>
            <CardDescription className="flex items-center gap-2">
              <Select
                value={selectedExecutor}
                onValueChange={(value) => onExecutorChange(task.taskId, value)}
              >
                <SelectTrigger className="h-7 w-28 border-border/80 bg-surface-base text-xs text-text shadow-none">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {selectedExecutor === "__custom" ? (
                      <SelectItem value="__custom" disabled>
                        {labels.customExecutor}
                      </SelectItem>
                    ) : null}
                    {taskExecutorOptions.map((executor) => (
                      <SelectItem
                        disabled={executor.disabled}
                        value={executor.name}
                        key={executor.name}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span>{executor.label}</span>
                          {executor.disabled ? (
                            <span className="text-xs text-muted-foreground">
                              {labels.unavailable}
                            </span>
                          ) : null}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </CardDescription>
            <CardAction>
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
          {locks.length > 0 ? (
            <LockBadges
              locks={locks}
              lockStates={lockStates}
              dispatchState={dispatchState}
              highlightedLock={highlightedLock}
              releaseEpochByLock={releaseEpochByLock}
              labels={{
                exclusiveLock: labels.exclusiveLock,
                heldBy: labels.heldBy,
                waitingForResource: labels.waitingForResource,
                moreLocks: labels.moreLocks
              }}
              onLockHover={onLockHover}
              onLockPin={onLockPin}
              onOverflowOpen={() => onLockOverflow(task.taskId)}
              onJumpToTask={onJumpToTask}
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
                    block={block}
                    key={block.ref}
                    labels={labels}
                    onDelete={onBlockDelete}
                    onInspect={onBlockSelect}
                    onRun={(ref) => void onAutoRunScopeStart({ kind: "block", blockRef: ref })}
                    onSelect={onBlockWorkspaceOpen}
                    selectedBlockRef={selectedBlock?.ref ?? null}
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
        <ContextMenuItem onSelect={() => onAgentPromptCopy(task.taskId)}>
          <ClipboardIcon data-icon="inline-start" />
          {labels.copyAgentPrompt}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onRevealTaskInFinder(task.taskId)}>
          <FolderOpenIcon data-icon="inline-start" />
          {labels.openTaskInFileManager}
        </ContextMenuItem>
        <ContextMenuItem
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
