import { useCallback, useEffect, useRef, useState } from "react";
import {
  isRunnerRecordLiveActionIdentity,
  runnerInteractionIpcErrorSchema
} from "@planweave-ai/runtime/browser";
import type {
  DesktopAgentActionIdentity,
  DesktopAgentActionValue,
  DesktopAgentSessionActionIdentity,
  DesktopBridgeApi,
  DesktopCanvasReference,
  RunnerInteractionIpcError,
  RunnerInteractionAvailabilityReason,
  RunnerInteractionIdentity,
  RunnerInteractionSnapshot,
  RunnerRecordReadModel
} from "@planweave-ai/runtime";

type RunnerInterventionApi = Pick<
  DesktopBridgeApi,
  | "cancelAgentRun"
  | "listPendingRunnerInteractions"
  | "respondToAgentRequest"
  | "respondToRunnerInteraction"
>;

function identityKey(
  prefix: "cancel" | "request",
  identity: DesktopAgentSessionActionIdentity | DesktopAgentActionIdentity
): string {
  return [
    prefix,
    identity.scope,
    identity.executorRunId,
    identity.desktopRunId,
    identity.runSessionId,
    identity.claimRef,
    identity.sessionId,
    "requestId" in identity ? identity.requestId : ""
  ].join("\0");
}

function persistedIdentityKey(recordId: string, identity: RunnerInteractionIdentity): string {
  return [
    "persistent-request",
    recordId,
    identity.projectId,
    identity.canvasId,
    identity.executorRunId,
    identity.claimRef,
    identity.sessionId,
    identity.requestId,
    identity.ownerLeaseId,
    identity.ownerGeneration
  ].join("\0");
}

function interactionError(error: unknown): RunnerInteractionIpcError {
  const parsed = runnerInteractionIpcErrorSchema.safeParse(error);
  if (parsed.success) return parsed.data;
  return {
    code: "interaction_contract_invalid",
    message: error instanceof Error ? error.message : String(error),
    details: null
  };
}

function settlementRemovesRequest(code: RunnerInteractionIpcError["code"]): boolean {
  return code === "interaction_already_answered" || code === "interaction_not_found";
}

function transientAvailabilityReason(
  code: RunnerInteractionIpcError["code"]
): RunnerInteractionAvailabilityReason | null {
  switch (code) {
    case "interaction_owner_unavailable":
      return "owner_unavailable";
    case "interaction_owner_replaced":
      return "owner_replaced";
    case "interaction_run_terminal":
      return "run_terminal";
    case "interaction_contract_invalid":
      return "contract_invalid";
    default:
      return null;
  }
}

