import type { Dispatch, SetStateAction } from "react";
import type {
  DesktopCanvasReference,
  DesktopRunRecord,
  DesktopRunTerminalAvailability,
  DesktopTerminalAppDetection,
  DesktopTerminalAppId
} from "@planweave-ai/runtime";
import { XIcon } from "lucide-react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import type { createTranslator } from "../i18n";
import { TerminalOpenButton } from "./TerminalOpenButton";
import { RunnerRecordMonitor } from "./RunnerRecordMonitor";

type BlockRunRecordCardProps = {
  canvasRef?: DesktopCanvasReference | null;
  defaultTerminalAppId?: DesktopTerminalAppId | null;
  onOpenTerminal?: (recordId: string | null, appId: DesktopTerminalAppId) => Promise<void>;
  onOpenRunTerminal?: (recordId: string, appId: DesktopTerminalAppId) => Promise<void>;
  onTerminalDefaultAppChange?: (appId: DesktopTerminalAppId) => Promise<void> | void;
  selectedRunRecord: DesktopRunRecord;
  setSelectedRunRecord: Dispatch<SetStateAction<DesktopRunRecord | null>>;
  terminalApps?: DesktopTerminalAppDetection[];
  terminalAvailability?: DesktopRunTerminalAvailability | null;
  tmuxAvailable?: boolean;
  t: ReturnType<typeof createTranslator>;
};

export function BlockRunRecordCard({
  canvasRef,
  defaultTerminalAppId = null,
  onOpenTerminal,
  onOpenRunTerminal,
  onTerminalDefaultAppChange,
  selectedRunRecord,
  setSelectedRunRecord,
  terminalApps = [],
  terminalAvailability = null,
  tmuxAvailable = false,
  t
}: BlockRunRecordCardProps) {
  const executorLabel =
    selectedRunRecord.executor ?? selectedRunRecord.adapter ?? t("manualExecutor");
  const stderrIsFailure =
    typeof selectedRunRecord.exitCode === "number" && selectedRunRecord.exitCode !== 0;
  const displayMarkdown = selectedRunRecord.displayMarkdown || selectedRunRecord.reportMarkdown;
  const isAcpRun = selectedRunRecord.runnerReadModel != null;

  return (
    <Card className="min-h-0 flex-1 border-0 shadow-none ring-0" size="sm">
      <CardHeader>
        <CardTitle className="text-sm">{selectedRunRecord.ref}</CardTitle>
        <CardDescription>{selectedRunRecord.runId}</CardDescription>
        <CardAction className="flex items-center gap-1">
          {!isAcpRun ? <TerminalOpenButton
            canvasRef={canvasRef}
            defaultTerminalAppId={defaultTerminalAppId}
            missingSessionReason={t("tmuxTerminalNoSession")}
            onOpenTerminal={onOpenTerminal}
            onOpenRunTerminal={onOpenRunTerminal}
            onTerminalDefaultAppChange={onTerminalDefaultAppChange}
            recordId={selectedRunRecord.recordId}
            terminalAvailability={terminalAvailability}
            terminalApps={terminalApps}
            tmuxAvailable={tmuxAvailable}
            t={t}
          /> : null}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("closeRecord")}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setSelectedRunRecord(null)}
          >
            <XIcon data-icon="inline-start" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
        <div className="flex text-xs">
          <Badge variant="outline">{executorLabel}</Badge>
        </div>
        {selectedRunRecord.agentSessionId ? (
          <div className="rounded-md border bg-muted/40 px-2 py-1 text-xs">
            <span className="font-medium">{t("agentSession")}:</span>{" "}
            <span className="font-mono">{selectedRunRecord.agentSessionId}</span>
          </div>
        ) : null}
        {!isAcpRun && selectedRunRecord.tmuxSessionId ? (
          <div className="rounded-md border bg-muted/40 px-2 py-1 text-xs">
            <span className="font-medium">{t("tmuxSession")}:</span>{" "}
            <span className="font-mono">{selectedRunRecord.tmuxSessionId}</span>
          </div>
        ) : null}
        {!isAcpRun && selectedRunRecord.tmuxAttachCommand ? (
          <div className="rounded-md border bg-muted/40 px-2 py-1 text-xs">
            <span className="font-medium">{t("tmuxAttach")}:</span>{" "}
            <span className="break-all font-mono">{selectedRunRecord.tmuxAttachCommand}</span>
          </div>
        ) : null}
        {selectedRunRecord.executionCwd ? (
          <div className="rounded-md border bg-muted/40 px-2 py-1 text-xs">
            <span className="font-medium">{t("executionCwd")}:</span>{" "}
            <span className="break-all font-mono">{selectedRunRecord.executionCwd}</span>
          </div>
        ) : null}
        {!isAcpRun && selectedRunRecord.stdoutSummary ? (
          <div className="text-xs text-muted-foreground">
            {t("latestOutput")}: {selectedRunRecord.stdoutSummary}
          </div>
        ) : null}
        {!isAcpRun && selectedRunRecord.stderrSummary ? (
          <div
            className={
              stderrIsFailure ? "text-xs text-destructive" : "text-xs text-muted-foreground"
            }
          >
            {stderrIsFailure ? t("stderr") : t("terminalOutput")}: {selectedRunRecord.stderrSummary}
          </div>
        ) : null}
        {isAcpRun ? (
          <RunnerRecordMonitor
            canvasRef={canvasRef}
            initialModel={selectedRunRecord.runnerReadModel!}
            recordId={selectedRunRecord.recordId}
            t={t}
          />
        ) : null}
        <div className="text-xs font-medium text-muted-foreground">{t("runReport")}</div>
        {displayMarkdown ? (
          <ScrollArea className="min-h-0 flex-1 rounded-md border p-2">
            <pre className="whitespace-pre-wrap text-xs">{displayMarkdown}</pre>
          </ScrollArea>
        ) : (
          <div className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
            {t("noRunReport")}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
