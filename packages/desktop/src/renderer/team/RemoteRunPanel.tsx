import type { RemoteAgentEndpoint } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { DesktopCanvasReference, RemoteBlockExecutionReadModel } from "@planweave-ai/runtime";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { createTranslator } from "../i18n";
import { useRemoteRunPanelController } from "../hooks/useRemoteRunPanelController";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import type { RemoteRunAuthorizedActionKind } from "../collaboration/remoteRunViewModels";
import { remoteRunLifecyclePhaseLabel } from "../collaboration/remoteRunLifecycleCopy";
import { formatAgentEndpointUnavailableReason } from "../collaboration/formatAgentEndpointUnavailableReason";
import {
  agentEndpointDisplayLabel,
  type AvailableAgentEndpoint,
  type LocalAgentEndpointInput,
  type LogicalAgentEndpointInput
} from "../collaboration/agentEndpointViewModel";
import { inheritAgentEndpointValue } from "../collaboration/AgentEndpointSelect";
import { AgentEndpointFleetCatalogHint } from "../collaboration/AgentEndpointFleetCatalogHint";

export type RemoteRunPanelProps = {
  agentEndpointCatalogErrorCode?: string | null;
  agentEndpoints?: readonly AvailableAgentEndpoint[];
  workItem: WorkItemRef | null;
  runtimeRemoteExecution?: RemoteBlockExecutionReadModel | null;
  localAutoRunActive?: boolean;
  canvasRef?: DesktopCanvasReference | null;
  localAgentEndpoints?: readonly LocalAgentEndpointInput[];
  logicalExecutors?: readonly LogicalAgentEndpointInput[];
  requiredProfileId?: string | null;
  requiredAgentId?: RemoteAgentEndpoint["agentId"] | null;
  requiredCapabilities?: readonly string[];
  open?: boolean;
  api?: PlanWeaveCollaborationApi | null;
  onAgentEndpointChange?: (endpointId: string) => void;
  inheritAgentEndpointLabel?: string;
  onRefreshAgentEndpoints?: () => Promise<void>;
  refreshingAgentEndpoints?: boolean;
  selectedAgentEndpointId?: string | null;
  t: ReturnType<typeof createTranslator>;
  className?: string;
};

function actionLabel(
  kind: RemoteRunAuthorizedActionKind,
  t: ReturnType<typeof createTranslator>
): string {
  switch (kind) {
    case "dispatch":
      return t("remoteRunActionDispatch");
    case "answer_interaction":
      return t("remoteRunActionAnswer");
    case "cancel":
      return t("remoteRunActionCancel");
    case "resume_same_session":
      return t("remoteRunActionResume");
    case "fail_interruption":
      return t("remoteRunActionFail");
    case "retry_new_attempt":
      return t("remoteRunActionRetry");
  }
}

