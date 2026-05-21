import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  type Connection,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  useEdgesState,
  useNodesState
} from "@xyflow/react";
import {
  ActivityIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BellIcon,
  ChartNoAxesColumnIncreasingIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleIcon,
  ComponentIcon,
  FilePlus2Icon,
  FolderOpenIcon,
  GitBranchIcon,
  LanguagesIcon,
  MessageSquareWarningIcon,
  MoveIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  SettingsIcon,
  SquareIcon,
  Trash2Icon
} from "lucide-react";
import type {
  BlockType,
  DesktopBlockDetail,
  DesktopBlockPreview,
  DesktopBlockRunRecordSummary,
  DesktopBridgeApi,
  DesktopAutoRunScope,
  DesktopAutoRunState,
  DesktopContextNodeViewModel,
  DesktopFeedbackRecord,
  DesktopGraphViewModel,
  DesktopLayout,
  DesktopPackageFileChangeEvent,
  DesktopProjectSummary,
  DesktopReviewAttemptSummary,
  DesktopReviewPipeline,
  DesktopReviewPipelineStepInput,
  DesktopRunRecord,
  DesktopSearchResult,
  DesktopStatistics,
  DesktopTaskDraft,
  DesktopTaskDraftMode,
  DesktopTaskNodeViewModel,
  DesktopTodoGroups,
  DesktopTodoItem
} from "@planweave/runtime";
import { Badge } from "@/components/ui/badge";
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
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel
} from "@/components/ui/field";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { createTranslator, type Language } from "./i18n";

type TaskNodeData = {
  task: DesktopTaskNodeViewModel;
  titleDraft: string;
  promptDraft: string;
  saveState: "idle" | "saving" | "saved" | "error";
  executorOptions: string[];
  labels: {
    blockStack: string;
    exception: string;
    exceptionOverlay: string;
    inherit: string;
    more: string;
    noBlockRecords: string;
    openRecord: string;
    savePrompt: string;
    selectedBlock: string;
    sourcePrompt: string;
    taskException: string;
    taskPrompt: string;
    title: string;
    agent: string;
    effectiveExecutor: string;
    blockExecutionSummary: string;
    latestRun: string;
    latestReviewAttempt: string;
    feedbackMarker: string;
    manualExecutor: string;
  };
  selectedBlock: DesktopBlockDetail | null;
  blockRunRecords: DesktopBlockRunRecordSummary[];
  blockReviewAttempts: DesktopReviewAttemptSummary[];
  blockFeedbackRecords: DesktopFeedbackRecord[];
  onTitleChange: (taskId: string, value: string) => void;
  onTitleSave: (taskId: string) => void;
  onExecutorChange: (taskId: string, executorName: string | null) => void;
  onPromptChange: (taskId: string, value: string) => void;
  onPromptSave: (taskId: string) => void;
  onBlockSelect: (ref: string) => void;
  onSelectedBlockChange: (block: DesktopBlockDetail) => void;
  onBlockTitleSave: () => void;
  onBlockExecutorChange: (executorName: string | null) => void;
  onBlockPromptSave: () => void;
  onOpenRunRecord: (recordId: string | null | undefined) => void;
};

type TaskFlowNode = Node<TaskNodeData, "task">;
type ContextNodeData = {
  node: DesktopContextNodeViewModel;
  selected: boolean;
};
type ContextFlowNode = Node<ContextNodeData, "context">;
type AppFlowNode = TaskFlowNode | ContextFlowNode;
type PaletteDropPosition = { x: number; y: number };
type FloatingControlPosition = { left: number; top: number };
type FloatingControlDrag = {
  pointerId: number;
  offsetX: number;
  offsetY: number;
  containerLeft: number;
  containerTop: number;
  minLeft: number;
  minTop: number;
  maxLeft: number;
  maxTop: number;
};

const bridge: DesktopBridgeApi | null = typeof window !== "undefined" && "planweave" in window ? window.planweave : null;

const statusVariant = {
  planned: "outline",
  ready: "secondary",
  in_progress: "default",
  implemented: "secondary",
  completed: "secondary",
  needs_changes: "destructive",
  blocked: "destructive",
  diverged: "destructive"
} as const;

function statusIcon(status: string) {
  if (status === "implemented" || status === "completed") {
    return <CheckCircle2Icon />;
  }
  if (status === "blocked" || status === "diverged" || status === "needs_changes") {
    return <CircleAlertIcon />;
  }
  if (status === "in_progress") {
    return <ActivityIcon />;
  }
  return <CircleIcon />;
}

function defaultBlockTitleForUi(type: BlockType, t: ReturnType<typeof createTranslator>): string {
  if (type === "check") {
    return t("defaultCheckBlockTitle");
  }
  if (type === "review") {
    return t("defaultReviewBlockTitle");
  }
  return t("defaultImplementationBlockTitle");
}

