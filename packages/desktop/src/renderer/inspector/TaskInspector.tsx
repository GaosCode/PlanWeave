import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CSSProperties, Dispatch, SetStateAction } from "react";
import type { DesktopBlockPreview, DesktopGraphViewModel, DesktopTaskDetail } from "@planweave-ai/runtime";
import { XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { createTranslator } from "../i18n";
import { statusVariant } from "../viewHelpers";

type TaskInspectorProps = {
  className?: string;
  error: string | null;
  executorOptions: string[];
  graph: DesktopGraphViewModel | null;
  onClose: () => void;
  onDraftDirtyChange?: (dirty: boolean) => void;
  saveSelectedTaskExecutor: (executorName: string | null) => Promise<void>;
  saveSelectedTaskPrompt: () => Promise<void>;
  saveSelectedTaskTitle: () => Promise<void>;
  selectedTask: DesktopTaskDetail | null;
  setSelectedTask: Dispatch<SetStateAction<DesktopTaskDetail | null>>;
  style?: CSSProperties;
  t: ReturnType<typeof createTranslator>;
};

const taskPromptAutosaveDelayMs = 700;

function selectedTaskExecutorValue(selectedTask: DesktopTaskDetail | null, taskBlocks: DesktopBlockPreview[]): string {
  if (!selectedTask) {
    return "";
  }
  const blockExecutors = new Set(taskBlocks.map((block) => block.executor).filter((executor): executor is string => executor !== null));
  if (blockExecutors.size > 1) {
    return "__custom";
  }
  return [...blockExecutors][0] ?? selectedTask.executor ?? "manual";
}

export function TaskInspector({
  className,
  error,
  executorOptions,
  graph,
  onClose,
  onDraftDirtyChange,
  saveSelectedTaskExecutor,
  saveSelectedTaskPrompt,
  saveSelectedTaskTitle,
  selectedTask,
  setSelectedTask,
  style,
  t
}: TaskInspectorProps) {
  const taskPromptBaselineRef = useRef<{ promptMarkdown: string; taskId: string } | null>(null);
  const taskBlocks: DesktopBlockPreview[] = useMemo(() => {
    if (!graph || !selectedTask) {
      return [];
    }
    return graph.tasks.find((task) => task.taskId === selectedTask.taskId)?.blocks ?? [];
  }, [graph, selectedTask]);
  const selectedExecutor = selectedTaskExecutorValue(selectedTask, taskBlocks);
  const taskExecutorOptions =
    selectedExecutor !== "__custom" && selectedExecutor && !executorOptions.includes(selectedExecutor) ? [selectedExecutor, ...executorOptions] : executorOptions;

  useEffect(() => {
    if (!selectedTask) {
      taskPromptBaselineRef.current = null;
      onDraftDirtyChange?.(false);
      return;
    }
    if (taskPromptBaselineRef.current?.taskId !== selectedTask.taskId) {
      taskPromptBaselineRef.current = { promptMarkdown: selectedTask.promptMarkdown, taskId: selectedTask.taskId };
      onDraftDirtyChange?.(false);
      return;
    }
    onDraftDirtyChange?.(taskPromptBaselineRef.current.promptMarkdown !== selectedTask.promptMarkdown);
  }, [onDraftDirtyChange, selectedTask]);

  const saveTaskPromptIfDirty = useCallback(() => {
    if (!selectedTask) {
      return;
    }
    const baseline = taskPromptBaselineRef.current;
    if (!baseline || baseline.taskId !== selectedTask.taskId || baseline.promptMarkdown === selectedTask.promptMarkdown) {
      return;
    }
    taskPromptBaselineRef.current = { promptMarkdown: selectedTask.promptMarkdown, taskId: selectedTask.taskId };
    onDraftDirtyChange?.(false);
    void saveSelectedTaskPrompt();
  }, [onDraftDirtyChange, saveSelectedTaskPrompt, selectedTask]);

  useEffect(() => {
    if (!selectedTask) {
      return undefined;
    }
    const baseline = taskPromptBaselineRef.current;
    if (!baseline || baseline.taskId !== selectedTask.taskId || baseline.promptMarkdown === selectedTask.promptMarkdown) {
      return undefined;
    }
    const timer = window.setTimeout(saveTaskPromptIfDirty, taskPromptAutosaveDelayMs);
    return () => window.clearTimeout(timer);
  }, [saveTaskPromptIfDirty, selectedTask]);

  if (!selectedTask && !error) {
    return null;
  }

  return (
    <Card className={cn("flex min-h-[420px] min-w-[380px] flex-col overflow-hidden bg-background shadow-xl", className)} size="sm" style={style}>
      <CardHeader className="border-b">
        <CardTitle>{t("selectedTask")}</CardTitle>
        <CardAction className="flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" aria-label={t("close")} onClick={onClose}>
            <XIcon data-icon="inline-start" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
        {selectedTask ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <Input
                aria-label={t("title")}
                className="min-w-0 font-medium"
                value={selectedTask.title}
                onBlur={() => void saveSelectedTaskTitle().then(() => onDraftDirtyChange?.(false))}
                onChange={(event) => {
                  onDraftDirtyChange?.(true);
                  setSelectedTask({ ...selectedTask, title: event.target.value });
                }}
              />
              <Badge variant={statusVariant[selectedTask.status]}>{selectedTask.status}</Badge>
            </div>
            <div className="flex flex-col gap-1">
              <div className="text-xs font-medium text-muted-foreground">{t("agent")}</div>
              <Select value={selectedExecutor} onValueChange={(value) => void saveSelectedTaskExecutor(value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {selectedExecutor === "__custom" ? (
                      <SelectItem value="__custom" disabled>
                        {t("customExecutor")}
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
            </div>
            <div className="rounded-lg border bg-card p-3 text-xs">
              <div className="text-sm font-semibold">{t("taskExecutionSummary")}</div>
              <div className="mt-1 text-muted-foreground">{selectedTask.taskId}</div>
              {selectedTask.acceptance.length > 0 ? (
                <div className="mt-3 flex flex-col gap-1">
                  <div className="font-medium">{t("acceptanceCriteria")}</div>
                  {selectedTask.acceptance.map((item) => (
                    <div className="rounded-md border p-2 text-muted-foreground" key={item}>
                      {item}
                    </div>
                  ))}
                </div>
              ) : null}
              {taskBlocks.length > 0 ? (
                <div className="mt-3 flex flex-col gap-1">
                  <div className="font-medium">{t("blockStack")}</div>
                  {taskBlocks.map((block) => (
                    <div className="flex items-center justify-between gap-2 rounded-md border p-2" key={block.ref}>
                      <span className="min-w-0 truncate">{block.title}</span>
                      <Badge variant={statusVariant[block.status]}>{block.status}</Badge>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            <Textarea
              className="min-h-80 flex-1 resize-none"
              value={selectedTask.promptMarkdown}
              onBlur={saveTaskPromptIfDirty}
              onChange={(event) => {
                onDraftDirtyChange?.(true);
                setSelectedTask({ ...selectedTask, promptMarkdown: event.target.value });
              }}
            />
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">{t("tasks")}</div>
        )}
      </CardContent>
      {error ? (
        <>
          <Separator />
          <CardContent>
            <Badge variant="destructive">{error}</Badge>
          </CardContent>
        </>
      ) : null}
    </Card>
  );
}
