import type { RemoteAgentEndpoint } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

export const agentEndpointCatalogRefreshIntervalMs = 30_000;
/** Short retry after a failed load so startup 502s do not leave the picker empty for 30s. */
export const agentEndpointCatalogRetryAfterFailureMs = 2_000;

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
  logicalExecutors: readonly LogicalAgentEndpointInput[];
  fleetApi?: FleetEndpointCatalogApi | null;
  fleetCatalogBlockedCode?: string | null;
}): {
  endpoints: AvailableAgentEndpoint[];
  error: string | null;
  errorCode: string | null;
  refreshing: boolean;
  refresh: () => Promise<void>;
} {
  const fleetApi = input.fleetApi === undefined ? operatorControlBridge : input.fleetApi;
  const listFleetEndpoints = fleetApi?.listOperatorAgentEndpoints;
  const [remoteEndpoints, setRemoteEndpoints] = useState<RemoteAgentEndpoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const generationRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const quickRetryAttemptedRef = useRef(false);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const operatorProfileId = input.operatorProfileId;
  const operatorProfileIdRef = useRef(operatorProfileId);
  operatorProfileIdRef.current = operatorProfileId;
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
    const canWrite = () =>
      generation === generationRef.current && requestProfileId === operatorProfileIdRef.current;
    if (!input.enabled || !requestProfileId || !listFleetEndpoints) {
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
      const result = await listFleetEndpoints({ profileId: requestProfileId });
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
        // Keep last successful remotes and allow one startup retry before the regular interval.
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
    listFleetEndpoints,
    input.enabled,
    input.fleetCatalogBlockedCode,
    operatorProfileId
  ]);
  refreshRef.current = refresh;

  useEffect(() => {
    // Do not clear remotes here: a failed refresh after clear would hide fleet hosts.
    quickRetryAttemptedRef.current = false;
    void refresh();
    return () => {
      generationRef.current += 1;
      clearRetryTimer();
    };
  }, [clearRetryTimer, refresh]);

  useEffect(() => {
    if (!input.enabled || !operatorProfileId) return;
    const interval = window.setInterval(() => {
      void refresh();
    }, agentEndpointCatalogRefreshIntervalMs);
    return () => {
      window.clearInterval(interval);
    };
  }, [input.enabled, operatorProfileId, refresh]);

  const endpoints = useMemo(() => {
    const catalog = buildAgentEndpointCatalog({
      logicalExecutors: input.logicalExecutors,
      remote: remoteEndpoints
    });
    return errorCode && errorCode !== input.fleetCatalogBlockedCode
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