/** Unified local Auto Run and remote ACP execution control with distinct runtime authorities. */
export function RemoteRunPanel({
  agentEndpointCatalogErrorCode = null,
  agentEndpoints,
  workItem,
  runtimeRemoteExecution = null,
  localAutoRunActive = false,
  canvasRef = null,
  localAgentEndpoints = [],
  logicalExecutors,
  requiredProfileId = null,
  requiredAgentId = null,
  requiredCapabilities = [],
  open = true,
  api,
  onAgentEndpointChange,
  inheritAgentEndpointLabel,
  onRefreshAgentEndpoints,
  refreshingAgentEndpoints,
  selectedAgentEndpointId,
  t,
  className
}: RemoteRunPanelProps) {
  const controller = useRemoteRunPanelController({
    agentEndpoints,
    workItem,
    runtimeRemoteExecution,
    localAutoRunActive,
    canvasRef,
    localAgentEndpoints,
    logicalExecutors,
    requiredProfileId,
    requiredAgentId,
    requiredCapabilities,
    open,
    api,
    onAgentEndpointChange,
    refreshAgentEndpoints: onRefreshAgentEndpoints,
    refreshingAgentEndpoints,
    selectedAgentEndpointId,
    t
  });

  const availableActions = useMemo(
    () => controller.viewModel.actions.filter((action) => action.available),
    [controller.viewModel.actions]
  );

  if (!workItem || workItem.kind !== "block") {
    return null;
  }

  const { viewModel } = controller;
  const identity = viewModel.identity;

  return (
    <section
      className={cn(
        "flex min-h-0 flex-col gap-2 rounded-lg border border-amber-500/30 bg-app-panel/60 p-2.5",
        className
      )}
      data-testid="remote-run-panel"
      data-remote-run-phase={viewModel.phase}
      data-authority="remote_dispatch"
      aria-label={t("remoteRunTitle")}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t("remoteRunTitle")}</div>
          <p className="text-[11px] text-muted-foreground" data-testid="remote-run-notice">
            {t("remoteRunNotice")}
          </p>
        </div>
        <Badge
          variant={viewModel.actionRequired ? "destructive" : "outline"}
          data-testid="remote-run-phase"
        >
          {remoteRunLifecyclePhaseLabel(viewModel.phase, t)}
        </Badge>
      </div>

      <div aria-live="polite" className="sr-only" data-testid="remote-run-live-region">
        {controller.actionError ?? remoteRunLifecyclePhaseLabel(viewModel.phase, t)}
      </div>

      {viewModel.localAutoRunCoexisting ? (
        <p
          className="rounded-md border border-border/70 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground"
          data-testid="remote-run-local-coexistence"
        >
          {t("remoteRunLocalCoexistence")}
        </p>
      ) : null}

      {controller.legacyHostTargetPresent ? (
        <p
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px]"
          data-testid="remote-run-legacy-host-target-notice"
        >
          {t("remoteRunLegacyHostTargetNotice")}
        </p>
      ) : null}

      <div className="flex flex-col gap-1" data-testid="agent-endpoint-selector">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium">{t("agentEndpointLabel")}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={controller.refreshingAgentEndpoints}
            onClick={() => void controller.refreshAgentEndpoints()}
          >
            {t("agentEndpointRefresh")}
          </Button>
        </div>
        <Select
          value={controller.selectedAgentEndpointId ?? undefined}
          onValueChange={controller.setSelectedAgentEndpointId}
        >
          <SelectTrigger aria-label={t("agentEndpointLabel")} data-testid="agent-endpoint-select">
            <SelectValue placeholder={t("agentEndpointPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {inheritAgentEndpointLabel ? (
              <SelectItem value={inheritAgentEndpointValue}>{inheritAgentEndpointLabel}</SelectItem>
            ) : null}
            {controller.agentEndpoints.map((endpoint) => (
              <SelectItem key={endpoint.id} value={endpoint.id} disabled={!endpoint.available}>
                {agentEndpointDisplayLabel(endpoint)}
                {!endpoint.available
                  ? ` — ${formatAgentEndpointUnavailableReason(endpoint.unavailableReason, t)}`
                  : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <AgentEndpointFleetCatalogHint
          className="text-[10px] text-destructive"
          errorCode={agentEndpointCatalogErrorCode}
          t={t}
        />
        <p className="text-[10px] text-muted-foreground">{t("agentEndpointLocalHint")}</p>
      </div>

      {identity ? (
        <dl
          className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px]"
          data-testid="remote-run-identity"
        >
          <dt className="text-muted-foreground">{t("remoteRunOperationId")}</dt>
          <dd className="truncate font-mono">{identity.operationId}</dd>
          <dt className="text-muted-foreground">{t("remoteRunDispatchId")}</dt>
          <dd className="truncate font-mono">{identity.dispatchId}</dd>
          <dt className="text-muted-foreground">{t("remoteRunAttemptId")}</dt>
          <dd className="truncate font-mono">{identity.executionAttemptId}</dd>
          <dt className="text-muted-foreground">{t("remoteRunEndpoint")}</dt>
          <dd className="truncate">
            {identity.agentEndpoint
              ? `${identity.agentEndpoint.displayName} — ${identity.agentEndpoint.hostDisplayName}`
              : t("remoteRunLegacyRemote")}
          </dd>
          <dt className="text-muted-foreground">{t("remoteRunLeaseId")}</dt>
          <dd className="truncate font-mono">{identity.leaseId ?? t("remoteRunUnavailable")}</dd>
          <dt className="text-muted-foreground">{t("remoteRunSessionId")}</dt>
          <dd className="truncate font-mono">
            {identity.acpSessionId ?? t("remoteRunUnavailable")}
          </dd>
          <dt className="text-muted-foreground">{t("remoteRunAttemptVersion")}</dt>
          <dd className="font-mono">{identity.attemptVersion}</dd>
        </dl>
      ) : (
        <p className="text-[11px] text-muted-foreground" data-testid="remote-run-no-operation">
          {viewModel.assignmentEligibleForDispatch
            ? t("remoteRunReadyToDispatch")
            : t("remoteRunNoActiveOperation")}
        </p>
      )}

      {viewModel.runtimeBindingSummary ? (
        <p className="text-[11px]" data-testid="remote-run-runtime-result">
          <span className="text-muted-foreground">{t("remoteRunRuntimeResult")}: </span>
          <span className="font-mono">{viewModel.runtimeBindingSummary}</span>
        </p>
      ) : null}

      {viewModel.pendingInteractions.length > 0 ? (
        <div className="flex flex-col gap-1" data-testid="remote-run-interactions">
          <div className="text-[11px] font-medium">{t("remoteRunPendingInteractions")}</div>
          {viewModel.pendingInteractions.map((interaction) => (
            <div
              key={interaction.request.actionId}
              className="rounded-md border border-border/70 px-2 py-1 text-[11px]"
              data-testid="remote-run-interaction"
              data-interaction-type={interaction.request.type}
            >
              <div className="font-medium">{interaction.request.type}</div>
              <div className="text-muted-foreground">
                {interaction.request.type === "interaction.permission_requested"
                  ? interaction.request.title
                  : interaction.request.type === "interaction.elicitation_requested"
                    ? interaction.request.prompt
                    : interaction.request.hostInstruction}
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {interaction.request.type === "interaction.permission_requested" ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      data-testid="remote-run-interaction-allow"
                      disabled={controller.actionInFlight === "answer_interaction"}
                      onClick={() =>
                        void controller.answerInteraction({
                          type: "interaction.permission_response",
                          decision: "allow_once",
                          actionId: interaction.request.actionId,
                          dispatchId: interaction.request.dispatchId,
                          leaseId: interaction.request.leaseId,
                          executionAttemptId: interaction.request.executionAttemptId,
                          acpSessionId: interaction.request.acpSessionId
                        })
                      }
                    >
                      {t("remoteRunInteractionAllow")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="remote-run-interaction-deny"
                      disabled={controller.actionInFlight === "answer_interaction"}
                      onClick={() =>
                        void controller.answerInteraction({
                          type: "interaction.permission_response",
                          decision: "deny",
                          actionId: interaction.request.actionId,
                          dispatchId: interaction.request.dispatchId,
                          leaseId: interaction.request.leaseId,
                          executionAttemptId: interaction.request.executionAttemptId,
                          acpSessionId: interaction.request.acpSessionId
                        })
                      }
                    >
                      {t("remoteRunInteractionDeny")}
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {viewModel.events.length > 0 ? (
        <div className="flex max-h-40 flex-col gap-1 overflow-auto" data-testid="remote-run-events">
          <div className="text-[11px] font-medium">{t("remoteRunAcpEvents")}</div>
          {viewModel.events.map((event) => (
            <div
              key={event.cursor}
              className="rounded border border-border/50 px-1.5 py-1 font-mono text-[10px]"
              data-testid="remote-run-event"
              data-event-kind={event.kind}
              data-event-cursor={event.cursor}
            >
              <span className="text-muted-foreground">#{event.cursor} </span>
              <span>{event.kind}</span>
              {"text" in event && event.text ? (
                <span className="text-muted-foreground"> — {event.text.slice(0, 160)}</span>
              ) : null}
              {"title" in event && event.title ? (
                <span className="text-muted-foreground"> — {event.title}</span>
              ) : null}
              {"message" in event && event.message ? (
                <span className="text-muted-foreground"> — {event.message.slice(0, 160)}</span>
              ) : null}
            </div>
          ))}
          {viewModel.eventsHasMore ? (
            <Button
              size="sm"
              variant="ghost"
              data-testid="remote-run-events-load-more"
              disabled={controller.loadingEvents}
              onClick={() => void controller.loadMoreEvents()}
            >
              {t("remoteRunLoadMoreEvents")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {controller.actionError ? (
        <p className="text-[11px] text-destructive" data-testid="remote-run-error" role="alert">
          {controller.actionError}
        </p>
      ) : null}

      {controller.confirmKind ? (
        <div
          className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/5 p-2"
          data-testid="remote-run-confirm"
        >
          <p className="text-[11px]">
            {controller.confirmKind === "cancel"
              ? t("remoteRunConfirmCancel")
              : controller.confirmKind === "retry_new_attempt"
                ? t("remoteRunConfirmRetry")
                : t("remoteRunConfirmFail")}
          </p>
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant="destructive"
              data-testid="remote-run-confirm-yes"
              onClick={() => {
                if (controller.confirmKind === "cancel") {
                  void controller.cancel(t("remoteRunDefaultCancelReason"));
                } else if (controller.confirmKind === "fail_interruption") {
                  void controller.failInterruption(t("remoteRunDefaultFailReason"));
                } else if (controller.confirmKind === "retry_new_attempt" && identity) {
                  void controller.retryNewAttempt({
                    newDispatchId: `dispatch-retry-${Date.now()}`,
                    newExecutionAttemptId: `attempt-retry-${Date.now()}`,
                    reason: t("remoteRunDefaultRetryReason")
                  });
                }
              }}
            >
              {t("remoteRunConfirmYes")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="remote-run-confirm-no"
              onClick={() => controller.setConfirmKind(null)}
            >
              {t("remoteRunConfirmNo")}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1" data-testid="remote-run-actions">
        {availableActions.map((action) => (
          <Button
            key={action.kind}
            size="sm"
            variant={action.kind === "dispatch" ? "default" : "secondary"}
            data-testid={`remote-run-action-${action.kind}`}
            disabled={controller.actionInFlight !== null || controller.loading}
            onClick={() => {
              if (!action.available) return;
              if (action.requiresConfirm) {
                if (action.kind === "cancel") controller.setConfirmKind("cancel");
                else if (action.kind === "retry_new_attempt") {
                  controller.setConfirmKind("retry_new_attempt");
                } else if (action.kind === "fail_interruption") {
                  controller.setConfirmKind("fail_interruption");
                }
                return;
              }
              if (action.kind === "dispatch") void controller.dispatch();
              if (action.kind === "resume_same_session") {
                // Recovery + prior lease come from observation inside the controller;
                // do not mint recoveryId/leaseId in the renderer.
                void controller.resume(t("remoteRunDefaultResumeReason"));
              }
            }}
          >
            {actionLabel(action.kind, t)}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          data-testid="remote-run-refresh"
          disabled={controller.loading}
          onClick={() => void controller.refresh()}
        >
          {t("remoteRunRefresh")}
        </Button>
      </div>
    </section>
  );
}