export function useRunnerInterventions(options: {
  api: Partial<RunnerInterventionApi> | null;
  canvasRef?: DesktopCanvasReference | null;
  model: RunnerRecordReadModel | null;
  recordId?: string | null;
}) {
  const { api, canvasRef = null, model, recordId = null } = options;
  const mounted = useRef(true);
  const activeOperations = useRef(new Set<string>());
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(() => new Set());
  const [actionError, setActionError] = useState<RunnerInteractionIpcError | null>(null);
  const [settledPersistedRequests, setSettledPersistedRequests] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [transientPersistedFailures, setTransientPersistedFailures] = useState<
    ReadonlyMap<string, RunnerInteractionAvailabilityReason>
  >(() => new Map());
  const firstLiveRequest = model?.interaction.activeRequests.find((request) =>
    isRunnerRecordLiveActionIdentity(request.identity)
  );
  const contextKey = model
    ? (model.intervention.cancel.identity?.scope ??
      (firstLiveRequest && isRunnerRecordLiveActionIdentity(firstLiveRequest.identity)
        ? firstLiveRequest.identity.scope
        : undefined) ??
      `${model.cursor.runId}\0${model.cursor.canonicalIdentity?.identity.claimRef ?? ""}`)
    : "runner-unavailable";
  const contextKeyRef = useRef(contextKey);
  const modelRef = useRef(model);
  contextKeyRef.current = contextKey;

  useEffect(() => {
    setSettledPersistedRequests(new Set());
    setTransientPersistedFailures(new Map());
  }, [contextKey]);

  useEffect(() => {
    const modelPersistedKeys = new Set(
      model?.interaction.activeRequests.flatMap((request) =>
        !isRunnerRecordLiveActionIdentity(request.identity) && recordId
          ? [persistedIdentityKey(recordId, request.identity)]
          : []
      ) ?? []
    );
    setSettledPersistedRequests((current) => {
      const next = new Set([...current].filter((key) => modelPersistedKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [model, recordId]);

  useEffect(() => {
    if (modelRef.current === model) return;
    modelRef.current = model;
    setActionError(null);
    setTransientPersistedFailures(new Map());
  }, [model]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const authoritativeKeys = new Set(
      model?.interaction.activeRequests.flatMap((request) =>
        isRunnerRecordLiveActionIdentity(request.identity)
          ? [identityKey("request", request.identity)]
          : recordId
            ? [persistedIdentityKey(recordId, request.identity)]
            : []
      ) ?? []
    );
    if (
      model &&
      !model.terminal &&
      model.intervention.cancel.available &&
      model.intervention.cancel.identity
    ) {
      authoritativeKeys.add(identityKey("cancel", model.intervention.cancel.identity));
    }
    let changed = false;
    for (const key of activeOperations.current) {
      if (!authoritativeKeys.has(key)) {
        activeOperations.current.delete(key);
        changed = true;
      }
    }
    if (changed) setInFlight(new Set(activeOperations.current));
  }, [model, recordId]);

  const execute = useCallback(
    async (
      key: string,
      action: () => Promise<void>,
      refreshAfterFailure?: (
        failure: RunnerInteractionIpcError
      ) => Promise<readonly RunnerInteractionSnapshot[]>
    ) => {
      if (activeOperations.current.has(key)) return;
      activeOperations.current.add(key);
      setInFlight(new Set(activeOperations.current));
      setActionError(null);
      const operationContext = contextKeyRef.current;
      try {
        await action();
      } catch (error) {
        activeOperations.current.delete(key);
        const failure = interactionError(error);
        let message = failure.message;
        let refreshedSnapshots: readonly RunnerInteractionSnapshot[] | null = null;
        if (refreshAfterFailure) {
          try {
            refreshedSnapshots = await refreshAfterFailure(failure);
          } catch (refreshError) {
            const refreshMessage = interactionError(refreshError).message;
            message = `${message} Authoritative refresh failed: ${refreshMessage}`;
          }
        }
        if (mounted.current && contextKeyRef.current === operationContext) {
          if (
            refreshedSnapshots &&
            settlementRemovesRequest(failure.code) &&
            recordId &&
            !refreshedSnapshots.some(
              (snapshot) => persistedIdentityKey(recordId, snapshot.request.identity) === key
            )
          ) {
            setSettledPersistedRequests((current) => {
              if (current.has(key)) return current;
              const next = new Set(current);
              next.add(key);
              return next;
            });
          } else {
            const reason = transientAvailabilityReason(failure.code);
            if (reason) {
              setTransientPersistedFailures((current) => {
                const next = new Map(current);
                next.set(key, reason);
                return next;
              });
            }
          }
          setInFlight(new Set(activeOperations.current));
          setActionError({ ...failure, message });
        }
      }
    },
    [recordId]
  );

  const respond = useCallback(
    (identity: DesktopAgentActionIdentity, value: DesktopAgentActionValue) => {
      if (!api?.respondToAgentRequest) {
        setActionError({
          code: "interaction_owner_unavailable",
          message: "Desktop ACP intervention bridge is unavailable.",
          details: null
        });
        return;
      }
      void execute(identityKey("request", identity), () =>
        api.respondToAgentRequest!(identity, value)
      );
    },
    [api, execute]
  );

  const respondPermission = useCallback(
    (identity: DesktopAgentActionIdentity | RunnerInteractionIdentity, optionId: string) => {
      if (isRunnerRecordLiveActionIdentity(identity)) {
        respond(identity, optionId);
        return;
      }
      if (
        !api?.respondToRunnerInteraction ||
        !api.listPendingRunnerInteractions ||
        !canvasRef ||
        !recordId
      ) {
        setActionError({
          code: "interaction_owner_unavailable",
          message: "Desktop persisted interaction bridge is unavailable.",
          details: null
        });
        return;
      }
      const action = {
        recordId,
        requestId: identity.requestId,
        ownerLeaseId: identity.ownerLeaseId
      };
      void execute(
        persistedIdentityKey(recordId, identity),
        async () => {
          const result = await api.respondToRunnerInteraction!(
            canvasRef,
            action,
            { kind: "select", optionId },
            { decisionSource: "planweave-desktop", reason: null }
          );
          if (!result.ok) throw result.error;
        },
        async () => {
          const result = await api.listPendingRunnerInteractions!(canvasRef);
          if (!result.ok) throw result.error;
          return result.value;
        }
      );
    },
    [api, canvasRef, execute, recordId, respond]
  );

  const cancelPermission = useCallback(
    (identity: RunnerInteractionIdentity) => {
      if (
        !api?.respondToRunnerInteraction ||
        !api.listPendingRunnerInteractions ||
        !canvasRef ||
        !recordId
      ) {
        setActionError({
          code: "interaction_owner_unavailable",
          message: "Desktop persisted interaction bridge is unavailable.",
          details: null
        });
        return;
      }
      void execute(
        persistedIdentityKey(recordId, identity),
        async () => {
          const result = await api.respondToRunnerInteraction!(
            canvasRef,
            {
              recordId,
              requestId: identity.requestId,
              ownerLeaseId: identity.ownerLeaseId
            },
            { kind: "cancel" },
            {
              decisionSource: "planweave-desktop",
              reason: "User cancelled the permission request in PlanWeave Desktop."
            }
          );
          if (!result.ok) throw result.error;
        },
        async () => {
          const result = await api.listPendingRunnerInteractions!(canvasRef);
          if (!result.ok) throw result.error;
          return result.value;
        }
      );
    },
    [api, canvasRef, execute, recordId]
  );

  const cancel = useCallback(
    (identity: DesktopAgentSessionActionIdentity) => {
      if (!api?.cancelAgentRun) {
        setActionError({
          code: "interaction_owner_unavailable",
          message: "Desktop ACP cancellation bridge is unavailable.",
          details: null
        });
        return;
      }
      void execute(identityKey("cancel", identity), () => api.cancelAgentRun!(identity));
    },
    [api, execute]
  );

  return {
    actionError,
    cancel,
    cancelPermission,
    cancelInFlight: model?.intervention.cancel.identity
      ? inFlight.has(identityKey("cancel", model.intervention.cancel.identity))
      : false,
    persistedRequestIsAuthoritative: (identity: RunnerInteractionIdentity) =>
      !recordId || !settledPersistedRequests.has(persistedIdentityKey(recordId, identity)),
    persistedRequestFailureReason: (identity: RunnerInteractionIdentity) =>
      recordId
        ? (transientPersistedFailures.get(persistedIdentityKey(recordId, identity)) ?? null)
        : null,
    requestInFlight: (identity: DesktopAgentActionIdentity | RunnerInteractionIdentity) =>
      isRunnerRecordLiveActionIdentity(identity)
        ? inFlight.has(identityKey("request", identity))
        : Boolean(recordId && inFlight.has(persistedIdentityKey(recordId, identity))),
    respond,
    respondPermission
  };
}
