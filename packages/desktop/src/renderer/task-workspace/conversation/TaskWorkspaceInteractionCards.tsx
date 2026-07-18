import type {
  AgentRunControlRespondOutcome,
  DesktopAgentSessionActionIdentity,
  DesktopBridgeApi,
  DesktopCanvasReference,
  RunnerRecordReadModel
} from "@planweave-ai/runtime";
import { isRunnerRecordLiveActionIdentity } from "@planweave-ai/runtime/browser";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { createTranslator } from "../../i18n";
import { useRunnerInterventions } from "../../hooks/useRunnerInterventions";
import {
  runnerInteractionAvailabilityLabel,
  runnerInteractionErrorLabel
} from "../../runnerInteractionPresentation";
import { sameSessionActionIdentity } from "./actionIdentity";

type InteractionRequest = RunnerRecordReadModel["interaction"]["activeRequests"][number];

type ElicitationField = {
  kind: "boolean" | "number" | "string";
  label: string;
  name: string;
  required: boolean;
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function elicitationFields(schema: unknown): ElicitationField[] | null {
  const root = objectValue(schema);
  const properties = objectValue(root?.properties);
  if (!root || root.type !== "object" || !properties) return null;
  const required = Array.isArray(root.required)
    ? new Set(root.required.filter((value): value is string => typeof value === "string"))
    : new Set<string>();
  const fields: ElicitationField[] = [];
  for (const [name, rawProperty] of Object.entries(properties)) {
    const property = objectValue(rawProperty);
    if (!property || !["boolean", "integer", "number", "string"].includes(String(property.type))) {
      return null;
    }
    const kind =
      property.type === "boolean"
        ? "boolean"
        : property.type === "integer" || property.type === "number"
          ? "number"
          : "string";
    fields.push({
      kind,
      label: typeof property.title === "string" && property.title.trim() ? property.title : name,
      name,
      required: required.has(name)
    });
  }
  return fields;
}

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

function StructuredElicitation({
  disabled,
  onCancel,
  onSubmit,
  schema,
  t
}: {
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (content: Record<string, string | number | boolean>) => void;
  schema: unknown;
  t: ReturnType<typeof createTranslator>;
}) {
  const fields = useMemo(() => elicitationFields(schema), [schema]);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [error, setError] = useState<string | null>(null);
  if (!fields) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {t("taskWorkspaceStructuredRequestUnsupported")}
        </p>
        <Button disabled={disabled} onClick={onCancel} size="sm" type="button" variant="outline">
          {t("acpCancelElicitation")}
        </Button>
      </div>
    );
  }
  const submit = () => {
    const content: Record<string, string | number | boolean> = {};
    for (const field of fields) {
      const value = values[field.name];
      if (field.required && (value === undefined || value === "")) {
        setError(t("taskWorkspaceFieldRequired").replace("{field}", field.label));
        return;
      }
      if (value === undefined || value === "") continue;
      if (field.kind === "number") {
        const number = Number(value);
        if (!Number.isFinite(number)) {
          setError(t("taskWorkspaceFieldNumber").replace("{field}", field.label));
          return;
        }
        content[field.name] = number;
      } else {
        content[field.name] = value;
      }
    }
    setError(null);
    onSubmit(content);
  };
  return (
    <div className="space-y-3">
      {fields.map((field) => (
        <label className="grid gap-1 text-xs" key={field.name}>
          <span className="font-medium">
            {field.label}
            {field.required ? " *" : ""}
          </span>
          {field.kind === "boolean" ? (
            <input
              checked={values[field.name] === true}
              className="size-4"
              disabled={disabled}
              onChange={(event) =>
                setValues((current) => ({ ...current, [field.name]: event.target.checked }))
              }
              type="checkbox"
            />
          ) : (
            <Input
              disabled={disabled}
              onChange={(event) =>
                setValues((current) => ({ ...current, [field.name]: event.target.value }))
              }
              type={field.kind === "number" ? "number" : "text"}
              value={typeof values[field.name] === "string" ? String(values[field.name]) : ""}
            />
          )}
        </label>
      ))}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button disabled={disabled} onClick={submit} size="sm" type="button">
          {disabled ? t("acpActionPending") : t("acpSubmitElicitation")}
        </Button>
        <Button disabled={disabled} onClick={onCancel} size="sm" type="button" variant="outline">
          {t("acpCancelElicitation")}
        </Button>
      </div>
    </div>
  );
}
