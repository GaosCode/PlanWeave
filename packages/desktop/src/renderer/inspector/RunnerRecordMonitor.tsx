import type {
  DesktopBridgeApi,
  DesktopCanvasReference,
  RunnerRecordReadModel
} from "@planweave-ai/runtime";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { bridge } from "../bridge";
import type { createTranslator } from "../i18n";
import { useRunnerRecordMonitor } from "../hooks/useRunnerRecordMonitor";

type RunnerRecordMonitorProps = {
  api?: Pick<
    DesktopBridgeApi,
    "subscribeRunnerRecord" | "revealRunnerRecordArtifact"
  > | null;
  canvasRef?: DesktopCanvasReference | null;
  initialModel: RunnerRecordReadModel;
  recordId: string;
  t: ReturnType<typeof createTranslator>;
};

export function RunnerRecordMonitor({
  api,
  canvasRef,
  initialModel,
  recordId,
  t
}: RunnerRecordMonitorProps) {
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const { model, subscriptionError } = useRunnerRecordMonitor({
    api,
    canvasRef,
    initialModel,
    recordId
  });
  const interactionLabel = model.interaction.active
    ? t("acpInteractionLive")
    : model.interaction.stale
      ? t("acpInteractionStale")
      : null;
  const eventDiagnostics = model.events.flatMap((event) =>
    event.body.kind === "diagnostic"
      ? [{ code: event.body.code, line: null, message: event.body.message }]
      : []
  );
  const diagnostics = [
    ...new Map(
      [...model.diagnostics, ...eventDiagnostics].map((diagnostic) => [
        `${diagnostic.code}\0${diagnostic.line ?? ""}\0${diagnostic.message}`,
        diagnostic
      ])
    ).values()
  ];
  const activeRequestIds = new Set(
    model.interaction.activeRequests.map((request) => request.requestId)
  );
  const detailEvents = model.events.filter((event) =>
    event.body.kind === "usage_update" ||
    event.body.kind === "artifact" ||
    event.body.kind === "interaction" ||
    event.body.kind === "lifecycle"
  );
  const artifactApi = api === undefined ? bridge : api;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2" aria-label={t("acpMonitor")}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline">ACP</Badge>
        <span className="text-muted-foreground">
          {model.terminal ? t("acpTerminal") : t("acpLive")}
        </span>
        {interactionLabel ? (
          <Badge variant={model.interaction.active ? "default" : "secondary"}>
            {interactionLabel}
          </Badge>
        ) : null}
      </div>
      {subscriptionError ? (
        <div className="rounded-md border border-destructive/40 p-2 text-xs text-destructive">
          {t("acpSubscriptionError")}: {subscriptionError}
        </div>
      ) : null}
      {artifactError ? (
        <div className="rounded-md border border-destructive/40 p-2 text-xs text-destructive">
          {t("acpArtifactOpenError")}: {artifactError}
        </div>
      ) : null}
      {diagnostics.length > 0 ? (
        <div className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
          <div className="font-medium">{t("acpDiagnostics")}</div>
          {diagnostics.map((diagnostic, index) => (
            <div key={`${diagnostic.code}-${diagnostic.line ?? "stream"}-${index}`}>
              <span className="font-mono">{diagnostic.code}</span>: {diagnostic.message}
            </div>
          ))}
        </div>
      ) : null}
      {detailEvents.length > 0 ? (
        <div className="space-y-2 rounded-md border p-2 text-xs">
          <div className="font-medium">{t("acpRunDetails")}</div>
          {detailEvents.map((event) => {
            const body = event.body;
            if (body.kind === "usage_update") {
              return (
                <div key={event.sequence} className="flex flex-wrap gap-x-3 gap-y-1">
                  <Badge variant="outline">{t("acpUsage")}</Badge>
                  <span>{t("acpUsedTokens")}: {body.usedTokens}</span>
                  <span>{t("acpContextWindow")}: {body.contextWindowTokens}</span>
                  {body.cost ? <span>{t("acpCost")}: {body.cost.amount} {body.cost.currency}</span> : null}
                </div>
              );
            }
            if (body.kind === "artifact") {
              return (
                <div key={event.sequence} className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{t("acpArtifact")}</Badge>
                  <span className="font-mono">{body.artifact.kind}: {body.artifact.relativePath}</span>
                  <span>{body.artifact.sizeBytes} B</span>
                  {artifactApi && canvasRef ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        setArtifactError(null);
                        void artifactApi
                          .revealRunnerRecordArtifact(canvasRef, recordId, body.artifact)
                          .catch((error: unknown) => {
                            setArtifactError(error instanceof Error ? error.message : String(error));
                          });
                      }}
                    >
                      {t("acpRevealArtifact")}
                    </Button>
                  ) : null}
                </div>
              );
            }
            if (body.kind === "interaction") {
              const interaction = body.interaction;
              const active = activeRequestIds.has(interaction.requestId);
              return (
                <div key={event.sequence} className="space-y-1 rounded border p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={active ? "default" : "secondary"}>{interaction.kind}</Badge>
                    <span className="font-mono">{interaction.requestId}</span>
                    <span>{active ? t("acpInteractionLive") : t("acpInteractionStale")}</span>
                  </div>
                  <div className="whitespace-pre-wrap break-words">{interaction.summary}</div>
                </div>
              );
            }
            if (body.kind !== "lifecycle") return null;
            return (
              <div key={event.sequence} className="flex flex-wrap gap-2 text-muted-foreground">
                <Badge variant="outline">{t("acpLifecycle")}</Badge>
                <span>{body.state}</span>
                {body.message ? <span>{body.message}</span> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="text-xs font-medium text-muted-foreground">{t("acpConversation")}</div>
      <ScrollArea className="min-h-0 flex-1 rounded-md border p-2">
        {model.conversation.length > 0 ? (
          <div className="space-y-3">
            {model.conversation.map((item) => (
              <article key={item.sequence} className="space-y-1 text-xs">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Badge variant="outline">{item.role ?? item.kind}</Badge>
                  <span className="font-mono">#{item.sequence}</span>
                </div>
                <pre className="whitespace-pre-wrap break-words font-sans">{item.content}</pre>
              </article>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">{t("acpConversationEmpty")}</div>
        )}
      </ScrollArea>
    </section>
  );
}