function TaskNodeCard({ data }: NodeProps<TaskFlowNode>) {
  const {
    task,
    titleDraft,
    promptDraft,
    saveState,
    executorOptions,
    labels,
    selectedBlock,
    blockRunRecords,
    blockReviewAttempts,
    blockFeedbackRecords,
    onTitleChange,
    onTitleSave,
    onExecutorChange,
    onPromptChange,
    onPromptSave,
    onBlockSelect,
    onSelectedBlockChange,
    onBlockTitleSave,
    onBlockExecutorChange,
    onBlockPromptSave,
    onOpenRunRecord
  } = data;
  const hasException = task.exceptions.length > 0;

  return (
    <Card className="h-[260px] w-[340px] border bg-card shadow-sm" size="sm">
      <Handle type="target" position={Position.Left} />
      <CardHeader className="min-h-14">
        <CardTitle className="flex min-w-0 items-center gap-2">
          <Input
            aria-label={`${task.taskId} title`}
            className="h-8 min-w-0 border-transparent px-1 font-semibold shadow-none"
            value={titleDraft}
            onChange={(event) => onTitleChange(task.taskId, event.target.value)}
            onBlur={() => onTitleSave(task.taskId)}
          />
        </CardTitle>
        <CardDescription className="flex items-center gap-2">
          <Badge variant={hasException ? "destructive" : statusVariant[task.status]}>
            {statusIcon(hasException ? "blocked" : task.status)}
            {hasException ? labels.exception : task.status}
          </Badge>
          <Select value={task.executor ?? "__inherit"} onValueChange={(value) => onExecutorChange(task.taskId, value === "__inherit" ? null : value)}>
            <SelectTrigger className="h-7 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="__inherit">{labels.inherit}</SelectItem>
                {executorOptions.map((executor) => (
                  <SelectItem value={executor} key={executor}>
                    {executor}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Badge variant="outline">{task.executorLabel}</Badge>
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
                    <div className="rounded-md border bg-muted/40 p-2" key={`${exception.ref}-${exception.source}`}>
                      <div className="text-sm font-medium">{exception.ref}</div>
                      <div className="text-xs text-muted-foreground">{exception.reason}</div>
                    </div>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <div className="text-xs font-medium text-muted-foreground">{labels.taskPrompt}</div>
          <Textarea
            aria-label={`${task.taskId} prompt`}
            className="h-20 resize-none"
            value={promptDraft}
            onChange={(event) => onPromptChange(task.taskId, event.target.value)}
            onBlur={() => onPromptSave(task.taskId)}
          />
          <div className="text-xs text-muted-foreground">{saveState}</div>
        </div>
        <div className="flex min-h-0 flex-col gap-1">
          <div className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
            <span>{labels.blockStack}</span>
            {task.overflowBlockCount > 0 ? <span>+{task.overflowBlockCount} {labels.more}</span> : null}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-hidden">
            {task.blockPreview.map((block) => (
              <BlockPreviewButton
                block={block}
                blockFeedbackRecords={blockFeedbackRecords}
                blockReviewAttempts={blockReviewAttempts}
                blockRunRecords={blockRunRecords}
                executorOptions={executorOptions}
                key={block.ref}
                labels={labels}
                onBlockExecutorChange={onBlockExecutorChange}
                onBlockPromptSave={onBlockPromptSave}
                onBlockTitleSave={onBlockTitleSave}
                onOpenRunRecord={onOpenRunRecord}
                onSelect={onBlockSelect}
                onSelectedBlockChange={onSelectedBlockChange}
                selectedBlock={selectedBlock}
              />
            ))}
          </div>
        </div>
      </CardContent>
      <Handle type="source" position={Position.Right} />
    </Card>
  );
}

function BlockPreviewButton({
  block,
  blockFeedbackRecords,
  blockReviewAttempts,
  blockRunRecords,
  executorOptions,
  labels,
  onBlockExecutorChange,
  onBlockPromptSave,
  onBlockTitleSave,
  onOpenRunRecord,
  onSelect,
  onSelectedBlockChange,
  selectedBlock
}: {
  block: DesktopBlockPreview;
  blockFeedbackRecords: DesktopFeedbackRecord[];
  blockReviewAttempts: DesktopReviewAttemptSummary[];
  blockRunRecords: DesktopBlockRunRecordSummary[];
  executorOptions: string[];
  labels: TaskNodeData["labels"];
  onBlockExecutorChange: (executorName: string | null) => void;
  onBlockPromptSave: () => void;
  onBlockTitleSave: () => void;
  onOpenRunRecord: (recordId: string | null | undefined) => void;
  onSelect: (ref: string) => void;
  onSelectedBlockChange: (block: DesktopBlockDetail) => void;
  selectedBlock: DesktopBlockDetail | null;
}) {
  const [open, setOpen] = useState(false);
  const isSelected = selectedBlock?.ref === block.ref;
  const latestRun = isSelected ? blockRunRecords[0] : null;
  const latestReviewAttempt = isSelected ? blockReviewAttempts[0] : null;
  const latestFeedbackRecord = isSelected ? blockFeedbackRecords[0] : null;

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          onSelect(block.ref);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          className="flex h-7 items-center justify-between gap-2 rounded-md border bg-background px-2 text-left text-xs hover:bg-muted"
          type="button"
          onClick={() => onSelect(block.ref)}
        >
          <span className="min-w-0 truncate">{block.title}</span>
          <Badge variant={statusVariant[block.status]}>{block.type}</Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[420px]">
        <PopoverHeader>
          <PopoverTitle>{labels.selectedBlock}</PopoverTitle>
          <PopoverDescription>{block.ref}</PopoverDescription>
        </PopoverHeader>
        {isSelected && selectedBlock ? (
          <FieldGroup>
            <Field>
              <FieldLabel>{labels.title}</FieldLabel>
              <Input
                value={selectedBlock.title}
                onBlur={onBlockTitleSave}
                onChange={(event) => onSelectedBlockChange({ ...selectedBlock, title: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel>{labels.agent}</FieldLabel>
              <Select value={selectedBlock.executor ?? "__inherit"} onValueChange={(value) => onBlockExecutorChange(value === "__inherit" ? null : value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="__inherit">{labels.inherit}</SelectItem>
                    {executorOptions.map((executor) => (
                      <SelectItem value={executor} key={executor}>
                        {executor}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                {labels.effectiveExecutor}: {selectedBlock.effectiveExecutor ?? labels.manualExecutor}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>{labels.sourcePrompt}</FieldLabel>
              <Textarea
                className="min-h-40 resize-none"
                value={selectedBlock.promptMarkdown}
                onChange={(event) => onSelectedBlockChange({ ...selectedBlock, promptMarkdown: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel>{labels.blockExecutionSummary}</FieldLabel>
              <div className="flex flex-col gap-2 text-xs">
                {latestRun ? (
                  <button
                    className="flex items-center justify-between gap-2 rounded-md border p-2 text-left hover:bg-muted/50"
                    type="button"
                    onClick={() => onOpenRunRecord(latestRun.recordId)}
                  >
                    <span className="min-w-0 truncate">
                      {labels.latestRun}: {latestRun.finishedAt ?? latestRun.startedAt ?? latestRun.runId}
                    </span>
                    <Badge variant={latestRun.exitCode === 0 || latestRun.exitCode === null ? "secondary" : "destructive"}>
                      {latestRun.exitCode ?? "-"}
                    </Badge>
                  </button>
                ) : (
                  <div className="text-muted-foreground">{labels.noBlockRecords}</div>
                )}
                {latestReviewAttempt ? (
                  <div className="rounded-md border p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{labels.latestReviewAttempt}</span>
                      <Badge variant={latestReviewAttempt.verdict === "passed" ? "secondary" : "outline"}>{latestReviewAttempt.verdict ?? "-"}</Badge>
                    </div>
                    <div className="line-clamp-2 text-muted-foreground">{latestReviewAttempt.contentPreview}</div>
                  </div>
                ) : null}
                {latestFeedbackRecord ? (
                  <div className="rounded-md border p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{labels.feedbackMarker}</span>
                      <Badge variant={latestFeedbackRecord.status === "resolved" ? "secondary" : "destructive"}>{latestFeedbackRecord.status}</Badge>
                    </div>
                    <div className="line-clamp-2 text-muted-foreground">{latestFeedbackRecord.content}</div>
                  </div>
                ) : null}
                {selectedBlock.exceptionReason ? <div className="rounded-md border border-destructive p-2 text-destructive">{selectedBlock.exceptionReason}</div> : null}
              </div>
            </Field>
            <Button size="sm" onClick={onBlockPromptSave}>
              {labels.savePrompt}
            </Button>
          </FieldGroup>
        ) : (
          <Skeleton className="h-40 w-full" />
        )}
      </PopoverContent>
    </Popover>
  );
}

function ContextNodeCard({ data }: NodeProps<ContextFlowNode>) {
  const { node, selected } = data;
  return (
    <Card className={`w-[280px] border bg-card shadow-sm ${selected ? "ring-2 ring-ring" : ""}`} size="sm">
      <Handle type="target" position={Position.Left} />
      <CardHeader className="min-h-14">
        <CardTitle className="flex min-w-0 items-center gap-2 text-sm">
          <span className="truncate">{node.title}</span>
        </CardTitle>
        <CardDescription className="flex items-center gap-2">
          <Badge variant="outline">{node.type}</Badge>
          <span className="truncate">{node.nodeId}</span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="line-clamp-4 text-xs text-muted-foreground">{node.summary}</p>
      </CardContent>
      <Handle type="source" position={Position.Right} />
    </Card>
  );
}

type TodoGroupCardLabels = {
  dependencyBlockers: string;
  locks: string;
  noBlockers: string;
  noLocks: string;
  parallelBlocked: string;
  parallelSafe: string;
  parallelSafety: string;
};

export function TodoGroupCard({
  items,
  labels,
  onSelect,
  status
}: {
  status: string;
  items: DesktopTodoItem[];
  labels: TodoGroupCardLabels;
  onSelect: (ref: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{status}</span>
        <Badge variant="outline">{items.length}</Badge>
      </div>
      {items.slice(0, 6).map((item) => (
        <button
          className="flex flex-col gap-2 rounded-md bg-muted/50 px-2 py-2 text-left text-xs"
          key={item.ref}
          type="button"
          onClick={() => onSelect(item.ref)}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium">{item.title}</span>
            <Badge variant={item.parallelSafe ? "secondary" : "destructive"}>{item.parallelSafe ? labels.parallelSafe : labels.parallelBlocked}</Badge>
          </div>
          <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-2 gap-y-1 text-muted-foreground">
            <span>{labels.dependencyBlockers}</span>
            <span className="truncate">{item.dependencyBlockers.length ? item.dependencyBlockers.join(", ") : labels.noBlockers}</span>
            <span>{labels.parallelSafety}</span>
            <span>{item.parallelSafe ? labels.parallelSafe : labels.parallelBlocked}</span>
            <span>{labels.locks}</span>
            <span className="truncate">{item.locks.length ? item.locks.join(", ") : labels.noLocks}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

export type SearchNavigationTarget =
  | { kind: "task"; ref: string }
  | { kind: "block"; ref: string }
  | { kind: "context"; ref: string }
  | { kind: "record"; recordId: string }
  | { kind: "none" };

export function searchNavigationTarget(result: DesktopSearchResult): SearchNavigationTarget {
  const targetRef = result.targetRef ?? result.ref;
  if (result.kind === "run_record") {
    return result.recordId ? { kind: "record", recordId: result.recordId } : { kind: "none" };
  }
  if (targetRef.includes("#")) {
    return { kind: "block", ref: targetRef };
  }
  if (result.kind === "context") {
    return { kind: "context", ref: targetRef };
  }
  if (result.kind === "task" || result.kind === "prompt") {
    return { kind: "task", ref: targetRef };
  }
  return { kind: "none" };
}

export function SearchResultList({
  onOpenResult,
  results,
  targetMissingLabel
}: {
  results: DesktopSearchResult[];
  targetMissingLabel: string;
  onOpenResult: (result: DesktopSearchResult) => void;
}) {
  return (
    <div className="flex flex-col gap-2 pr-2">
      {results.map((result) => {
        const target = searchNavigationTarget(result);
        return (
          <button
            className="flex flex-col gap-1 rounded-lg border p-3 text-left hover:bg-muted/50"
            key={`${result.kind}-${result.ref}`}
            type="button"
            onClick={() => onOpenResult(result)}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium">{result.title}</span>
              <Badge variant={target.kind === "none" ? "destructive" : "outline"}>{result.kind}</Badge>
            </div>
            <div className="line-clamp-2 text-xs text-muted-foreground">{result.excerpt}</div>
            {target.kind === "none" ? <div className="text-xs text-destructive">{targetMissingLabel}</div> : null}
          </button>
        );
      })}
    </div>
  );
}

export function PaletteSettingsPanel({
  labels,
  settings,
  updateSettings
}: {
  settings: DesktopUiSettings;
  labels: {
    blockSetImplementation: string;
    blockSetImplementationCheck: string;
    blockSetImplementationCheckReview: string;
    checkBlock: string;
    componentVisibility: string;
    contextNode: string;
    defaultBlockSet: string;
    disabled: string;
    dragHint: string;
    enabled: string;
    implementationBlock: string;
    paletteSettings: string;
    reviewBlock: string;
    taskNode: string;
  };
  updateSettings: (patch: Partial<DesktopUiSettings>) => void;
}) {
  return (
    <section className="flex flex-col gap-4 border-t pt-4">
      <div className="text-base font-semibold">{labels.paletteSettings}</div>
      <FieldGroup>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
          <Field>
            <FieldLabel>{labels.defaultBlockSet}</FieldLabel>
            <Select
              value={settings.palette.defaultBlockSet.join(",")}
              onValueChange={(value) =>
                updateSettings({
                  palette: {
                    ...settings.palette,
                    defaultBlockSet: value.split(",").filter(Boolean) as BlockType[]
                  }
                })
              }
            >
              <SelectTrigger className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="implementation">{labels.blockSetImplementation}</SelectItem>
                  <SelectItem value="implementation,check">{labels.blockSetImplementationCheck}</SelectItem>
                  <SelectItem value="implementation,check,review">{labels.blockSetImplementationCheckReview}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>{labels.dragHint}</FieldLabel>
            <Select
              value={settings.palette.dragHint ? "enabled" : "disabled"}
              onValueChange={(value) => updateSettings({ palette: { ...settings.palette, dragHint: value === "enabled" } })}
            >
              <SelectTrigger className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="enabled">{labels.enabled}</SelectItem>
                  <SelectItem value="disabled">{labels.disabled}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field>
          <FieldLabel>{labels.componentVisibility}</FieldLabel>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
            {[
              { key: "task", label: labels.taskNode },
              { key: "implementation", label: labels.implementationBlock },
              { key: "check", label: labels.checkBlock },
              { key: "review", label: labels.reviewBlock },
              { key: "context", label: labels.contextNode }
            ].map(({ key, label }) => (
              <Select
                key={key}
                value={settings.palette.visible[key as PaletteComponentKey] ? "enabled" : "disabled"}
                onValueChange={(value) =>
                  updateSettings({
                    palette: {
                      ...settings.palette,
                      visible: {
                        ...settings.palette.visible,
                        [key]: value === "enabled"
                      }
                    }
                  })
                }
              >
                <SelectTrigger className="w-full min-w-0">
                  <SelectValue placeholder={label} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="enabled">{label}</SelectItem>
                    <SelectItem value="disabled">{labels.disabled}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            ))}
          </div>
        </Field>
      </FieldGroup>
    </section>
  );
}

const nodeTypes = {
  task: TaskNodeCard,
  context: ContextNodeCard
};

type AppView = "new-task" | "graph" | "review-pipeline" | "todo" | "statistics" | "search" | "notifications" | "settings";
type AutoRunScopeMode = "project" | "selectedTask" | "selectedBlock";
type AppearanceMode = "system" | "light" | "dark";
type PaletteComponentKey = "task" | "implementation" | "check" | "review" | "context";
type PaletteDropComponent = "task" | "context" | BlockType;
type DesktopUiSettings = {
  runtimePath: string;
  defaultExecutor: string;
  appearance: AppearanceMode;
  language: Language;
  notifications: {
    autoRunFailure: boolean;
    graphExceptions: boolean;
    dirtyPrompts: boolean;
    fileSyncConflict: boolean;
  };
  palette: {
    visible: Record<PaletteComponentKey, boolean>;
    defaultBlockSet: BlockType[];
    dragHint: boolean;
  };
};
type NotificationItem = {
  id: string;
  title: string;
  detail: string;
  tone: "destructive" | "secondary" | "outline";
};

const desktopSettingsKey = "planweave.desktop.settings.v1";
const defaultDesktopSettings: DesktopUiSettings = {
  runtimePath: "",
  defaultExecutor: "",
  appearance: "system",
  language: "zh-CN",
  notifications: {
    autoRunFailure: true,
    graphExceptions: true,
    dirtyPrompts: true,
    fileSyncConflict: true
  },
  palette: {
    visible: {
      task: true,
      implementation: true,
      check: true,
      review: true,
      context: true
    },
    defaultBlockSet: ["implementation", "check", "review"],
    dragHint: true
  }
};

function loadDesktopSettings(): DesktopUiSettings {
  if (typeof window === "undefined") {
    return defaultDesktopSettings;
  }
  try {
    const raw = window.localStorage.getItem(desktopSettingsKey);
    if (!raw) {
      return defaultDesktopSettings;
    }
    const parsed = JSON.parse(raw) as Partial<DesktopUiSettings>;
    return {
      ...defaultDesktopSettings,
      ...parsed,
      notifications: {
        ...defaultDesktopSettings.notifications,
        ...parsed.notifications
      },
      palette: {
        ...defaultDesktopSettings.palette,
        ...parsed.palette,
        visible: {
          ...defaultDesktopSettings.palette.visible,
          ...parsed.palette?.visible
        }
      }
    };
  } catch {
    return defaultDesktopSettings;
  }
}

function visibleBlockSet(settings: DesktopUiSettings): BlockType[] {
  const configured = settings.palette.defaultBlockSet.filter((type) => settings.palette.visible[type]);
  return configured.length > 0 ? configured : ["implementation"];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function graphNodes(
  graph: DesktopGraphViewModel,
  layout: DesktopLayout | null,
  titleDrafts: Record<string, string>,
  promptDrafts: Record<string, string>,
  saveStates: Record<string, TaskNodeData["saveState"]>,
  labels: TaskNodeData["labels"],
  selectedBlock: DesktopBlockDetail | null,
  blockRunRecords: DesktopBlockRunRecordSummary[],
  blockReviewAttempts: DesktopReviewAttemptSummary[],
  blockFeedbackRecords: DesktopFeedbackRecord[],
  onTitleChange: TaskNodeData["onTitleChange"],
  onTitleSave: TaskNodeData["onTitleSave"],
  onExecutorChange: TaskNodeData["onExecutorChange"],
  onPromptChange: TaskNodeData["onPromptChange"],
  onPromptSave: TaskNodeData["onPromptSave"],
  onBlockSelect: TaskNodeData["onBlockSelect"],
  onSelectedBlockChange: TaskNodeData["onSelectedBlockChange"],
  onBlockTitleSave: TaskNodeData["onBlockTitleSave"],
  onBlockExecutorChange: TaskNodeData["onBlockExecutorChange"],
  onBlockPromptSave: TaskNodeData["onBlockPromptSave"],
  onOpenRunRecord: TaskNodeData["onOpenRunRecord"],
  selectedContextNodeId: string | null
): AppFlowNode[] {
  const layoutByNode = new Map(layout?.nodes.map((node) => [node.nodeId, node]) ?? []);
  const taskNodes: TaskFlowNode[] = graph.tasks.map((task, index) => {
    const saved = layoutByNode.get(task.taskId);
    return {
      id: task.taskId,
      type: "task",
      position: saved ? { x: saved.x, y: saved.y } : { x: 80 + (index % 3) * 420, y: 80 + Math.floor(index / 3) * 320 },
      data: {
        task,
        titleDraft: titleDrafts[task.taskId] ?? task.title,
        promptDraft: promptDrafts[task.taskId] ?? task.promptMarkdown,
        saveState: saveStates[task.taskId] ?? "idle",
        executorOptions: graph.executorOptions,
        labels,
        selectedBlock,
        blockRunRecords,
        blockReviewAttempts,
        blockFeedbackRecords,
        onTitleChange,
        onTitleSave,
        onExecutorChange,
        onPromptChange,
        onPromptSave,
        onBlockSelect,
        onSelectedBlockChange,
        onBlockTitleSave,
        onBlockExecutorChange,
        onBlockPromptSave,
        onOpenRunRecord
      }
    };
  });
  const contextNodes: ContextFlowNode[] = graph.contextNodes.map((node, index) => ({
    id: node.nodeId,
    type: "context",
    position: layoutByNode.get(node.nodeId) ?? { x: 120 + (index % 2) * 360, y: 140 + Math.floor(index / 2) * 180 },
    data: { node, selected: node.nodeId === selectedContextNodeId }
  }));
  return [...taskNodes, ...contextNodes];
}

function graphEdges(graph: DesktopGraphViewModel): Edge[] {
  const nodeIds = new Set([...graph.tasks.map((task) => task.taskId), ...graph.contextNodes.map((node) => node.nodeId)]);
  return graph.edges
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .map((edge) => ({
      id: `${edge.from}-${edge.type}-${edge.to}`,
      source: edge.from,
      target: edge.to,
      animated: false,
      type: "smoothstep",
      label: edge.type
    }));
}

export function App() {
  const [settings, setSettings] = useState<DesktopUiSettings>(() => loadDesktopSettings());
  const language = settings.language;
  const t = useMemo(() => createTranslator(language), [language]);
  const [activeView, setActiveView] = useState<AppView>("graph");
  const [projects, setProjects] = useState<DesktopProjectSummary[]>([]);
  const [selectedProject, setSelectedProject] = useState<DesktopProjectSummary | null>(null);
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const [selectedTaskPanelId, setSelectedTaskPanelId] = useState<string | null>(null);
  const [selectedContextNodeId, setSelectedContextNodeId] = useState<string | null>(null);
  const [projectPath, setProjectPath] = useState(settings.runtimePath);
  const [graph, setGraph] = useState<DesktopGraphViewModel | null>(null);
  const [layout, setLayout] = useState<DesktopLayout | null>(null);
  const [todoGroups, setTodoGroups] = useState<DesktopTodoGroups | null>(null);
  const [statistics, setStatistics] = useState<DesktopStatistics | null>(null);
  const [selectedBlock, setSelectedBlock] = useState<DesktopBlockDetail | null>(null);
  const [blockRunRecords, setBlockRunRecords] = useState<DesktopBlockRunRecordSummary[]>([]);
  const [blockReviewAttempts, setBlockReviewAttempts] = useState<DesktopReviewAttemptSummary[]>([]);
  const [blockFeedbackRecords, setBlockFeedbackRecords] = useState<DesktopFeedbackRecord[]>([]);
  const [autoRunState, setAutoRunState] = useState<DesktopAutoRunState | null>(null);
  const [autoRunScopeMode, setAutoRunScopeMode] = useState<AutoRunScopeMode>("project");
  const [miniRunPanelOpen, setMiniRunPanelOpen] = useState(false);
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(null);
  const [reviewPipeline, setReviewPipeline] = useState<DesktopReviewPipeline | null>(null);
  const [reviewDraft, setReviewDraft] = useState<DesktopReviewPipelineStepInput[]>([]);
  const [reviewDefaultCyclesDraft, setReviewDefaultCyclesDraft] = useState(1);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<DesktopSearchResult[]>([]);
  const [selectedRunRecord, setSelectedRunRecord] = useState<DesktopRunRecord | null>(null);
  const [lastFileChange, setLastFileChange] = useState<DesktopPackageFileChangeEvent | null>(null);
  const [fileSyncDiagnostics, setFileSyncDiagnostics] = useState<string[]>([]);
  const [newTaskText, setNewTaskText] = useState("");
  const [newTaskMode, setNewTaskMode] = useState<DesktopTaskDraftMode>("task");
  const [newTaskTargetId, setNewTaskTargetId] = useState<string | null>(null);
  const [taskDraft, setTaskDraft] = useState<DesktopTaskDraft | null>(null);
  const [dirtyPromptRefs, setDirtyPromptRefs] = useState<string[]>([]);
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({});
  const [saveStates, setSaveStates] = useState<Record<string, TaskNodeData["saveState"]>>({});
  const [error, setError] = useState<string | null>(bridge ? null : t("bridgeUnavailable"));
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<AppFlowNode, Edge> | null>(null);
  const [autoRunControlPosition, setAutoRunControlPosition] = useState<FloatingControlPosition | null>(null);
  const [autoRunControlDrag, setAutoRunControlDrag] = useState<FloatingControlDrag | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<AppFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const updateSettings = useCallback((patch: Partial<DesktopUiSettings>) => {
    setSettings((current) => ({
      ...current,
      ...patch,
      notifications: {
        ...current.notifications,
        ...patch.notifications
      },
      palette: {
        ...current.palette,
        ...patch.palette,
        visible: {
          ...current.palette.visible,
          ...patch.palette?.visible
        }
      }
    }));
  }, []);

  useEffect(() => {
    window.localStorage.setItem(desktopSettingsKey, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("dark");
    const prefersDark =
      settings.appearance === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (settings.appearance === "dark" || prefersDark) {
      root.classList.add("dark");
    }
  }, [settings.appearance]);

  const loadProject = useCallback(async (project: DesktopProjectSummary) => {
    if (!bridge) {
      return;
    }
    setSelectedProject(project);
    setExpandedProjectId(project.projectId);
    setSelectedTaskPanelId(null);
    setSelectedContextNodeId(null);
    setError(null);
    const [nextGraph, nextLayout, nextTodo, nextStats] = await Promise.all([
      bridge.getGraphViewModel(project.rootPath),
      bridge.getDesktopLayout(project.rootPath),
      bridge.getTodoGroups(project.rootPath),
      bridge.getStatistics(project.rootPath)
    ]);
    setGraph(nextGraph);
    setLayout(nextLayout);
    setTodoGroups(nextTodo);
    setStatistics(nextStats);
    setSelectedBlock(null);
    setSelectedRunRecord(null);
    setBlockRunRecords([]);
    setBlockReviewAttempts([]);
    setBlockFeedbackRecords([]);
    setAutoRunState(await bridge.getLatestAutoRunSummary(project.rootPath));
    setNewTaskTargetId(nextGraph.tasks[0]?.taskId ?? null);
    setDirtyPromptRefs([]);
    setTitleDrafts(Object.fromEntries(nextGraph.tasks.map((task) => [task.taskId, task.title])));
    setPromptDrafts(Object.fromEntries(nextGraph.tasks.map((task) => [task.taskId, task.promptMarkdown])));
    await bridge.refreshPackageFileChanges(project.rootPath);
    await bridge.watchPackageFiles(project.rootPath);
    updateSettings({ runtimePath: project.workspaceRoot });
  }, [updateSettings]);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    bridge
      .listProjects()
      .then((items) => {
        setProjects(items);
        if (items[0]) {
          void loadProject(items[0]);
        }
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [loadProject]);

  useEffect(() => {
    const projectRoot = selectedProject?.rootPath;
    return () => {
      if (bridge && projectRoot) {
        void bridge.unwatchPackageFiles(projectRoot);
      }
    };
  }, [selectedProject?.rootPath]);

  const refreshGraph = useCallback(async () => {
    if (!bridge || !selectedProject) {
      return;
    }
    const nextGraph = await bridge.getGraphViewModel(selectedProject.rootPath);
    setGraph(nextGraph);
  }, [selectedProject]);

  const handleTitleChange = useCallback((taskId: string, value: string) => {
    setTitleDrafts((current) => ({ ...current, [taskId]: value }));
  }, []);

  const handleTitleSave = useCallback(
    async (taskId: string) => {
      if (!bridge || !selectedProject) {
        return;
      }
      try {
        await bridge.updateTaskTitle(selectedProject.rootPath, taskId, titleDrafts[taskId] ?? "");
        await refreshGraph();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [refreshGraph, selectedProject, titleDrafts]
  );

  const handleTaskExecutorChange = useCallback(
    async (taskId: string, executorName: string | null) => {
      if (!bridge || !selectedProject) {
        return;
      }
      try {
        const result = await bridge.updateTaskExecutor(selectedProject.rootPath, taskId, executorName);
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
        await refreshGraph();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [refreshGraph, selectedProject]
  );

  const handleOpenProject = useCallback(async () => {
    if (!bridge || !projectPath.trim()) {
      return;
    }
    try {
      const project = await bridge.initOrOpenProject(projectPath.trim());
      setProjects((items) => (items.some((item) => item.projectId === project.projectId) ? items : [...items, project]));
      await loadProject(project);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [loadProject, projectPath]);

  const generateTaskDraft = useCallback(async () => {
    if (!bridge || !selectedProject || !newTaskText.trim()) {
      return;
    }
    try {
      setTaskDraft(
        await bridge.createTaskDraft(selectedProject.rootPath, {
          mode: newTaskMode,
          text: newTaskText,
          targetTaskId: newTaskTargetId
        })
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [newTaskMode, newTaskTargetId, newTaskText, selectedProject]);

  const confirmTaskDraft = useCallback(async () => {
    if (!bridge || !selectedProject || !taskDraft) {
      return;
    }
    try {
      for (const task of taskDraft.tasks) {
        const result = await bridge.addTaskNode(selectedProject.rootPath, task);
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
      }
      for (const block of taskDraft.blocks) {
        const result = await bridge.addBlock(selectedProject.rootPath, block);
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
      }
      setTaskDraft(null);
      setNewTaskText("");
      await loadProject(selectedProject);
      setActiveView("graph");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [loadProject, selectedProject, taskDraft]);

  useEffect(() => {
    if (!bridge || !selectedProject || !searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    let cancelled = false;
    bridge
      .searchProject(selectedProject.rootPath, searchQuery)
      .then((results) => {
        if (!cancelled) {
          setSearchResults(results);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [searchQuery, selectedProject]);

  const handlePromptChange = useCallback((taskId: string, value: string) => {
    setPromptDrafts((current) => ({ ...current, [taskId]: value }));
    setSaveStates((current) => ({ ...current, [taskId]: "idle" }));
  }, []);

  const handlePromptSave = useCallback(
    async (taskId: string) => {
      if (!bridge || !selectedProject) {
        return;
      }
      setSaveStates((current) => ({ ...current, [taskId]: "saving" }));
      try {
        await bridge.updateTaskPrompt(selectedProject.rootPath, taskId, promptDrafts[taskId] ?? "");
        setSaveStates((current) => ({ ...current, [taskId]: "saved" }));
        await refreshGraph();
      } catch (caught) {
        setSaveStates((current) => ({ ...current, [taskId]: "error" }));
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [promptDrafts, refreshGraph, selectedProject]
  );

  useEffect(() => {
    if (!bridge || !selectedProject || !graph) {
      return undefined;
    }
    const dirtyTaskIds = graph.tasks
      .filter((task) => {
        const draft = promptDrafts[task.taskId];
        return draft !== undefined && draft !== task.promptMarkdown && (saveStates[task.taskId] ?? "idle") === "idle";
      })
      .map((task) => task.taskId);
    if (dirtyTaskIds.length === 0) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      for (const taskId of dirtyTaskIds) {
        void handlePromptSave(taskId);
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [graph, handlePromptSave, promptDrafts, saveStates, selectedProject]);

  const handleBlockSelect = useCallback(
    async (ref: string) => {
      if (!bridge || !selectedProject) {
        return;
      }
      const [block, runRecords, reviewAttempts, feedbackRecords] = await Promise.all([
        bridge.getBlockDetail(selectedProject.rootPath, ref),
        bridge.listBlockRunRecords(selectedProject.rootPath, ref),
        bridge.getReviewAttempts(selectedProject.rootPath, ref),
        bridge.getFeedbackRecords(selectedProject.rootPath, ref)
      ]);
      setSelectedBlock(block);
      setBlockRunRecords(runRecords);
      setBlockReviewAttempts(reviewAttempts);
      setBlockFeedbackRecords(feedbackRecords);
      setSelectedTaskPanelId(block.taskId);
      setSelectedContextNodeId(null);
      setSelectedRunRecord(null);
      setActiveView("graph");
    },
    [selectedProject]
  );

  const handleTaskPanelSelect = useCallback((taskId: string | null) => {
    setSelectedTaskPanelId(taskId);
    setSelectedContextNodeId(null);
    setActiveView("graph");
  }, []);

  const handleOpenRunRecord = useCallback(
    async (recordId: string | null | undefined) => {
      if (!bridge || !selectedProject || !recordId) {
        return;
      }
      try {
        setSelectedRunRecord(await bridge.getRunRecord(selectedProject.rootPath, recordId));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [selectedProject]
  );

  const handleSearchResultOpen = useCallback(
    (result: DesktopSearchResult) => {
      const target = searchNavigationTarget(result);
      if (target.kind === "task") {
        setSelectedTaskPanelId(target.ref);
        setSelectedContextNodeId(null);
        setActiveView("graph");
        return;
      }
      if (target.kind === "block") {
        void handleBlockSelect(target.ref);
        return;
      }
      if (target.kind === "context") {
        setSelectedTaskPanelId(null);
        setSelectedContextNodeId(target.ref);
        setActiveView("graph");
        return;
      }
      if (target.kind === "record") {
        void handleOpenRunRecord(target.recordId);
      }
    },
    [handleBlockSelect, handleOpenRunRecord]
  );

  const saveSelectedBlockTitle = useCallback(async () => {
    if (!bridge || !selectedProject || !selectedBlock) {
      return;
    }
    try {
      await bridge.updateBlockTitle(selectedProject.rootPath, selectedBlock.ref, selectedBlock.title);
      await refreshGraph();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [refreshGraph, selectedBlock, selectedProject]);

  const saveSelectedBlockExecutor = useCallback(
    async (executorName: string | null) => {
      if (!bridge || !selectedProject || !selectedBlock) {
        return;
      }
      try {
        const result = await bridge.updateBlockExecutor(selectedProject.rootPath, selectedBlock.ref, executorName);
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
        setSelectedBlock(await bridge.getBlockDetail(selectedProject.rootPath, selectedBlock.ref));
        await refreshGraph();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [refreshGraph, selectedBlock, selectedProject]
  );

  const saveSelectedBlockPrompt = useCallback(async () => {
    if (!bridge || !selectedProject || !selectedBlock) {
      return;
    }
    try {
      await bridge.updateBlockPrompt(selectedProject.rootPath, selectedBlock.ref, selectedBlock.promptMarkdown);
      await refreshGraph();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [refreshGraph, selectedBlock, selectedProject]);

  useEffect(() => {
    if (!graph) {
      setReviewTaskId(null);
      setReviewPipeline(null);
      setReviewDraft([]);
      return;
    }
    setReviewTaskId((current) => current ?? graph.tasks[0]?.taskId ?? null);
  }, [graph]);

  useEffect(() => {
    if (!bridge || !selectedProject || !reviewTaskId) {
      setReviewPipeline(null);
      setReviewDraft([]);
      return;
    }
    let cancelled = false;
    bridge
      .getReviewPipeline(selectedProject.rootPath, reviewTaskId)
      .then((pipeline) => {
        if (cancelled) {
          return;
        }
        setReviewPipeline(pipeline);
        setReviewDraft(pipeline.steps);
        setReviewDefaultCyclesDraft(pipeline.packageDefaults.maxFeedbackCycles);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reviewTaskId, selectedProject]);

  const updateReviewStep = useCallback((index: number, patch: Partial<DesktopReviewPipelineStepInput>) => {
    setReviewDraft((current) => current.map((step, stepIndex) => (stepIndex === index ? { ...step, ...patch } : step)));
  }, []);

  const addReviewStep = useCallback(() => {
    setReviewDraft((current) => [
      ...current,
      {
        blockId: "",
        title: t("defaultReviewStepTitle"),
        enabled: true,
        preset: t("defaultReviewStepPreset"),
        triggerCondition: "after_required_work_completed",
        inputContext: t("defaultReviewInputContext"),
        passCriteria: t("defaultReviewPassCriteria"),
        feedbackFormat: t("defaultReviewFeedbackFormat"),
        maxFeedbackCycles: reviewPipeline?.packageDefaults.maxFeedbackCycles ?? 1,
        hook: null,
        promptMarkdown: t("defaultReviewPrompt")
      }
    ]);
  }, [reviewPipeline, t]);

  const moveReviewStep = useCallback((index: number, direction: -1 | 1) => {
    setReviewDraft((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) {
        return current;
      }
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }, []);

  const removeReviewStep = useCallback((index: number) => {
    setReviewDraft((current) => current.filter((_, stepIndex) => stepIndex !== index));
  }, []);

  const saveReviewPipeline = useCallback(async () => {
    if (!bridge || !selectedProject || !reviewTaskId) {
      return;
    }
    try {
      const result = await bridge.updateReviewPipeline(selectedProject.rootPath, reviewTaskId, {
        packageDefaults: {
          maxFeedbackCycles: reviewDefaultCyclesDraft,
          completionPolicy: "strict"
        },
        steps: reviewDraft
      });
      if (!result.ok) {
        setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
        return;
      }
      const pipeline = await bridge.getReviewPipeline(selectedProject.rootPath, reviewTaskId);
      setReviewPipeline(pipeline);
      setReviewDraft(pipeline.steps);
      await loadProject(selectedProject);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [loadProject, reviewDefaultCyclesDraft, reviewDraft, reviewTaskId, selectedProject]);

  useEffect(() => {
    if (!graph) {
      setNodes([]);
      setEdges([]);
      return;
    }
    setNodes(
      graphNodes(
        graph,
        layout,
        titleDrafts,
        promptDrafts,
        saveStates,
        {
          blockStack: t("blockStack"),
          exception: t("exception"),
          exceptionOverlay: t("exceptionOverlay"),
          inherit: t("inherit"),
          more: t("more"),
          noBlockRecords: t("noBlockRecords"),
          openRecord: t("openRecord"),
          savePrompt: t("savePrompt"),
          selectedBlock: t("selectedBlock"),
          sourcePrompt: t("sourcePrompt"),
          taskException: t("taskException"),
          taskPrompt: t("taskPrompt"),
          title: t("title"),
          agent: t("agent"),
          effectiveExecutor: t("effectiveExecutor"),
          blockExecutionSummary: t("blockExecutionSummary"),
          latestRun: t("latestRun"),
          latestReviewAttempt: t("latestReviewAttempt"),
          feedbackMarker: t("feedbackMarker"),
          manualExecutor: t("manualExecutor")
        },
        selectedBlock,
        blockRunRecords,
        blockReviewAttempts,
        blockFeedbackRecords,
        handleTitleChange,
        handleTitleSave,
        handleTaskExecutorChange,
        handlePromptChange,
        handlePromptSave,
        handleBlockSelect,
        setSelectedBlock,
        saveSelectedBlockTitle,
        saveSelectedBlockExecutor,
        saveSelectedBlockPrompt,
        handleOpenRunRecord,
        selectedContextNodeId
      )
    );
    setEdges(graphEdges(graph));
  }, [
    graph,
    blockFeedbackRecords,
    blockReviewAttempts,
    blockRunRecords,
    handleBlockSelect,
    handleOpenRunRecord,
    handlePromptChange,
    handlePromptSave,
    handleTaskExecutorChange,
    handleTitleChange,
    handleTitleSave,
    layout,
    promptDrafts,
    saveStates,
    setEdges,
    setNodes,
    saveSelectedBlockExecutor,
    saveSelectedBlockPrompt,
    saveSelectedBlockTitle,
    selectedBlock,
    selectedContextNodeId,
    t,
    titleDrafts
  ]);

  const handleNodeDragStop = useCallback(
    async (_event: React.MouseEvent, node: Node) => {
      if (!bridge || !selectedProject || !layout) {
        return;
      }
      const nextLayout: DesktopLayout = {
        ...layout,
        nodes: nodes.map((item) => ({
          nodeId: item.id,
          x: item.id === node.id ? node.position.x : item.position.x,
          y: item.id === node.id ? node.position.y : item.position.y
        }))
      };
      const saved = await bridge.saveDesktopLayout(selectedProject.rootPath, nextLayout);
      setLayout(saved);
    },
    [layout, nodes, selectedProject]
  );

  const resetLayout = useCallback(async () => {
    if (!bridge || !selectedProject) {
      return;
    }
    setLayout(await bridge.resetDesktopLayout(selectedProject.rootPath));
  }, [selectedProject]);

  const refreshPackageFiles = useCallback(async () => {
    if (!bridge || !selectedProject) {
      return;
    }
    try {
      const result = await bridge.refreshPackageFileChanges(selectedProject.rootPath);
      setDirtyPromptRefs(result.dirtyPromptRefs);
      setFileSyncDiagnostics(result.diagnostics.map((diagnostic) => diagnostic.message));
      if (!result.ok) {
        setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
        return;
      }
      await loadProject(selectedProject);
      setDirtyPromptRefs(result.dirtyPromptRefs);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [loadProject, selectedProject]);

  useEffect(() => {
    if (!bridge || !selectedProject) {
      return undefined;
    }
    return bridge.onPackageFileChanged((event) => {
      if (event.projectRoot !== selectedProject.rootPath) {
        return;
      }
      setLastFileChange(event);
      void refreshPackageFiles();
    });
  }, [refreshPackageFiles, selectedProject]);

  const refreshAutoRunState = useCallback(async (runId: string) => {
    if (!bridge) {
      return;
    }
    setAutoRunState(await bridge.getAutoRunState(runId));
  }, []);

  useEffect(() => {
    if (!autoRunState || autoRunState.phase !== "running") {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshAutoRunState(autoRunState.runId);
    }, 600);
    return () => window.clearInterval(timer);
  }, [autoRunState, refreshAutoRunState]);

  const selectedAutoRunScope = useCallback((): DesktopAutoRunScope | null => {
    if (autoRunScopeMode === "project") {
      return { kind: "project" };
    }
    if (autoRunScopeMode === "selectedTask" && selectedTaskPanelId) {
      return { kind: "task", taskId: selectedTaskPanelId };
    }
    if (!selectedBlock) {
      return null;
    }
    if (autoRunScopeMode === "selectedTask") {
      return { kind: "task", taskId: selectedBlock.taskId };
    }
    return { kind: "block", blockRef: selectedBlock.ref };
  }, [autoRunScopeMode, selectedBlock, selectedTaskPanelId]);

  const handleAutoRunClick = useCallback(async () => {
    if (!bridge || !selectedProject) {
      return;
    }
    try {
      setMiniRunPanelOpen(true);
      if (!autoRunState || ["completed", "blocked", "failed", "stopped", "manual"].includes(autoRunState.phase)) {
        const scope = selectedAutoRunScope();
        if (!scope) {
          setError(t("selectBlockFirst"));
          return;
        }
        setAutoRunState(await bridge.startAutoRun(selectedProject.rootPath, scope, 20));
        return;
      }
      if (autoRunState.phase === "running") {
        setAutoRunState(await bridge.pauseAutoRun(autoRunState.runId));
        return;
      }
      if (autoRunState.phase === "paused") {
        setAutoRunState(await bridge.resumeAutoRun(autoRunState.runId));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [autoRunState, selectedAutoRunScope, selectedProject, t]);

  const stopAutoRunClick = useCallback(async () => {
    if (!bridge || !autoRunState) {
      return;
    }
    try {
      setAutoRunState(await bridge.stopAutoRun(autoRunState.runId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [autoRunState]);

  const startAutoRunControlDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const control = event.currentTarget.closest("[data-auto-run-control]");
    const surface = event.currentTarget.closest("[data-graph-surface]");
    if (!(control instanceof HTMLElement) || !(surface instanceof HTMLElement)) {
      return;
    }
    const controlBounds = control.getBoundingClientRect();
    const surfaceBounds = surface.getBoundingClientRect();
    const inset = 12;
    event.currentTarget.setPointerCapture(event.pointerId);
    setAutoRunControlDrag({
      pointerId: event.pointerId,
      offsetX: event.clientX - controlBounds.left,
      offsetY: event.clientY - controlBounds.top,
      containerLeft: surfaceBounds.left,
      containerTop: surfaceBounds.top,
      minLeft: inset,
      minTop: inset,
      maxLeft: Math.max(inset, surfaceBounds.width - controlBounds.width - inset),
      maxTop: Math.max(inset, surfaceBounds.height - controlBounds.height - inset)
    });
  }, []);

  const moveAutoRunControl = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!autoRunControlDrag || event.pointerId !== autoRunControlDrag.pointerId) {
        return;
      }
      setAutoRunControlPosition({
        left: clamp(
          event.clientX - autoRunControlDrag.containerLeft - autoRunControlDrag.offsetX,
          autoRunControlDrag.minLeft,
          autoRunControlDrag.maxLeft
        ),
        top: clamp(
          event.clientY - autoRunControlDrag.containerTop - autoRunControlDrag.offsetY,
          autoRunControlDrag.minTop,
          autoRunControlDrag.maxTop
        )
      });
    },
    [autoRunControlDrag]
  );

  const stopAutoRunControlDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setAutoRunControlDrag(null);
  }, []);

  const handleConnect = useCallback(
    async (connection: Connection) => {
      if (!bridge || !selectedProject || !connection.source || !connection.target || connection.source === connection.target) {
        return;
      }
      try {
        const result = await bridge.addDependencyEdge(selectedProject.rootPath, connection.source, connection.target);
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
        await refreshGraph();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [refreshGraph, selectedProject]
  );

  const handleEdgesDelete = useCallback(
    async (deletedEdges: Edge[]) => {
      if (!bridge || !selectedProject) {
        return;
      }
      for (const edge of deletedEdges) {
        if (edge.source && edge.target) {
          await bridge.removeDependencyEdge(selectedProject.rootPath, edge.source, edge.target);
        }
      }
      await refreshGraph();
    },
    [refreshGraph, selectedProject]
  );

  const addPaletteComponent = useCallback(
    async (type: PaletteDropComponent, dropPosition?: PaletteDropPosition) => {
      if (!bridge || !selectedProject) {
        return;
      }
      try {
        if (type === "task") {
          const previousTaskIds = new Set(graph?.tasks.map((task) => task.taskId) ?? []);
          const result = await bridge.addTaskNode(selectedProject.rootPath, {
            title: t("defaultTaskTitle"),
            promptMarkdown: t("defaultTaskPrompt"),
            acceptance: [t("defaultTaskAcceptance")],
            blockTypes: visibleBlockSet(settings),
            executor: settings.defaultExecutor.trim() || null
          });
          if (!result.ok) {
            setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
            return;
          }
          if (dropPosition) {
            const nextGraph = await bridge.getGraphViewModel(selectedProject.rootPath);
            const createdTask = nextGraph.tasks.find((task) => !previousTaskIds.has(task.taskId));
            if (createdTask) {
              const baseLayout = await bridge.getDesktopLayout(selectedProject.rootPath);
              const nextLayout: DesktopLayout = {
                ...baseLayout,
                nodes: [
                  ...baseLayout.nodes.filter((node) => node.nodeId !== createdTask.taskId),
                  {
                    nodeId: createdTask.taskId,
                    x: dropPosition.x,
                    y: dropPosition.y
                  }
                ]
              };
              const savedLayout = await bridge.saveDesktopLayout(selectedProject.rootPath, nextLayout);
              await loadProject(selectedProject);
              setLayout(savedLayout);
              setSelectedTaskPanelId(createdTask.taskId);
              setNewTaskTargetId(createdTask.taskId);
              return;
            }
          }
          await loadProject(selectedProject);
          return;
        }
        if (type === "context") {
          const previousContextIds = new Set(graph?.contextNodes.map((node) => node.nodeId) ?? []);
          const result = await bridge.addContextNode(selectedProject.rootPath, {
            type: "component",
            title: t("defaultContextTitle"),
            summary: t("defaultContextSummary")
          });
          if (!result.ok) {
            setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
            return;
          }
          if (dropPosition) {
            const nextGraph = await bridge.getGraphViewModel(selectedProject.rootPath);
            const createdContext = nextGraph.contextNodes.find((node) => !previousContextIds.has(node.nodeId));
            if (createdContext) {
              const baseLayout = await bridge.getDesktopLayout(selectedProject.rootPath);
              const nextLayout: DesktopLayout = {
                ...baseLayout,
                nodes: [
                  ...baseLayout.nodes.filter((node) => node.nodeId !== createdContext.nodeId),
                  {
                    nodeId: createdContext.nodeId,
                    x: dropPosition.x,
                    y: dropPosition.y
                  }
                ]
              };
              const savedLayout = await bridge.saveDesktopLayout(selectedProject.rootPath, nextLayout);
              await loadProject(selectedProject);
              setLayout(savedLayout);
              return;
            }
          }
          await loadProject(selectedProject);
          return;
        }
        const targetTaskId = selectedBlock?.taskId ?? selectedTaskPanelId ?? graph?.tasks[0]?.taskId;
        if (!targetTaskId) {
          setError(t("selectTaskBeforeBlock"));
          return;
        }
        const result = await bridge.addBlock(selectedProject.rootPath, {
          taskId: targetTaskId,
          type,
          title: defaultBlockTitleForUi(type, t),
          promptMarkdown: `# ${defaultBlockTitleForUi(type, t)}\n`,
          executor: settings.defaultExecutor.trim() || null
        });
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
        await loadProject(selectedProject);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [graph, loadProject, selectedBlock, selectedProject, selectedTaskPanelId, settings, t]
  );

  const handlePaletteDragStart = useCallback((event: React.DragEvent, type: PaletteDropComponent) => {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-planweave-palette", type);
  }, []);

  const handleGraphDragOver = useCallback((event: React.DragEvent) => {
    if (event.dataTransfer.types.includes("application/x-planweave-palette")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleGraphDrop = useCallback(
    (event: React.DragEvent) => {
      const type = event.dataTransfer.getData("application/x-planweave-palette") as PaletteDropComponent;
      if (!type) {
        return;
      }
      event.preventDefault();
      const dropPosition = flowInstance?.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY
      });
      void addPaletteComponent(type, type === "task" || type === "context" ? dropPosition : undefined);
    },
    [addPaletteComponent, flowInstance]
  );

  const visibleTasks = graph?.tasks.filter((task) => {
    const query = searchQuery.trim().toLowerCase();
    const matchesQuery = !query || task.title.toLowerCase().includes(query) || task.taskId.toLowerCase().includes(query);
    const matchesPanel = !selectedTaskPanelId || task.taskId === selectedTaskPanelId;
    return matchesQuery && matchesPanel;
  });
  const visibleTaskIds = new Set(visibleTasks?.map((task) => task.taskId) ?? []);
  const latestBlockRun = blockRunRecords[0];
  const latestReviewAttempt = blockReviewAttempts[0];
  const latestFeedbackRecord = blockFeedbackRecords[0];
  const autoRunControlStyle = autoRunControlPosition
    ? { left: autoRunControlPosition.left, top: autoRunControlPosition.top }
    : { right: 20, bottom: 20 };

  const notificationItems: NotificationItem[] = [];
  if (settings.notifications.autoRunFailure && autoRunState?.error) {
    notificationItems.push({
      id: "auto-run-error",
      title: t("notifyAutoRun"),
      detail: autoRunState.error,
      tone: "destructive"
    });
  }
  if (settings.notifications.autoRunFailure && autoRunState?.latestRecordPath) {
    notificationItems.push({
      id: "latest-record",
      title: t("latestRecord"),
      detail: autoRunState.latestRecordPath,
      tone: "outline"
    });
  }
  if (settings.notifications.graphExceptions) {
    for (const task of graph?.tasks ?? []) {
      for (const exception of task.exceptions) {
        notificationItems.push({
          id: `${task.taskId}-${exception.ref}-${exception.source}`,
          title: `${t("graphExceptions")} · ${task.title}`,
          detail: exception.reason,
          tone: "destructive"
        });
      }
    }
  }
  if (settings.notifications.dirtyPrompts) {
    for (const ref of [...new Set([...dirtyPromptRefs, ...(graph?.dirtyPromptRefs ?? [])])]) {
      notificationItems.push({
        id: `dirty-${ref}`,
        title: t("notifyDirtyPrompts"),
        detail: ref,
        tone: "secondary"
      });
    }
  }
  if (settings.notifications.fileSyncConflict) {
    if (lastFileChange) {
      notificationItems.push({
        id: "file-change",
        title: t("fileChangesDetected"),
        detail: lastFileChange.paths.join(", "),
        tone: "outline"
      });
    }
    for (const diagnostic of fileSyncDiagnostics) {
      notificationItems.push({
        id: `sync-${diagnostic}`,
        title: t("fileSyncConflict"),
        detail: diagnostic,
        tone: "destructive"
      });
    }
  }

  return (
    <main className="flex h-screen min-h-0 bg-background text-foreground">
      <aside className="flex w-[280px] shrink-0 flex-col border-r bg-sidebar">
        <nav className="flex flex-col gap-1 p-3 pt-4">
          <Button className="justify-start" variant={activeView === "new-task" ? "secondary" : "ghost"} onClick={() => setActiveView("new-task")}>
            <FilePlus2Icon data-icon="inline-start" />
            {t("newTask")}
          </Button>
          <Button className="justify-start" variant={activeView === "statistics" ? "secondary" : "ghost"} onClick={() => setActiveView("statistics")}>
            <ChartNoAxesColumnIncreasingIcon data-icon="inline-start" />
            {t("statistics")}
          </Button>
          <Button className="justify-start" variant={activeView === "search" ? "secondary" : "ghost"} onClick={() => setActiveView("search")}>
            <SearchIcon data-icon="inline-start" />
            {t("search")}
          </Button>
          <Button className="justify-start" variant={activeView === "notifications" ? "secondary" : "ghost"} onClick={() => setActiveView("notifications")}>
            <BellIcon data-icon="inline-start" />
            {t("notifications")}
            {notificationItems.length > 0 ? <Badge variant="destructive">{notificationItems.length}</Badge> : null}
          </Button>
        </nav>
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          <div className="text-xs font-medium text-muted-foreground">{t("projects")}</div>
          <div className="flex gap-2">
            <Input
              aria-label={t("projectPath")}
              placeholder={t("projectPath")}
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
            />
            <Button size="icon" variant="outline" onClick={handleOpenProject} aria-label={t("open")}>
              <FolderOpenIcon data-icon="inline-start" />
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-1 pr-2">
              {projects.length === 0 ? <div className="text-sm text-muted-foreground">{t("projectMissing")}</div> : null}
              {projects.map((project) => {
                const isSelectedProject = selectedProject?.projectId === project.projectId;
                const isExpandedProject = expandedProjectId === project.projectId && isSelectedProject;
                return (
                  <div className="flex flex-col gap-1" key={project.projectId}>
                    <Button
                      className="h-auto justify-start whitespace-normal py-2 text-left"
                      variant={isSelectedProject ? "secondary" : "ghost"}
                      onClick={() => void loadProject(project)}
                    >
                      <GitBranchIcon data-icon="inline-start" />
                      <span className="min-w-0 truncate">{project.name}</span>
                    </Button>
                    {isExpandedProject && graph ? (
                      <div className="flex flex-col gap-1 pl-6">
                        <Button
                          className="h-8 justify-start px-2 text-xs"
                          variant={selectedTaskPanelId === null ? "secondary" : "ghost"}
                          onClick={() => handleTaskPanelSelect(null)}
                        >
                          {t("allTaskPanels")}
                        </Button>
                        {graph.tasks.map((task) => (
                          <Button
                            className="h-8 justify-between gap-2 px-2 text-xs"
                            key={task.taskId}
                            variant={selectedTaskPanelId === task.taskId ? "secondary" : "ghost"}
                            onClick={() => handleTaskPanelSelect(task.taskId)}
                          >
                            <span className="min-w-0 truncate">{task.title}</span>
                            <Badge variant={task.exceptions.length > 0 ? "destructive" : statusVariant[task.status]}>{task.taskId}</Badge>
                          </Button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </div>
        <Separator />
        <div className="flex items-center gap-2 p-3">
          <Select value={language} onValueChange={(value) => updateSettings({ language: value as Language })}>
            <SelectTrigger className="flex-1">
              <LanguagesIcon />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="system">{t("systemLanguage")}</SelectItem>
                <SelectItem value="zh-CN">简体中文</SelectItem>
                <SelectItem value="en">English</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button size="icon" variant="ghost" aria-label={t("settings")} onClick={() => setActiveView("settings")}>
            <SettingsIcon data-icon="inline-start" />
          </Button>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <Tabs className="min-h-0 flex-1" value={activeView} onValueChange={(value) => setActiveView(value as AppView)}>
          <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
            <TabsList>
              <TabsTrigger value="graph">{t("graph")}</TabsTrigger>
              <TabsTrigger value="review-pipeline">{t("reviewPipeline")}</TabsTrigger>
              <TabsTrigger value="todo">{t("todo")}</TabsTrigger>
              <TabsTrigger value="statistics">{t("statistics")}</TabsTrigger>
            </TabsList>
            <div className="flex items-center gap-2">
              {dirtyPromptRefs.length || graph?.dirtyPromptRefs.length ? <Badge variant="destructive">{t("dirtyPrompts")}</Badge> : null}
              <Button variant="outline" onClick={() => void refreshPackageFiles()}>
                <RotateCcwIcon data-icon="inline-start" />
                {dirtyPromptRefs.length ? `${t("dirtyPrompts")} ${dirtyPromptRefs.length}` : t("refreshFiles")}
              </Button>
              <Button variant="outline" onClick={resetLayout}>
                <RotateCcwIcon data-icon="inline-start" />
                {t("resetLayout")}
              </Button>
            </div>
          </div>

          <TabsContent className="min-h-0 p-4" value="new-task">
            <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_360px] gap-4">
              <Card className="min-h-0">
                <CardHeader>
                  <CardTitle>{t("authoring")}</CardTitle>
                  <CardDescription>{t("taskInputHint")}</CardDescription>
                </CardHeader>
                <CardContent>
                  <FieldGroup>
                    <Field>
                      <FieldLabel>{t("creationMode")}</FieldLabel>
                      <Select value={newTaskMode} onValueChange={(value) => setNewTaskMode(value as DesktopTaskDraftMode)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="task">{t("createTaskNode")}</SelectItem>
                            <SelectItem value="blocks">{t("appendBlocks")}</SelectItem>
                            <SelectItem value="document">{t("documentTasks")}</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                    {newTaskMode === "blocks" ? (
                      <Field>
                        <FieldLabel>{t("targetTask")}</FieldLabel>
                        <Select value={newTaskTargetId ?? ""} onValueChange={setNewTaskTargetId}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {graph?.tasks.map((task) => (
                                <SelectItem value={task.taskId} key={task.taskId}>
                                  {task.title}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                    ) : null}
                    <Field>
                      <FieldLabel>{t("taskInput")}</FieldLabel>
                      <Textarea
                        className="min-h-64 resize-none"
                        value={newTaskText}
                        onChange={(event) => setNewTaskText(event.target.value)}
                      />
                      <FieldDescription>{t("taskInputHint")}</FieldDescription>
                    </Field>
                    <div className="flex gap-2">
                      <Button onClick={() => void generateTaskDraft()}>{t("generateDraft")}</Button>
                      <Button variant="outline" onClick={() => setActiveView("graph")}>
                        {t("skipToCanvas")}
                      </Button>
                    </div>
                  </FieldGroup>
                </CardContent>
              </Card>
              <Card className="min-h-0">
                <CardHeader>
                  <CardTitle>{t("draftPreview")}</CardTitle>
                  <CardDescription>{selectedProject?.name ?? t("noProject")}</CardDescription>
                </CardHeader>
                <CardContent className="flex min-h-0 flex-col gap-3">
                  <ScrollArea className="min-h-0 flex-1">
                    <div className="flex flex-col gap-3 pr-2">
                      {taskDraft?.tasks.map((task, index) => (
                        <div className="flex flex-col gap-2 rounded-lg border p-3" key={`${task.title}-${index}`}>
                          <div className="text-sm font-medium">{task.title}</div>
                          <div className="text-xs text-muted-foreground">{task.blockTypes.join(" / ")}</div>
                          <div className="line-clamp-4 text-xs text-muted-foreground">{task.promptMarkdown}</div>
                        </div>
                      ))}
                      {taskDraft?.blocks.map((block, index) => (
                        <div className="flex flex-col gap-2 rounded-lg border p-3" key={`${block.taskId}-${block.title}-${index}`}>
                          <div className="text-sm font-medium">{block.title}</div>
                          <div className="text-xs text-muted-foreground">
                            {block.taskId} · {block.type}
                          </div>
                          <div className="line-clamp-4 text-xs text-muted-foreground">{block.promptMarkdown}</div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                  <Button disabled={!taskDraft} onClick={() => void confirmTaskDraft()}>
                    {t("confirmWrite")}
                  </Button>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent className="min-h-0" value="graph">
            <div className="relative h-full min-h-0" data-graph-surface onDragOver={handleGraphDragOver} onDrop={handleGraphDrop}>
              {!graph ? (
                <div className="flex h-full items-start p-6">
                  <div className="flex max-w-md flex-col gap-3 rounded-lg border bg-background p-5">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <FolderOpenIcon data-icon="inline-start" />
                      {t("noProject")}
                    </div>
                    <div className="text-sm text-muted-foreground">{t("openProjectHint")}</div>
                    <Button className="w-fit" variant="outline" onClick={handleOpenProject}>
                      <FolderOpenIcon data-icon="inline-start" />
                      {t("openProject")}
                    </Button>
                  </div>
                </div>
              ) : (
                <ReactFlow
                  nodes={visibleTasks ? nodes.filter((node) => node.type !== "task" || visibleTaskIds.has(node.id)) : nodes}
                  edges={visibleTasks ? edges.filter((edge) => visibleTaskIds.has(edge.source) && visibleTaskIds.has(edge.target)) : edges}
                  nodeTypes={nodeTypes}
                  onConnect={(connection) => void handleConnect(connection)}
                  onEdgesDelete={(deletedEdges) => void handleEdgesDelete(deletedEdges)}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onNodeDragStop={handleNodeDragStop}
                  onInit={setFlowInstance}
                  fitView
                >
                  <Background />
                  <Controls />
                  <MiniMap pannable zoomable />
                </ReactFlow>
              )}
              <div className="absolute flex items-center gap-2 rounded-xl border bg-background p-2 shadow-lg" data-auto-run-control style={autoRunControlStyle}>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("dragAutoRunControl")}
                  onPointerDown={startAutoRunControlDrag}
                  onPointerMove={moveAutoRunControl}
                  onPointerUp={stopAutoRunControlDrag}
                  onPointerCancel={stopAutoRunControlDrag}
                >
                  <MoveIcon data-icon="inline-start" />
                </Button>
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <span>
                      <Popover open={miniRunPanelOpen} onOpenChange={setMiniRunPanelOpen}>
                        <PopoverTrigger asChild>
                          <Button
                            size="icon-lg"
                            variant={autoRunState?.phase === "blocked" || autoRunState?.phase === "failed" ? "destructive" : "default"}
                            aria-label={t("autoRun")}
                            onClick={() => void handleAutoRunClick()}
                          >
                            {autoRunState?.phase === "running" ? <PauseIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-96">
                          <PopoverHeader>
                            <PopoverTitle>{t("miniRunPanel")}</PopoverTitle>
                            <PopoverDescription>{selectedProject?.name ?? t("noProject")}</PopoverDescription>
                          </PopoverHeader>
                          <div className="flex flex-col gap-3">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-sm font-medium">{t("runStatus")}</span>
                              <Badge variant={autoRunState?.phase === "blocked" || autoRunState?.phase === "failed" ? "destructive" : "outline"}>
                                {autoRunState?.phase ?? t("miniPanelEmpty")}
                              </Badge>
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                              <span>
                                {t("currentBlock")}: {autoRunState?.currentRef ?? "-"}
                              </span>
                              <span>
                                {t("agent")}: {autoRunState?.currentExecutor ?? "-"}
                              </span>
                              <span>
                                {t("elapsedTime")}: {autoRunState ? formatElapsed(autoRunState.elapsedMs) : "-"}
                              </span>
                              <span>
                                {t("stepCount")}: {autoRunState ? `${autoRunState.stepCount}` : "-"}
                              </span>
                            </div>
                            {autoRunState?.latestOutputSummary ? (
                              <div className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
                                {t("latestOutput")}: {autoRunState.latestOutputSummary}
                              </div>
                            ) : null}
                            {autoRunState?.error ? <div className="rounded-md border border-destructive p-2 text-xs text-destructive">{autoRunState.error}</div> : null}
                            <div className="flex justify-end gap-2">
                              {autoRunState?.latestRecordId ? (
                                <Button size="sm" variant="outline" onClick={() => void handleOpenRunRecord(autoRunState.latestRecordId)}>
                                  <FolderOpenIcon data-icon="inline-start" />
                                  {t("openRecord")}
                                </Button>
                              ) : null}
                              {autoRunState && ["running", "paused", "manual", "blocked", "failed"].includes(autoRunState.phase) ? (
                                <Button size="sm" variant="outline" onClick={() => void stopAutoRunClick()}>
                                  <SquareIcon data-icon="inline-start" />
                                  {t("stop")}
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        </PopoverContent>
                      </Popover>
                    </span>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuLabel>{t("autoRunScope")}</ContextMenuLabel>
                    <ContextMenuRadioGroup value={autoRunScopeMode} onValueChange={(value) => setAutoRunScopeMode(value as AutoRunScopeMode)}>
                      <ContextMenuRadioItem value="project">{t("projectScope")}</ContextMenuRadioItem>
                      <ContextMenuRadioItem disabled={!selectedTaskPanelId && !selectedBlock} value="selectedTask">
                        {t("selectedTaskScope")}
                      </ContextMenuRadioItem>
                      <ContextMenuRadioItem disabled={!selectedBlock} value="selectedBlock">
                        {t("selectedBlockScope")}
                      </ContextMenuRadioItem>
                    </ContextMenuRadioGroup>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => setMiniRunPanelOpen(true)}>{t("miniRunPanel")}</ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
                <Select value={autoRunScopeMode} onValueChange={(value) => setAutoRunScopeMode(value as AutoRunScopeMode)}>
                  <SelectTrigger className="h-9 w-36">
                    <SelectValue aria-label={t("autoRunScope")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="project">{t("projectScope")}</SelectItem>
                      <SelectItem disabled={!selectedTaskPanelId && !selectedBlock} value="selectedTask">
                        {t("selectedTaskScope")}
                      </SelectItem>
                      <SelectItem disabled={!selectedBlock} value="selectedBlock">
                        {t("selectedBlockScope")}
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Badge variant={autoRunState?.phase === "blocked" || autoRunState?.phase === "failed" ? "destructive" : "outline"}>
                  {autoRunState?.phase ?? t("autoRunStopped")}
                </Badge>
              </div>
            </div>
          </TabsContent>

          <TabsContent className="min-h-0 p-4" value="review-pipeline">
            <div className="flex h-full min-h-0 flex-col gap-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <Select value={reviewTaskId ?? ""} onValueChange={setReviewTaskId}>
                    <SelectTrigger className="w-64">
                      <SelectValue aria-label={t("targetTask")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {graph?.tasks.map((task) => (
                          <SelectItem key={task.taskId} value={task.taskId}>
                            {task.title}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <Field className="w-40">
                    <FieldLabel>{t("packageDefaultCycles")}</FieldLabel>
                    <Input
                      min={0}
                      type="number"
                      value={reviewDefaultCyclesDraft}
                      onChange={(event) => setReviewDefaultCyclesDraft(Number(event.target.value))}
                    />
                  </Field>
                  {reviewPipeline ? <Badge variant="outline">{reviewPipeline.packageDefaults.completionPolicy}</Badge> : null}
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" onClick={addReviewStep}>
                    <PlusIcon data-icon="inline-start" />
                    {t("addReviewStep")}
                  </Button>
                  <Button onClick={() => void saveReviewPipeline()}>{t("saveReviewPipeline")}</Button>
                </div>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="flex flex-col gap-3 pr-3">
                  {reviewDraft.map((step, index) => {
                    const hookArgs = step.hook?.args.join(" ") ?? "";
                    return (
                      <Card key={`${step.blockId || "new"}-${index}`}>
                        <CardHeader>
                          <CardTitle className="flex min-w-0 items-center gap-2 text-base">
                            <Badge variant={step.enabled ? "secondary" : "outline"}>{index + 1}</Badge>
                            <span className="truncate">{step.title}</span>
                          </CardTitle>
                          <CardDescription>{step.blockId || t("newReviewStep")}</CardDescription>
                          <CardAction className="flex gap-1">
                            <Button
                              disabled={index === 0}
                              size="icon-sm"
                              variant="ghost"
                              aria-label={t("moveUp")}
                              onClick={() => moveReviewStep(index, -1)}
                            >
                              <ArrowUpIcon data-icon="inline-start" />
                            </Button>
                            <Button
                              disabled={index === reviewDraft.length - 1}
                              size="icon-sm"
                              variant="ghost"
                              aria-label={t("moveDown")}
                              onClick={() => moveReviewStep(index, 1)}
                            >
                              <ArrowDownIcon data-icon="inline-start" />
                            </Button>
                            <Button size="icon-sm" variant="ghost" aria-label={t("remove")} onClick={() => removeReviewStep(index)}>
                              <Trash2Icon data-icon="inline-start" />
                            </Button>
                          </CardAction>
                        </CardHeader>
                        <CardContent>
                          <FieldGroup>
                            <Field>
                              <FieldLabel>{t("title")}</FieldLabel>
                              <Input value={step.title} onChange={(event) => updateReviewStep(index, { title: event.target.value })} />
                            </Field>
                            <div className="grid grid-cols-3 gap-3">
                              <Field>
                                <FieldLabel>{t("enabled")}</FieldLabel>
                                <Select
                                  value={step.enabled ? "enabled" : "disabled"}
                                  onValueChange={(value) => updateReviewStep(index, { enabled: value === "enabled" })}
                                >
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectGroup>
                                      <SelectItem value="enabled">{t("enabled")}</SelectItem>
                                      <SelectItem value="disabled">{t("disabled")}</SelectItem>
                                    </SelectGroup>
                                  </SelectContent>
                                </Select>
                              </Field>
                              <Field>
                                <FieldLabel>{t("preset")}</FieldLabel>
                                <Input value={step.preset} onChange={(event) => updateReviewStep(index, { preset: event.target.value })} />
                              </Field>
                              <Field>
                                <FieldLabel>{t("maxFeedbackCycles")}</FieldLabel>
                                <Input
                                  min={0}
                                  type="number"
                                  value={step.maxFeedbackCycles}
                                  onChange={(event) => updateReviewStep(index, { maxFeedbackCycles: Number(event.target.value) })}
                                />
                              </Field>
                            </div>
                            <Field>
                              <FieldLabel>{t("triggerCondition")}</FieldLabel>
                              <Select
                                value={step.triggerCondition}
                                onValueChange={(value) =>
                                  updateReviewStep(index, {
                                    triggerCondition: value === "manual" ? "manual" : "after_required_work_completed"
                                  })
                                }
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectGroup>
                                    <SelectItem value="after_required_work_completed">{t("afterRequiredWork")}</SelectItem>
                                    <SelectItem value="manual">{t("manualTrigger")}</SelectItem>
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                            </Field>
                            <div className="grid grid-cols-3 gap-3">
                              <Field>
                                <FieldLabel>{t("inputContext")}</FieldLabel>
                                <Textarea
                                  className="min-h-24 resize-none"
                                  value={step.inputContext}
                                  onChange={(event) => updateReviewStep(index, { inputContext: event.target.value })}
                                />
                              </Field>
                              <Field>
                                <FieldLabel>{t("passCriteria")}</FieldLabel>
                                <Textarea
                                  className="min-h-24 resize-none"
                                  value={step.passCriteria}
                                  onChange={(event) => updateReviewStep(index, { passCriteria: event.target.value })}
                                />
                              </Field>
                              <Field>
                                <FieldLabel>{t("feedbackFormat")}</FieldLabel>
                                <Textarea
                                  className="min-h-24 resize-none"
                                  value={step.feedbackFormat}
                                  onChange={(event) => updateReviewStep(index, { feedbackFormat: event.target.value })}
                                />
                              </Field>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <Field>
                                <FieldLabel>{t("hookCommand")}</FieldLabel>
                                <Input
                                  value={step.hook?.command ?? ""}
                                  onChange={(event) => {
                                    const command = event.target.value.trim();
                                    updateReviewStep(index, {
                                      hook: command
                                        ? {
                                            id: step.hook?.id ?? `${step.blockId || `review-${index + 1}`}-hook`,
                                            type: "executable",
                                            command,
                                            args: step.hook?.args ?? [],
                                            executionPolicy: "trusted-local"
                                          }
                                        : null
                                    });
                                  }}
                                />
                              </Field>
                              <Field>
                                <FieldLabel>{t("hookArgs")}</FieldLabel>
                                <Input
                                  value={hookArgs}
                                  onChange={(event) => {
                                    const args = event.target.value.split(/\s+/).filter(Boolean);
                                    updateReviewStep(index, {
                                      hook: step.hook
                                        ? {
                                            ...step.hook,
                                            args
                                          }
                                        : null
                                    });
                                  }}
                                />
                              </Field>
                            </div>
                            <Field>
                              <FieldLabel>{t("taskPrompt")}</FieldLabel>
                              <Textarea
                                className="min-h-40 resize-none"
                                value={step.promptMarkdown}
                                onChange={(event) => updateReviewStep(index, { promptMarkdown: event.target.value })}
                              />
                              <FieldDescription>{t("reviewPromptHint")}</FieldDescription>
                            </Field>
                          </FieldGroup>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </ScrollArea>
            </div>
          </TabsContent>

          <TabsContent className="min-h-0 p-4" value="todo">
            <ScrollArea className="h-full">
              <div className="grid grid-cols-3 gap-3">
                {todoGroups
                  ? Object.entries(todoGroups)
                      .filter(([status]) => ["ready", "in_progress", "needs_changes", "blocked", "diverged", "implemented"].includes(status))
                      .map(([status, items]) => (
                        <TodoGroupCard
                          items={items}
                          key={status}
                          labels={{
                            dependencyBlockers: t("dependencyBlockers"),
                            locks: t("locks"),
                            noBlockers: t("noBlockers"),
                            noLocks: t("noLocks"),
                            parallelBlocked: t("parallelBlocked"),
                            parallelSafe: t("parallelSafe"),
                            parallelSafety: t("parallelSafety")
                          }}
                          onSelect={(ref) => void handleBlockSelect(ref)}
                          status={status}
                        />
                      ))
                  : null}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent className="p-4" value="statistics">
            {statistics ? (
              <div className="grid grid-cols-4 gap-3">
                <StatCard label={t("tasks")} value={`${statistics.implementedTaskCount}/${statistics.taskTotal}`} />
                <StatCard label={t("implementedRatio")} value={formatPercent(statistics.implementedRatio)} />
                <StatCard label={t("taskThroughput")} value={String(statistics.taskThroughput)} />
                <StatCard
                  label={t("averageImplementationTime")}
                  value={statistics.averageImplementationTimeMs === null ? "-" : formatElapsed(statistics.averageImplementationTimeMs)}
                />
                <StatCard label={t("remaining")} value={String(statistics.estimatedRemainingBlocks)} />
                <StatCard label={t("reviewsPassed")} value={String(statistics.reviewPassedCount)} />
                <StatCard label={t("reviewPassedRatio")} value={formatPercent(statistics.reviewPassedRatio)} />
                <StatCard label={t("feedback")} value={String(statistics.feedbackEnvelopeCount)} />
                <StatCard label={t("reworkCount")} value={String(statistics.reworkCount)} />
              </div>
            ) : null}
          </TabsContent>

          <TabsContent className="p-4" value="search">
            <div className="flex flex-col gap-3">
              <div className="text-sm font-medium">{t("query")}</div>
              <Input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
              <ScrollArea className="h-[520px]">
                <SearchResultList results={searchResults} targetMissingLabel={t("searchTargetMissing")} onOpenResult={handleSearchResultOpen} />
              </ScrollArea>
            </div>
          </TabsContent>

          <TabsContent className="p-4" value="notifications">
            <Card>
              <CardHeader>
                <CardTitle>{t("notifications")}</CardTitle>
                <CardDescription>
                  {notificationItems.length > 0 ? `${t("activeRules")}: ${notificationItems.length}` : t("noNotificationsFiltered")}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {notificationItems.length === 0 ? <div className="text-sm text-muted-foreground">{t("noNotifications")}</div> : null}
                {notificationItems.map((item) => (
                  <div className="flex items-start justify-between gap-3 rounded-md border p-3" key={item.id}>
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{item.title}</div>
                      <div className="break-words text-xs text-muted-foreground">{item.detail}</div>
                    </div>
                    <Badge variant={item.tone}>{item.tone}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent className="min-h-0 overflow-auto p-4" value="settings">
            <Card className="mx-auto w-full max-w-5xl">
              <CardHeader>
                <CardTitle>{t("settings")}</CardTitle>
                <CardDescription>{t("runtimePathHint")}</CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <div className="grid grid-cols-3 gap-4">
                    <Field>
                      <FieldLabel>{t("runtimePath")}</FieldLabel>
                      <Input
                        value={settings.runtimePath}
                        onChange={(event) => {
                          updateSettings({ runtimePath: event.target.value });
                          setProjectPath(event.target.value);
                        }}
                      />
                      <FieldDescription>{t("runtimePathHint")}</FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel>{t("defaultExecutor")}</FieldLabel>
                      <Select value={settings.defaultExecutor || "__manual"} onValueChange={(value) => updateSettings({ defaultExecutor: value === "__manual" ? "" : value })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="__manual">{t("manualExecutor")}</SelectItem>
                            {graph?.executorOptions.map((executor) => (
                              <SelectItem value={executor} key={executor}>
                                {executor}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel>{t("appearance")}</FieldLabel>
                      <Select value={settings.appearance} onValueChange={(value) => updateSettings({ appearance: value as AppearanceMode })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="system">{t("appearanceSystem")}</SelectItem>
                            <SelectItem value="light">{t("appearanceLight")}</SelectItem>
                            <SelectItem value="dark">{t("appearanceDark")}</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <Field>
                      <FieldLabel>{t("language")}</FieldLabel>
                      <Select value={language} onValueChange={(value) => updateSettings({ language: value as Language })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="system">{t("systemLanguage")}</SelectItem>
                            <SelectItem value="zh-CN">简体中文</SelectItem>
                            <SelectItem value="en">English</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  <Field>
                    <FieldLabel>{t("notificationRules")}</FieldLabel>
                    <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
                      {[
                        { key: "autoRunFailure", label: t("notifyAutoRun") },
                        { key: "graphExceptions", label: t("notifyGraphExceptions") },
                        { key: "dirtyPrompts", label: t("notifyDirtyPrompts") },
                        { key: "fileSyncConflict", label: t("notifyFileSync") }
                      ].map(({ key, label }) => (
                        <Select
                          key={key}
                          value={settings.notifications[key as keyof DesktopUiSettings["notifications"]] ? "enabled" : "disabled"}
                          onValueChange={(value) =>
                            updateSettings({
                              notifications: {
                                ...settings.notifications,
                                [key]: value === "enabled"
                              }
                            })
                          }
                        >
                          <SelectTrigger className="w-full min-w-0">
                            <SelectValue placeholder={label} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="enabled">{label}</SelectItem>
                              <SelectItem value="disabled">{t("disabled")}</SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      ))}
                    </div>
                  </Field>
                  <PaletteSettingsPanel
                    labels={{
                      blockSetImplementation: t("blockSetImplementation"),
                      blockSetImplementationCheck: t("blockSetImplementationCheck"),
                      blockSetImplementationCheckReview: t("blockSetImplementationCheckReview"),
                      checkBlock: t("checkBlock"),
                      componentVisibility: t("componentVisibility"),
                      contextNode: t("contextNode"),
                      defaultBlockSet: t("defaultBlockSet"),
                      disabled: t("disabled"),
                      dragHint: t("dragHint"),
                      enabled: t("enabled"),
                      implementationBlock: t("implementationBlock"),
                      paletteSettings: t("paletteSettings"),
                      reviewBlock: t("reviewBlock"),
                      taskNode: t("taskNode")
                    }}
                    settings={settings}
                    updateSettings={updateSettings}
                  />
                </FieldGroup>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </section>

      <aside className="flex w-[300px] shrink-0 flex-col border-l bg-background">
        <div className="grid grid-cols-1 gap-2 p-3 pt-4">
          <div className="text-sm font-semibold">{t("componentPalette")}</div>
          {settings.palette.dragHint ? <div className="text-xs text-muted-foreground">{t("dragHint")}</div> : null}
          {settings.palette.visible.task ? (
            <Button
              className="justify-start"
              draggable
              variant="outline"
              onClick={() => void addPaletteComponent("task")}
              onDragStart={(event) => handlePaletteDragStart(event, "task")}
            >
              <ComponentIcon data-icon="inline-start" />
              {t("taskNode")}
            </Button>
          ) : null}
          {settings.palette.visible.implementation ? (
            <Button
              className="justify-start"
              draggable
              variant="outline"
              onClick={() => void addPaletteComponent("implementation")}
              onDragStart={(event) => handlePaletteDragStart(event, "implementation")}
            >
              <ComponentIcon data-icon="inline-start" />
              {t("implementationBlock")}
            </Button>
          ) : null}
          {settings.palette.visible.check ? (
            <Button
              className="justify-start"
              draggable
              variant="outline"
              onClick={() => void addPaletteComponent("check")}
              onDragStart={(event) => handlePaletteDragStart(event, "check")}
            >
              <ComponentIcon data-icon="inline-start" />
              {t("checkBlock")}
            </Button>
          ) : null}
          {settings.palette.visible.review ? (
            <Button
              className="justify-start"
              draggable
              variant="outline"
              onClick={() => void addPaletteComponent("review")}
              onDragStart={(event) => handlePaletteDragStart(event, "review")}
            >
              <ComponentIcon data-icon="inline-start" />
              {t("reviewBlock")}
            </Button>
          ) : null}
          {settings.palette.visible.context ? (
            <Button
              className="justify-start"
              draggable
              variant="outline"
              onClick={() => void addPaletteComponent("context")}
              onDragStart={(event) => handlePaletteDragStart(event, "context")}
            >
              <ComponentIcon data-icon="inline-start" />
              {t("contextNode")}
            </Button>
          ) : null}
        </div>
        <Separator />
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          <div className="text-sm font-semibold">{t("selectedBlock")}</div>
          {selectedRunRecord ? (
            <Card size="sm">
              <CardHeader>
                <CardTitle className="text-sm">{t("runRecordDetail")}</CardTitle>
                <CardDescription>{selectedRunRecord.recordId}</CardDescription>
                <CardAction>
                  <Button size="icon-sm" variant="ghost" aria-label={t("closeRecord")} onClick={() => setSelectedRunRecord(null)}>
                    <SquareIcon data-icon="inline-start" />
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent className="flex max-h-80 flex-col gap-2 overflow-hidden">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <Badge variant="outline">{selectedRunRecord.adapter ?? t("manualExecutor")}</Badge>
                  <Badge variant={selectedRunRecord.exitCode === 0 || selectedRunRecord.exitCode === null ? "secondary" : "destructive"}>
                    {selectedRunRecord.exitCode ?? "-"}
                  </Badge>
                </div>
                {selectedRunRecord.stdoutSummary ? (
                  <div className="text-xs text-muted-foreground">
                    {t("latestOutput")}: {selectedRunRecord.stdoutSummary}
                  </div>
                ) : null}
                {selectedRunRecord.stderrSummary ? (
                  <div className="text-xs text-destructive">
                    {t("stderr")}: {selectedRunRecord.stderrSummary}
                  </div>
                ) : null}
                <ScrollArea className="h-40 rounded-md border p-2">
                  <pre className="whitespace-pre-wrap text-xs">{selectedRunRecord.reportMarkdown || selectedRunRecord.promptMarkdown}</pre>
                </ScrollArea>
              </CardContent>
            </Card>
          ) : null}
          {selectedBlock ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <Input
                  aria-label={t("title")}
                  className="min-w-0 font-medium"
                  value={selectedBlock.title}
                  onChange={(event) => setSelectedBlock({ ...selectedBlock, title: event.target.value })}
                  onBlur={() => void saveSelectedBlockTitle()}
                />
                <Badge variant={statusVariant[selectedBlock.status]}>{selectedBlock.status}</Badge>
              </div>
              <div className="flex flex-col gap-1">
                <div className="text-xs font-medium text-muted-foreground">{t("agent")}</div>
                <Select
                  value={selectedBlock.executor ?? "__inherit"}
                  onValueChange={(value) => void saveSelectedBlockExecutor(value === "__inherit" ? null : value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="__inherit">{t("inheritExecutor")}</SelectItem>
                      {graph?.executorOptions.map((executor) => (
                        <SelectItem value={executor} key={executor}>
                          {executor}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <div className="text-xs text-muted-foreground">
                  {t("effectiveExecutor")}: {selectedBlock.effectiveExecutor ?? t("manualExecutor")}
                </div>
              </div>
              <Card size="sm">
                <CardHeader>
                  <CardTitle className="text-sm">{t("blockExecutionSummary")}</CardTitle>
                  <CardDescription>{selectedBlock.ref}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 text-xs">
                  {latestBlockRun ? (
                    <button
                      className="flex items-center justify-between gap-2 rounded-md border p-2 text-left hover:bg-muted/50"
                      type="button"
                      onClick={() => void handleOpenRunRecord(latestBlockRun.recordId)}
                    >
                      <span className="min-w-0 truncate">
                        {t("latestRun")}: {latestBlockRun.finishedAt ?? latestBlockRun.startedAt ?? latestBlockRun.runId}
                      </span>
                      <Badge variant={latestBlockRun.exitCode === 0 || latestBlockRun.exitCode === null ? "secondary" : "destructive"}>
                        {latestBlockRun.exitCode ?? "-"}
                      </Badge>
                    </button>
                  ) : (
                    <div className="text-muted-foreground">{t("noBlockRecords")}</div>
                  )}
                  {latestReviewAttempt ? (
                    <div className="rounded-md border p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{t("latestReviewAttempt")}</span>
                        <Badge variant={latestReviewAttempt.verdict === "passed" ? "secondary" : "outline"}>{latestReviewAttempt.verdict ?? "-"}</Badge>
                      </div>
                      <div className="line-clamp-2 text-muted-foreground">{latestReviewAttempt.contentPreview}</div>
                    </div>
                  ) : null}
                  {latestFeedbackRecord ? (
                    <div className="rounded-md border p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{t("feedbackMarker")}</span>
                        <Badge variant={latestFeedbackRecord.status === "resolved" ? "secondary" : "destructive"}>{latestFeedbackRecord.status}</Badge>
                      </div>
                      <div className="line-clamp-2 text-muted-foreground">{latestFeedbackRecord.content}</div>
                    </div>
                  ) : null}
                  {selectedBlock.exceptionReason ? <div className="rounded-md border border-destructive p-2 text-destructive">{selectedBlock.exceptionReason}</div> : null}
                </CardContent>
              </Card>
              <Textarea
                className="min-h-56 flex-1 resize-none"
                value={selectedBlock.promptMarkdown}
                onChange={(event) => setSelectedBlock({ ...selectedBlock, promptMarkdown: event.target.value })}
              />
              <Button onClick={() => void saveSelectedBlockPrompt()}>
                {t("savePrompt")}
              </Button>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">{t("blocks")}</div>
          )}
        </div>
        {error ? (
          <>
            <Separator />
            <div className="p-3">
              <Badge variant="destructive">{error}</Badge>
            </div>
          </>
        ) : null}
      </aside>
    </main>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle>{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}
