import type { Dispatch, SetStateAction } from "react";
import type { DesktopRunRecord } from "@planweave/runtime";
import { XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { createTranslator } from "../i18n";

type BlockRunRecordCardProps = {
  selectedRunRecord: DesktopRunRecord;
  setSelectedRunRecord: Dispatch<SetStateAction<DesktopRunRecord | null>>;
  t: ReturnType<typeof createTranslator>;
};

export function BlockRunRecordCard({ selectedRunRecord, setSelectedRunRecord, t }: BlockRunRecordCardProps) {
  const executorLabel = selectedRunRecord.executor ?? selectedRunRecord.adapter ?? t("manualExecutor");
  const stderrIsFailure = typeof selectedRunRecord.exitCode === "number" && selectedRunRecord.exitCode !== 0;
  const exitCodeSucceeded = selectedRunRecord.exitCode === null || selectedRunRecord.exitCode === undefined || selectedRunRecord.exitCode === 0;

  return (
    <Card className="min-h-0 flex-1" size="sm">
      <CardHeader>
        <CardTitle className="text-sm">{selectedRunRecord.ref}</CardTitle>
        <CardDescription>{selectedRunRecord.runId}</CardDescription>
        <CardAction>
          <Button size="icon-sm" variant="ghost" aria-label={t("closeRecord")} onPointerDown={(event) => event.stopPropagation()} onClick={() => setSelectedRunRecord(null)}>
            <XIcon data-icon="inline-start" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Badge variant="outline">{executorLabel}</Badge>
          <Badge variant={exitCodeSucceeded ? "secondary" : "destructive"}>{selectedRunRecord.exitCode ?? "-"}</Badge>
        </div>
        {selectedRunRecord.agentSessionId ? (
          <div className="rounded-md border bg-muted/40 px-2 py-1 text-xs">
            <span className="font-medium">{t("agentSession")}:</span> <span className="font-mono">{selectedRunRecord.agentSessionId}</span>
          </div>
        ) : null}
        {selectedRunRecord.executionCwd ? (
          <div className="rounded-md border bg-muted/40 px-2 py-1 text-xs">
            <span className="font-medium">{t("executionCwd")}:</span> <span className="break-all font-mono">{selectedRunRecord.executionCwd}</span>
          </div>
        ) : null}
        {selectedRunRecord.stdoutSummary ? (
          <div className="text-xs text-muted-foreground">
            {t("latestOutput")}: {selectedRunRecord.stdoutSummary}
          </div>
        ) : null}
        {selectedRunRecord.stderrSummary ? (
          <div className={stderrIsFailure ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
            {stderrIsFailure ? t("stderr") : t("terminalOutput")}: {selectedRunRecord.stderrSummary}
          </div>
        ) : null}
        <div className="text-xs font-medium text-muted-foreground">{t("runReport")}</div>
        {selectedRunRecord.reportMarkdown ? (
          <ScrollArea className="min-h-0 flex-1 rounded-md border p-2">
            <pre className="whitespace-pre-wrap text-xs">{selectedRunRecord.reportMarkdown}</pre>
          </ScrollArea>
        ) : (
          <div className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">{t("noRunReport")}</div>
        )}
      </CardContent>
    </Card>
  );
}
