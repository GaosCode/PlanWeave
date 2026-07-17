import { useCallback, useEffect, useRef, useState } from "react";
import { isRunnerRecordLiveActionIdentity } from "@planweave-ai/runtime";
import type {
  DesktopAgentActionIdentity,
  DesktopAgentActionValue,
  DesktopAgentSessionActionIdentity,
  DesktopBridgeApi,
  RunnerRecordReadModel
} from "@planweave-ai/runtime";

type RunnerInterventionApi = Pick<DesktopBridgeApi, "cancelAgentRun" | "respondToAgentRequest">;

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

export function useRunnerInterventions(options: {
  api: Partial<RunnerInterventionApi> | null;
  model: RunnerRecordReadModel | null;
}) {
  const { api, model } = options;
  const mounted = useRef(true);
  const activeOperations = useRef(new Set<string>());
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);
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
  contextKeyRef.current = contextKey;

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
  }, [model]);

  const execute = useCallback(async (key: string, action: () => Promise<void>) => {
    if (activeOperations.current.has(key)) return;
    activeOperations.current.add(key);
    setInFlight(new Set(activeOperations.current));
    setActionError(null);
    const operationContext = contextKeyRef.current;
    try {
      await action();
    } catch (error) {
      activeOperations.current.delete(key);
      if (mounted.current && contextKeyRef.current === operationContext) {
        setInFlight(new Set(activeOperations.current));
        setActionError(error instanceof Error ? error.message : String(error));
      }
    }
  }, []);

  const respond = useCallback(
    (identity: DesktopAgentActionIdentity, value: DesktopAgentActionValue) => {
      if (!api?.respondToAgentRequest) {
        setActionError("Desktop ACP intervention bridge is unavailable.");
        return;
      }
      void execute(identityKey("request", identity), () =>
        api.respondToAgentRequest!(identity, value)
      );
    },
    [api, execute]
  );

  const cancel = useCallback(
    (identity: DesktopAgentSessionActionIdentity) => {
      if (!api?.cancelAgentRun) {
        setActionError("Desktop ACP cancellation bridge is unavailable.");
        return;
      }
      void execute(identityKey("cancel", identity), () => api.cancelAgentRun!(identity));
    },
    [api, execute]
  );

  return {
    actionError,
    cancel,
    cancelInFlight: model?.intervention.cancel.identity
      ? inFlight.has(identityKey("cancel", model.intervention.cancel.identity))
      : false,
    requestInFlight: (identity: DesktopAgentActionIdentity) =>
      inFlight.has(identityKey("request", identity)),
    respond
  };
}
