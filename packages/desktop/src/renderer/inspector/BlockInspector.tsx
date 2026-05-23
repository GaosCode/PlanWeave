import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CSSProperties, Dispatch, SetStateAction } from "react";
import type { DesktopBlockDetail, DesktopBlockRunRecordSummary, DesktopFeedbackRecord, DesktopGraphViewModel, DesktopReviewAttemptSummary, DesktopRunRecord } from "@planweave/runtime";
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
import { BlockConnectionsCard } from "./BlockConnectionsCard";
import { BlockRunRecordCard } from "./BlockRunRecordCard";

type BlockInspectorProps = {
  blockFeedbackRecords: DesktopFeedbackRecord[];
  blockReviewAttempts: DesktopReviewAttemptSummary[];
  blockRunRecords: DesktopBlockRunRecordSummary[];
  className?: string;
  error: string | null;
  executorOptions: string[];
  graph: DesktopGraphViewModel | null;
  handleOpenRunRecord: (recordId: string | null | undefined) => Promise<void>;
  onBlockSelect: (ref: string) => Promise<void>;
  onClose: () => void;
  saveSelectedBlockExecutor: (executorName: string | null) => Promise<void>;
  saveSelectedBlockPrompt: () => Promise<void>;
  saveSelectedBlockTitle: () => Promise<void>;
  selectedBlock: DesktopBlockDetail | null;
  selectedRunRecord: DesktopRunRecord | null;
  setSelectedBlock: Dispatch<SetStateAction<DesktopBlockDetail | null>>;
  setSelectedRunRecord: Dispatch<SetStateAction<DesktopRunRecord | null>>;
  style?: CSSProperties;
  t: ReturnType<typeof createTranslator>;
};

const blockPromptAutosaveDelayMs = 700;

export function BlockInspector({
  blockFeedbackRecords,
  blockReviewAttempts,
  blockRunRecords,
  className,
  error,
  executorOptions,
  graph,
  handleOpenRunRecord,
  onBlockSelect,
  onClose,
  saveSelectedBlockExecutor,
  saveSelectedBlockPrompt,
  saveSelectedBlockTitle,
  selectedBlock,
  selectedRunRecord,
  setSelectedBlock,
  setSelectedRunRecord,
  style,
  t
}: BlockInspectorProps) {
  const latestBlockRun = blockRunRecords[0];
  const latestReviewAttempt = blockReviewAttempts[0];
  const latestFeedbackRecord = blockFeedbackRecords[0];
  const selectedExecutor = selectedBlock?.executor && executorOptions.includes(selectedBlock.executor) ? selectedBlock.executor : "__inherit";
  const blockPromptBaselineRef = useRef<{ promptMarkdown: string; ref: string } | null>(null);
  const taskBlocks = useMemo(() => {
    if (!graph || !selectedBlock) {
      return [];
    }
    return graph.tasks.find((task) => task.taskId === selectedBlock.taskId)?.blocks ?? [];
  }, [graph, selectedBlock]);
  useEffect(() => {
    if (!selectedBlock) {
      blockPromptBaselineRef.current = null;
      return;
    }
    if (blockPromptBaselineRef.current?.ref !== selectedBlock.ref) {
      blockPromptBaselineRef.current = { promptMarkdown: selectedBlock.promptMarkdown, ref: selectedBlock.ref };
    }
  }, [selectedBlock]);
  const saveBlockPromptIfDirty = useCallback(() => {
    if (!selectedBlock || selectedRunRecord) {
      return;
    }
    const baseline = blockPromptBaselineRef.current;
    if (!baseline || baseline.ref !== selectedBlock.ref || baseline.promptMarkdown === selectedBlock.promptMarkdown) {
      return;
    }
    blockPromptBaselineRef.current = { promptMarkdown: selectedBlock.promptMarkdown, ref: selectedBlock.ref };
    void saveSelectedBlockPrompt();
  }, [saveSelectedBlockPrompt, selectedBlock, selectedRunRecord]);
  useEffect(() => {
    if (!selectedBlock || selectedRunRecord) {
      return undefined;
    }
    const baseline = blockPromptBaselineRef.current;
    if (!baseline || baseline.ref !== selectedBlock.ref || baseline.promptMarkdown === selectedBlock.promptMarkdown) {
      return undefined;
    }
    const timer = window.setTimeout(saveBlockPromptIfDirty, blockPromptAutosaveDelayMs);
    return () => window.clearTimeout(timer);
  }, [saveBlockPromptIfDirty, selectedBlock, selectedRunRecord]);

  if (!selectedBlock && !selectedRunRecord && !error) {
    return null;
  }

  return (
    <Card className={cn("flex min-h-[420px] min-w-[380px] flex-col overflow-hidden bg-background shadow-xl", className)} size="sm" style={style}>
      <CardHeader className="border-b">
        <CardTitle>{selectedRunRecord ? t("runRecordDetail") : t("selectedBlock")}</CardTitle>
        <CardAction className="flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" aria-label={t("close")} onClick={onClose}>
            <XIcon data-icon="inline-start" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
        {selectedRunRecord ? (
          <BlockRunRecordCard selectedRunRecord={selectedRunRecord} setSelectedRunRecord={setSelectedRunRecord} t={t} />
        ) : selectedBlock ? (
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
              <Select value={selectedExecutor} onValueChange={(value) => void saveSelectedBlockExecutor(value === "__inherit" ? null : value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="__inherit">{t("inheritExecutor")}</SelectItem>
                    {executorOptions.map((executor) => (
                      <SelectItem value={executor} key={executor}>
                        {executor}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="shrink-0 rounded-lg border bg-card p-3 text-xs">
              <div className="text-sm font-semibold">{t("blockExecutionSummary")}</div>
              <div className="mt-1 text-muted-foreground">{selectedBlock.ref}</div>
              <div className="mt-3 flex flex-col gap-2">
                {latestBlockRun ? (
                  <button className="flex items-center justify-between gap-2 rounded-md border p-2 text-left hover:bg-muted/50" type="button" onClick={() => void handleOpenRunRecord(latestBlockRun.recordId)}>
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
                    <div className="max-h-40 overflow-auto whitespace-pre-wrap text-muted-foreground">{latestReviewAttempt.contentPreview}</div>
                  </div>
                ) : null}
                {latestFeedbackRecord ? (
                  <div className="rounded-md border p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{t("feedbackMarker")}</span>
                      <Badge variant={latestFeedbackRecord.status === "resolved" ? "secondary" : "destructive"}>{latestFeedbackRecord.status}</Badge>
                    </div>
                    <div className="max-h-40 overflow-auto whitespace-pre-wrap text-muted-foreground">{latestFeedbackRecord.content}</div>
                  </div>
                ) : null}
                {selectedBlock.exceptionReason ? <div className="rounded-md border border-destructive p-2 text-destructive">{selectedBlock.exceptionReason}</div> : null}
              </div>
            </div>
            <BlockConnectionsCard blocks={taskBlocks} dependencies={selectedBlock.dependencies} selectedBlockRef={selectedBlock.ref} onBlockSelect={onBlockSelect} />
            <Textarea
              className="min-h-56 flex-1 resize-none"
              value={selectedBlock.promptMarkdown}
              onBlur={saveBlockPromptIfDirty}
              onChange={(event) => setSelectedBlock({ ...selectedBlock, promptMarkdown: event.target.value })}
            />
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">{t("blocks")}</div>
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
