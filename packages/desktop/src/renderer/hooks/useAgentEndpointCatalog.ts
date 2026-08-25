import type { RemoteAgentEndpoint } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import {
  OperatorControlError,
  type PlanWeaveOperatorControlApi
} from "../../shared/operatorControl";
import { operatorControlBridge } from "../bridge";
import {
  buildAgentEndpointCatalog,
  type AvailableAgentEndpoint,
  type LogicalAgentEndpointInput
} from "../collaboration/agentEndpointViewModel";

type FleetEndpointCatalogApi = Pick<PlanWeaveOperatorControlApi, "listOperatorAgentEndpoints">;
type CollaborationEndpointCatalogApi = Pick<
  PlanWeaveCollaborationApi,
  "listCollaborationAgentEndpoints"
>;

export type AgentEndpointCatalogLocator = {
  projectId: string;
  canvasId: string;
  workspaceId?: string;
};

export const agentEndpointCatalogRefreshIntervalMs = 30_000;
/** Short retry after a failed load so startup 502s do not leave the picker empty for 30s. */
export const agentEndpointCatalogRetryAfterFailureMs = 2_000;

export const HUMAN_PRINCIPAL_UNAVAILABLE_CODE = "human_principal_unavailable";

function operatorFleetErrorCode(error: unknown): string {
  if (error instanceof OperatorControlError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "agent_endpoint_request_failed";
}

export function useAgentEndpointCatalog(input: {
  enabled: boolean;
  operatorProfileId: string | null;
  humanPrincipalId: string | null;
  locator: AgentEndpointCatalogLocator | null;
  logicalExecutors: readonly LogicalAgentEndpointInput[];
  fleetApi?: FleetEndpointCatalogApi | null;
  fleetCatalogBlockedCode?: string | null;
  collaborationApi?: CollaborationEndpointCatalogApi | null;
  sessionConnected?: boolean;
}): {
  endpoints: AvailableAgentEndpoint[];
  error: string | null;
  errorCode: string | null;
  refreshing: boolean;
  refresh: () => Promise<void>;
} {
  const fleetApi = input.fleetApi === undefined ? operatorControlBridge : input.fleetApi;
  const listFleetEndpoints = fleetApi?.listOperatorAgentEndpoints;
  const listCollaborationEndpoints = input.collaborationApi?.listCollaborationAgentEndpoints;
  const [remoteEndpoints, setRemoteEndpoints] = useState<RemoteAgentEndpoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const generationRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const quickRetryAttemptedRef = useRef(false);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const operatorProfileId = input.operatorProfileId;
  const humanPrincipalId = input.humanPrincipalId;
  const locator = input.locator;
  const operatorProfileIdRef = useRef(operatorProfileId);
  operatorProfileIdRef.current = operatorProfileId;
  const humanPrincipalIdRef = useRef(humanPrincipalId);
  humanPrincipalIdRef.current = humanPrincipalId;
  const locatorKey = locator
    ? `${locator.projectId}:${locator.canvasId}:${locator.workspaceId ?? ""}`
    : "";
  const locatorKeyRef = useRef(locatorKey);
  locatorKeyRef.current = locatorKey;
  const locatorRef = useRef(locator);
  locatorRef.current = locator;
  const remoteEndpointsRef = useRef(remoteEndpoints);
  remoteEndpointsRef.current = remoteEndpoints;

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    const requestProfileId = operatorProfileId;
    const requestPrincipalId = humanPrincipalId;
    const requestLocator = locatorRef.current;
    const requestLocatorKey = locatorKey;
    const canWrite = () =>
      generation === generationRef.current &&
      requestProfileId === operatorProfileIdRef.current &&
      requestPrincipalId === humanPrincipalIdRef.current &&
      requestLocatorKey === locatorKeyRef.current;
    if (!requestPrincipalId || !requestLocator) {
      clearRetryTimer();
      setRemoteEndpoints([]);
      const code = !requestPrincipalId
        ? HUMAN_PRINCIPAL_UNAVAILABLE_CODE
        : (input.fleetCatalogBlockedCode ?? null);
      setError(code);
      setErrorCode(code);
      setRefreshing(false);
      return;
    }
    const useOperator = Boolean(input.enabled && requestProfileId && listFleetEndpoints);
    const useCollaboration = Boolean(
      !useOperator &&
        requestLocator.workspaceId &&
        input.sessionConnected &&
        listCollaborationEndpoints
    );
    if (!useOperator && !useCollaboration) {
      clearRetryTimer();
      setRemoteEndpoints([]);
      setError(input.fleetCatalogBlockedCode ?? null);
      setErrorCode(input.fleetCatalogBlockedCode ?? null);
      setRefreshing(false);
      return;
    }
    setRefreshing(true);
    setError(null);
    setErrorCode(null);
    try {
      const result = useOperator
        ? await listFleetEndpoints!({
            profileId: requestProfileId!,
            humanPrincipalId: requestPrincipalId,
            projectId: requestLocator.projectId,
            canvasId: requestLocator.canvasId,
            ...(requestLocator.workspaceId === undefined
              ? {}
              : { workspaceId: requestLocator.workspaceId })
          })
        : await listCollaborationEndpoints!({
            projectId: requestLocator.projectId,
            canvasId: requestLocator.canvasId,
            humanPrincipalId: requestPrincipalId,
            ...(requestLocator.workspaceId === undefined
              ? {}
              : { workspaceId: requestLocator.workspaceId })
          });
      if (canWrite()) {
        clearRetryTimer();
        quickRetryAttemptedRef.current = false;
        setRemoteEndpoints(result.items);
      }
    } catch (caught: unknown) {
      if (canWrite()) {
        const code = operatorFleetErrorCode(caught);
        setError(code);
        setErrorCode(code);
        if (
          remoteEndpointsRef.current.length === 0 &&
          retryTimerRef.current === null &&
          !quickRetryAttemptedRef.current
        ) {
          quickRetryAttemptedRef.current = true;
          retryTimerRef.current = window.setTimeout(() => {
            retryTimerRef.current = null;
            void refreshRef.current();
          }, agentEndpointCatalogRetryAfterFailureMs);
        }
      }
    } finally {
      if (canWrite()) setRefreshing(false);
    }
  }, [
    clearRetryTimer,
    humanPrincipalId,
    input.enabled,
    input.fleetCatalogBlockedCode,
    input.sessionConnected,
    listCollaborationEndpoints,
    listFleetEndpoints,
    locatorKey,
    operatorProfileId
  ]);
  refreshRef.current = refresh;

  useEffect(() => {
    quickRetryAttemptedRef.current = false;
    void refresh();
    return () => {
      generationRef.current += 1;
      clearRetryTimer();
    };
  }, [clearRetryTimer, refresh]);

  useEffect(() => {
    if (!humanPrincipalId || !locatorKey) return;
    const interval = window.setInterval(() => {
      void refresh();
    }, agentEndpointCatalogRefreshIntervalMs);
    return () => {
      window.clearInterval(interval);
    };
  }, [humanPrincipalId, locatorKey, refresh]);

  const endpoints = useMemo(() => {
    const catalog = buildAgentEndpointCatalog({
      logicalExecutors: input.logicalExecutors,
      remote: remoteEndpoints
    });
    return errorCode &&
      errorCode !== input.fleetCatalogBlockedCode &&
      errorCode !== HUMAN_PRINCIPAL_UNAVAILABLE_CODE
      ? catalog.map((endpoint) =>
          endpoint.source === "remote"
            ? {
                ...endpoint,
                available: false,
                unavailableReason: "agent_endpoint_request_failed"
              }
            : endpoint
        )
      : catalog;
  }, [errorCode, input.fleetCatalogBlockedCode, input.logicalExecutors, remoteEndpoints]);

  return { endpoints, error, errorCode, refreshing, refresh };
}
