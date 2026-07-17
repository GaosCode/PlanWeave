import type {
  DesktopBridgeApi,
  DesktopCanvasReference,
  RunnerRecordReadModel
} from "@planweave-ai/runtime";
import { isRunnerRecordLiveActionIdentity } from "@planweave-ai/runtime/browser";
import { useState } from "react";
import { SendIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { bridge } from "../bridge";
import type { createTranslator } from "../i18n";
import { useRunnerRecordMonitor } from "../hooks/useRunnerRecordMonitor";
import { useRunnerInterventions } from "../hooks/useRunnerInterventions";
import { useAgentPrompt } from "../hooks/useAgentPrompt";
import {
  runnerInteractionAvailabilityLabel,
  runnerInteractionErrorLabel
} from "../runnerInteractionPresentation";
import { AcpConversationTimeline } from "./AcpConversationTimeline";

type RunnerRecordMonitorProps = {
  api?:
    | (Pick<DesktopBridgeApi, "subscribeRunnerRecord" | "revealRunnerRecordArtifact"> &
        Partial<
          Pick<
            DesktopBridgeApi,
            | "cancelAgentRun"
            | "listPendingRunnerInteractions"
            | "respondToAgentRequest"
            | "respondToRunnerInteraction"
            | "sendAgentPrompt"
          >
        >)
    | null;
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
  const actionApi = api === undefined ? bridge : api;
  const interventions = useRunnerInterventions({
    api: actionApi,
    canvasRef,
    model,
    recordId
  });
  const prompt = useAgentPrompt({
    api: actionApi,
    identity: model.intervention.prompt.identity,
    runtimeInFlight: model.intervention.prompt.inFlight
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
  const detailEvents = model.events.filter(
    (event) =>
      event.body.kind === "usage_update" ||
      event.body.kind === "artifact" ||
      event.body.kind === "interaction" ||
      event.body.kind === "interaction_result" ||
      event.body.kind === "lifecycle"
  );
  const artifactApi = api === undefined ? bridge : api;

  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden"
      aria-label={t("acpMonitor")}
      data-testid="runner-record-monitor"
    >
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
        {model.intervention.cancel.available && model.intervention.cancel.identity ? (
          <Button
            size="xs"
            variant="destructive"
            disabled={interventions.cancelInFlight}
            onClick={() => interventions.cancel(model.intervention.cancel.identity!)}
          >
            {interventions.cancelInFlight ? t("acpActionPending") : t("acpCancelRun")}
          </Button>
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
      {interventions.actionError ? (
        <div className="rounded-md border border-destructive/40 p-2 text-xs text-destructive">
          {t("acpActionError")}: {runnerInteractionErrorLabel(interventions.actionError, t)}
        </div>
      ) : null}
      {model.interaction.diagnostic ? (
        <div
          className="rounded-md border border-destructive/40 p-2 text-xs text-destructive"
          data-testid="runner-interaction-diagnostic"
        >
          <div className="font-medium">{t("acpInteractionUnavailableContract")}</div>
          <div>{model.interaction.diagnostic.message}</div>
        </div>
      ) : null}
      {model.interaction.activeRequests.length > 0 ? (
        <div className="space-y-2 rounded-md border p-2 text-xs">
          <div className="font-medium">{t("acpActions")}</div>
          {model.interaction.activeRequests
            .filter(
              (request) =>
                isRunnerRecordLiveActionIdentity(request.identity) ||
                interventions.persistedRequestIsAuthoritative(request.identity)
            )
            .map((request) => {
              const liveIdentity = isRunnerRecordLiveActionIdentity(request.identity)
                ? request.identity
                : null;
              const persistedPermissionIdentity =
                request.kind === "permission" && !liveIdentity && "ownerLeaseId" in request.identity
                  ? request.identity
                  : null;
              const transientUnavailableReason = persistedPermissionIdentity
                ? interventions.persistedRequestFailureReason(persistedPermissionIdentity)
                : null;
              const unavailableReason = runnerInteractionAvailabilityLabel(
                transientUnavailableReason ??
                  (request.availability.available ? null : request.availability.reason),
                t
              );
              return (
                <div key={request.requestId} className="space-y-2 rounded border p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{request.kind}</Badge>
                    <span className="font-mono">{request.requestId}</span>
                  </div>
                  <div className="whitespace-pre-wrap break-words">{request.summary}</div>
                  {unavailableReason ? (
                    <div className="text-muted-foreground">{unavailableReason}</div>
                  ) : request.kind === "permission" && !model.interaction.diagnostic ? (
                    <div className="flex flex-wrap gap-2">
                      {request.permissionOptions.map((option) => (
                        <Button
                          key={option.optionId}
                          size="xs"
                          variant={option.decision === "deny" ? "outline" : "default"}
                          disabled={interventions.requestInFlight(request.identity)}
                          onClick={() =>
                            interventions.respondPermission(request.identity, option.optionId)
                          }
                        >
                          {option.label}
                        </Button>
                      ))}
                      {persistedPermissionIdentity ? (
                        <Button
                          disabled={interventions.requestInFlight(persistedPermissionIdentity)}
                          onClick={() =>
                            interventions.cancelPermission(persistedPermissionIdentity)
                          }
                          size="xs"
                          variant="outline"
                        >
                          {t("acpCancelPermission")}
                        </Button>
                      ) : null}
                    </div>
                  ) : request.kind === "elicitation" && liveIdentity ? (
                    <PreviewElicitationControl
                      disabled={interventions.requestInFlight(liveIdentity)}
                      onCancel={() => interventions.respond(liveIdentity, { action: "cancel" })}
                      onSubmit={(content) =>
                        interventions.respond(liveIdentity, {
                          action: "accept",
                          content
                        })
                      }
                      schema={request.elicitationSchema}
                      t={t}
                    />
                  ) : null}
                </div>
              );
            })}
        </div>
      ) : null}
      {diagnostics.length > 0 ? (
        <div
          className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs"
          data-testid="runner-record-diagnostics"
        >
          <div className="font-medium">{t("acpDiagnostics")}</div>
          {diagnostics.map((diagnostic, index) => (
            <div
              className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
              key={`${diagnostic.code}-${diagnostic.line ?? "stream"}-${index}`}
            >
              <span className="font-mono">{diagnostic.code}</span>: {diagnostic.message}
            </div>
          ))}
        </div>
      ) : null}
      {detailEvents.length > 0 ? (
        <div className="max-h-40 space-y-2 overflow-y-auto rounded-md border p-2 text-xs">
          <div className="font-medium">{t("acpRunDetails")}</div>
          {detailEvents.map((event) => {
            const body = event.body;
            if (body.kind === "usage_update") {
              return (
                <div key={event.sequence} className="flex flex-wrap gap-x-3 gap-y-1">
                  <Badge variant="outline">{t("acpUsage")}</Badge>
                  <span>
                    {t("acpUsedTokens")}: {body.usedTokens}
                  </span>
                  <span>
                    {t("acpContextWindow")}: {body.contextWindowTokens}
                  </span>
                  {body.cost ? (
                    <span>
                      {t("acpCost")}: {body.cost.amount} {body.cost.currency}
                    </span>
                  ) : null}
                </div>
              );
            }
            if (body.kind === "artifact") {
              return (
                <div key={event.sequence} className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{t("acpArtifact")}</Badge>
                  <span className="font-mono">
                    {body.artifact.kind}: {body.artifact.relativePath}
                  </span>
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
                            setArtifactError(
                              error instanceof Error ? error.message : String(error)
                            );
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
            if (body.kind === "interaction_result") {
              return (
                <div key={event.sequence} className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{t("acpInteractionResult")}</Badge>
                  <span className="font-mono">{body.requestId}</span>
                  <span>{body.outcome}</span>
                  <span className="text-muted-foreground">{body.message}</span>
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
      <AcpConversationTimeline
        changeKey={model.cursor.afterSequence}
        timeline={model.timeline}
        t={t}
      />
      <AgentPromptComposer
        available={model.intervention.prompt.available}
        disabledReason={model.intervention.prompt.reason}
        inFlight={prompt.inFlight}
        onSend={prompt.send}
        t={t}
      />
      {prompt.error ? (
        <div className="text-xs text-destructive">
          {t("acpPromptFailed")}: {prompt.error}
        </div>
      ) : null}
    </section>
  );
}

function AgentPromptComposer({
  available,
  disabledReason,
  inFlight,
  onSend,
  t
}: {
  available: boolean;
  disabledReason: string | null;
  inFlight: boolean;
  onSend: (text: string) => Promise<boolean>;
  t: ReturnType<typeof createTranslator>;
}) {
  const [draft, setDraft] = useState("");
  const disabled = !available || inFlight;
  const submit = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    void onSend(text).then((sent) => {
      if (sent) setDraft("");
    });
  };
  return (
    <div
      className="rounded-xl border bg-background p-2 shadow-sm"
      data-testid="acp-prompt-composer"
    >
      <Textarea
        aria-label={t("acpPromptLabel")}
        className="min-h-20 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
        disabled={disabled}
        placeholder={
          available ? t("acpPromptPlaceholder") : (disabledReason ?? t("acpPromptUnavailable"))
        }
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="flex items-center justify-between gap-3 px-1 pt-1 text-[11px] text-muted-foreground">
        <span>
          {available ? t("acpPromptHint") : (disabledReason ?? t("acpPromptUnavailable"))}
        </span>
        <Button
          aria-label={t("acpSendPrompt")}
          disabled={disabled || !draft.trim()}
          size="icon-sm"
          onClick={submit}
        >
          <SendIcon />
        </Button>
      </div>
      {inFlight ? (
        <div className="px-1 pt-1 text-[11px] text-muted-foreground">{t("acpPromptSending")}</div>
      ) : null}
    </div>
  );
}

function PreviewElicitationControl({
  disabled,
  onCancel,
  onSubmit,
  schema,
  t
}: {
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (content: Record<string, string | number | boolean | string[]>) => void;
  schema: unknown;
  t: ReturnType<typeof createTranslator>;
}) {
  const [content, setContent] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2">
        {JSON.stringify(schema, null, 2)}
      </pre>
      <Textarea
        aria-label={t("acpElicitationResponse")}
        disabled={disabled}
        value={content}
        onChange={(event) => setContent(event.target.value)}
      />
      {error ? <div className="text-destructive">{error}</div> : null}
      <div className="flex gap-2">
        <Button
          size="xs"
          disabled={disabled}
          onClick={() => {
            try {
              const parsed = JSON.parse(content) as unknown;
              if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                throw new Error(t("acpElicitationObjectRequired"));
              }
              setError(null);
              onSubmit(parsed as Record<string, string | number | boolean | string[]>);
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : String(caught));
            }
          }}
        >
          {disabled ? t("acpActionPending") : t("acpSubmitElicitation")}
        </Button>
        <Button size="xs" variant="outline" disabled={disabled} onClick={onCancel}>
          {t("acpCancelElicitation")}
        </Button>
      </div>
    </div>
  );
}
