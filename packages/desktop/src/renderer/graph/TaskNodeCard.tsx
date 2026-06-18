import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { MouseEvent } from "react";
import { MessageSquareWarningIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { TaskFlowNode } from "../types";
import { BlockPreviewButton } from "./BlockPreviewButton";
import { taskNodeStatusVisual, TaskNodeStatusMarker } from "./taskNodeStatus";

export const taskNodeSelectedClassName = "outline-2 outline-offset-2 outline-state-selected";

export function TaskNodeCard({ data, selected }: NodeProps<TaskFlowNode>) {
  const {
    task,
    titleDraft,
    promptDraft,
    saveState,
    executorOptions,
    labels,
    selectedBlock,
    onTitleChange,
    onTitleSave,
    onExecutorChange,
    onPromptChange,
    onPromptSave,
    onBlockSelect,
    onTaskOpen,
    onAutoRunScopeStart,
    onTaskDelete,
    onBlockDelete
  } = data;
  const hasException = task.exceptions.length > 0;
  const selectedExecutor = task.executorLabel === "Mixed" ? "__custom" : task.executorLabel;
  const taskExecutorOptions =
    selectedExecutor !== "__custom" && selectedExecutor && !executorOptions.includes(selectedExecutor) ? [selectedExecutor, ...executorOptions] : executorOptions;
  const statusVisual = taskNodeStatusVisual(task.status, hasException);
  const handleTaskDoubleClick = (event: MouseEvent) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("button, [role='combobox'], [role='menuitem']")) {
      return;
    }
    onTaskOpen(task.taskId);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Card
          className={cn(
            "h-auto min-h-[220px] w-[320px] border transition-[border-color,box-shadow] duration-[var(--motion-duration-fast)] ease-[var(--motion-ease-standard)]",
            statusVisual.cardClassName,
            selected ? taskNodeSelectedClassName : null
          )}
          size="sm"
          onDoubleClick={handleTaskDoubleClick}
        >
          <Handle type="target" position={Position.Left} />
          <CardHeader className="min-h-12">
            <CardTitle className="flex min-w-0 items-center justify-between gap-2">
              <Input
                aria-label={`${task.taskId} title`}
                className="h-8 min-w-0 flex-1 border-transparent bg-transparent px-1 font-semibold text-text-strong shadow-none placeholder:text-text-faint focus-visible:border-state-selected/40 focus-visible:bg-surface-base"
                value={titleDraft}
                onChange={(event) => onTitleChange(task.taskId, event.target.value)}
                onBlur={() => onTitleSave(task.taskId)}
              />
              <TaskNodeStatusMarker hasException={hasException} label={hasException ? labels.exception : task.status} status={task.status} />
            </CardTitle>
            <CardDescription className="flex items-center gap-2">
              <Select value={selectedExecutor} onValueChange={(value) => onExecutorChange(task.taskId, value)}>
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
                      <SelectItem value={executor} key={executor}>
                        {executor}
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
                        <div className="rounded-md border border-state-failed/35 bg-state-failed-surface p-2" key={`${exception.ref}-${exception.source}`}>
                          <div className="text-sm font-medium text-text-strong">{exception.ref}</div>
                          <div className="text-xs text-text-muted">{exception.reason}</div>
                        </div>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              ) : null}
            </CardAction>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-2.5">
            <div className="flex flex-col gap-1">
              <div className="text-xs font-medium text-text-muted">{labels.taskPrompt}</div>
              <Textarea
                aria-label={`${task.taskId} prompt`}
                className="h-16 resize-none border-border/80 bg-surface-base text-xs text-text shadow-none placeholder:text-text-faint focus-visible:border-state-selected/40"
                value={promptDraft}
                onChange={(event) => onPromptChange(task.taskId, event.target.value)}
                onBlur={() => onPromptSave(task.taskId)}
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
                    onRun={(ref) => void onAutoRunScopeStart({ kind: "block", blockRef: ref })}
                    onSelect={onBlockSelect}
                    selectedBlockRef={selectedBlock?.ref ?? null}
                  />
                ))}
              </div>
            </div>
          </CardContent>
          <Handle type="source" position={Position.Right} />
        </Card>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => void onAutoRunScopeStart({ kind: "task", taskId: task.taskId })}>
          {labels.runTask}
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => onTaskDelete(task.taskId)}>
          {labels.deleteTask}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
