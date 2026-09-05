import { StructuredElicitation } from "./StructuredElicitation";
import type {
  AgentRunControlRespondOutcome,
  DesktopAgentSessionActionIdentity,
  DesktopBridgeApi,
  DesktopCanvasReference,
  RunnerRecordReadModel
} from "@planweave-ai/runtime";
import { isRunnerRecordLiveActionIdentity } from "@planweave-ai/runtime/browser";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../../i18n";
import { useRunnerInterventions } from "../../hooks/useRunnerInterventions";
import {
  runnerInteractionAvailabilityLabel,
  runnerInteractionErrorLabel
} from "../../runnerInteractionPresentation";
import { sameSessionActionIdentity } from "./actionIdentity";

type InteractionRequest = RunnerRecordReadModel["interaction"]["activeRequests"][number];

export function TaskWorkspaceInteractionCards({
  api,
  canvasRef,
  model,
  recordId,
  sessionIdentity,
  t
}: {
  api: Partial<
    Pick<
      DesktopBridgeApi,
      | "cancelAgentRun"
      | "listPendingRunnerInteractions"
      | "respondToAgentRequest"
      | "respondToRunnerInteraction"
    >
  > | null;
  canvasRef: DesktopCanvasReference;
  model: RunnerRecordReadModel;
  recordId: string;
  sessionIdentity: DesktopAgentSessionActionIdentity | null;
  t: ReturnType<typeof createTranslator>;
}) {
  const interventions = useRunnerInterventions({ api, canvasRef, model, recordId });
  const visibleRequests = model.interaction.activeRequests.filter(
    (request) =>
      isRunnerRecordLiveActionIdentity(request.identity) ||
      interventions.persistedRequestIsAuthoritative(request.identity)
  );
  if (visibleRequests.length === 0 && !model.interaction.diagnostic && !interventions.actionError)
    return null;

  return (
    <section
      aria-label={t("acpActions")}
      className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 shadow-sm"
      data-testid="task-workspace-interactions"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{t("acpActions")}</h2>
        <Badge>{t("acpInteractionLive")}</Badge>
      </div>
      {interventions.actionError ? (
        <p className="text-xs text-destructive" role="alert">
          {t("acpActionError")}: {runnerInteractionErrorLabel(interventions.actionError, t)}
        </p>
      ) : null}
      {model.interaction.diagnostic ? (
        <div className="text-xs text-destructive" data-testid="runner-interaction-diagnostic">
          <div className="font-medium">{t("acpInteractionUnavailableContract")}</div>
          <div>{model.interaction.diagnostic.message}</div>
        </div>
      ) : null}
      {visibleRequests.map((request) => {
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
        return (
          <InteractionCard
            cancelLabel={t("acpCancelPermission")}
            disabledReason={
              model.interaction.diagnostic
                ? t("acpInteractionUnavailableContract")
                : transientUnavailableReason
                  ? runnerInteractionAvailabilityLabel(transientUnavailableReason, t)
                  : liveIdentity && !sameSessionActionIdentity(liveIdentity, sessionIdentity)
                    ? t("taskWorkspaceRequestIdentityMismatch")
                    : liveIdentity || persistedPermissionIdentity
                      ? null
                      : t("acpInteractionStale")
            }
            inFlight={interventions.requestInFlight(request.identity)}
            key={request.interactionId}
            onCancel={
              request.kind === "permission" && (liveIdentity || persistedPermissionIdentity)
                ? () => interventions.cancelPermission(liveIdentity ?? persistedPermissionIdentity!)
                : null
            }
            onElicitationRespond={
              request.kind === "elicitation" && liveIdentity
                ? (value) => interventions.respond(liveIdentity, value)
                : null
            }
            onPermissionRespond={
              request.kind === "permission"
                ? (optionId) => interventions.respondPermission(request.identity, optionId)
                : null
            }
            request={request}
            t={t}
          />
        );
      })}
    </section>
  );
}

function InteractionCard({
  cancelLabel,
  disabledReason,
  inFlight,
  onCancel,
  onElicitationRespond,
  onPermissionRespond,
  request,
  t
}: {
  cancelLabel: string;
  disabledReason: string | null;
  inFlight: boolean;
  onCancel: (() => void) | null;
  onElicitationRespond:
    | ((value: Extract<AgentRunControlRespondOutcome, { action: string }>) => void)
    | null;
  onPermissionRespond: ((optionId: string) => void) | null;
  request: InteractionRequest;
  t: ReturnType<typeof createTranslator>;
}) {
  const unavailableReason =
    disabledReason ??
    (request.availability.available
      ? null
      : runnerInteractionAvailabilityLabel(request.availability.reason, t));
  return (
    <article className="space-y-3 rounded-lg border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{request.kind}</Badge>
        <span className="font-mono text-[11px] text-muted-foreground">{request.requestId}</span>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">{request.summary}</p>
      {unavailableReason ? (
        <p className="text-xs text-muted-foreground">{unavailableReason}</p>
      ) : null}
      {!unavailableReason && onPermissionRespond && request.kind === "permission" ? (
        <div className="flex flex-wrap gap-2">
          {request.permissionOptions.map((option) => (
            <Button
              disabled={inFlight}
              key={option.optionId}
              onClick={() => onPermissionRespond(option.optionId)}
              size="sm"
              type="button"
              variant={option.decision === "deny" ? "outline" : "default"}
            >
              {inFlight ? t("acpActionPending") : option.label}
            </Button>
          ))}
          {onCancel ? (
            <Button
              disabled={inFlight}
              onClick={onCancel}
              size="sm"
              type="button"
              variant="outline"
            >
              {inFlight ? t("acpActionPending") : cancelLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
      {!unavailableReason && onElicitationRespond && request.kind === "elicitation" ? (
        <StructuredElicitation
          disabled={inFlight}
          onCancel={() => onElicitationRespond({ action: "cancel" })}
          onSubmit={(content) => onElicitationRespond({ action: "accept", content })}
          schema={request.elicitationSchema}
          t={t}
        />
      ) : null}
    </article>
  );
}
