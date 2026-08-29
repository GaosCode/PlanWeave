import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AssignmentDisplayProjection } from "@planweave-ai/collaboration-protocol/work/assignment";
import type {
  RemoteInteractionResponse,
  RemoteInteractionView,
  RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { projectRemoteAcpReplay } from "@planweave-ai/runtime/browser";
import type { DesktopCanvasReference, RemoteBlockExecutionReadModel } from "@planweave-ai/runtime";
import type { RemoteAgentEndpoint } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import { bridge, collaborationBridge } from "../bridge";
import { collaborationErrorMessage } from "../collaboration/formatCollaborationError";
import {
  applyRemoteAcpReplayPage,
  createRemoteAcpAttemptReplayState,
  remoteAcpReplayRequestMatchesState,
  scopeRemoteAcpReplayToAttempt
} from "../collaboration/remoteAcpReplayState";
import {
  adaptRemoteAcpEvents,
  buildRemoteActionIdentity,
  projectRemoteRunPanelViewModel,
  type RemoteRunAuthorizedActionKind,
  type RemoteRunPanelViewModel
} from "../collaboration/remoteRunViewModels";
import type { createTranslator } from "../i18n";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import {
  workItemKey,
  type CollaborationBoundaryErrorView,
  type CollaborationRemoteRunProjection
} from "../../shared/collaborationReadModels.js";
import { useCollaborationReadModels } from "./useCollaborationReadModels";
import { useCollaborationStatus } from "./useCollaborationStatus";
import { isCollaborationSessionConnected } from "../collaboration/sessionState";
import {
  buildAvailableAgentEndpoints,
  type AvailableAgentEndpoint,
  type LocalAgentEndpointInput,
  type LogicalAgentEndpointInput
} from "../collaboration/agentEndpointViewModel";
import {
  remoteOperationScopeKey,
  selectRemoteOperationObservation
} from "../collaboration/remoteProjectionMerge";

/** Derive a logical-executor directory from local Endpoint rows for discovery fallback. */
export function logicalExecutorsFromLocalAgentEndpoints(
  local: readonly LocalAgentEndpointInput[]
): LogicalAgentEndpointInput[] {
  return local.map((endpoint) => {
    const agentId = endpoint.executorName.replace(/-acp$/i, "").replace(/-auto$/i, "");
    return {
      executorName: agentId,
      profileId: endpoint.executorName,
      agentId,
      displayName: endpoint.displayName,
      capabilities: [...endpoint.capabilities],
      available: endpoint.available,
      unavailableReason: endpoint.unavailableReason,
      custom: false
    };
  });
}

export type UseRemoteRunPanelControllerArgs = {
  agentEndpoints?: readonly AvailableAgentEndpoint[];
  workItem: WorkItemRef | null;
  /** Runtime remoteExecution projection for the selected Block (local authority). */
  runtimeRemoteExecution?: RemoteBlockExecutionReadModel | null;
  /** True when a local Auto Run record is active for the same Block. */
  localAutoRunActive?: boolean;
  canvasRef?: DesktopCanvasReference | null;
  localAgentEndpoints?: readonly LocalAgentEndpointInput[];
  /** Same logical-executor directory used by catalog builders (discovery fallback). */
  logicalExecutors?: readonly LogicalAgentEndpointInput[];
  requiredProfileId?: string | null;
  requiredAgentId?: RemoteAgentEndpoint["agentId"] | null;
  requiredCapabilities?: readonly string[];
  open: boolean;
  api?: PlanWeaveCollaborationApi | null;
  onAgentEndpointChange?: (endpointId: string) => void;
  refreshAgentEndpoints?: () => Promise<void>;
  refreshingAgentEndpoints?: boolean;
  selectedAgentEndpointId?: string | null;
  t: ReturnType<typeof createTranslator>;
  /** Optional clock/random for deterministic tests. */
  createId?: () => string;
};

export type UseRemoteRunPanelControllerResult = {
  viewModel: RemoteRunPanelViewModel;
  loading: boolean;
  loadingEvents: boolean;
  loadingInteractions: boolean;
  actionInFlight: RemoteRunAuthorizedActionKind | null;
  actionError: string | null;
  agentEndpoints: readonly AvailableAgentEndpoint[];
  selectedAgentEndpointId: string | null;
  setSelectedAgentEndpointId: (endpointId: string) => void;
  refreshingAgentEndpoints: boolean;
  legacyHostTargetPresent: boolean;
  refreshAgentEndpoints: () => Promise<void>;
  confirmKind: "cancel" | "retry_new_attempt" | "fail_interruption" | null;
  setConfirmKind: (kind: "cancel" | "retry_new_attempt" | "fail_interruption" | null) => void;
  refresh: () => Promise<void>;
  loadMoreEvents: () => Promise<void>;
  dispatch: () => Promise<void>;
  cancel: (reason: string) => Promise<void>;
  failInterruption: (reason: string) => Promise<void>;
  /** Resume sends only the human intent; Server materializes lease and recovery fields. */
  resume: (reason: string) => Promise<void>;
  retryNewAttempt: (input: {
    newDispatchId: string;
    newExecutionAttemptId: string;
    reason: string;
  }) => Promise<void>;
  answerInteraction: (settlement: RemoteInteractionResponse) => Promise<void>;
};

function mapBoundaryError(error: unknown): CollaborationBoundaryErrorView {
  if (
    error &&
    typeof error === "object" &&
    "kind" in error &&
    "code" in error &&
    "message" in error &&
    "retryable" in error
  ) {
    return error as CollaborationBoundaryErrorView;
  }
  return {
    kind: "unknown",
    code: "collaboration_remote_run_error",
    message: error instanceof Error ? error.message : "remote_run_error",
    retryable: true
  };
}

function resolveOperationId(input: {
  runtime: RemoteBlockExecutionReadModel | null | undefined;
  assignment: AssignmentDisplayProjection | null;
  observerRun: CollaborationRemoteRunProjection | null;
  observation: RemoteOperationObservation | null;
}): string | null {
  if (input.observation?.operationId) return input.observation.operationId;
  if (input.runtime?.identity.operationId) return input.runtime.identity.operationId;
  return null;
}

/**
 * Observes and controls a remote ACP run for one Block WorkItemRef.
 * Loads deep diagnostics only when open; never merges local Auto Run authority.
 */
export function useRemoteRunPanelController(
  args: UseRemoteRunPanelControllerArgs
): UseRemoteRunPanelControllerResult {
  const api = args.api === undefined ? collaborationBridge : args.api;
  const createId =
    args.createId ??
    (() => {
      if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
        return crypto.randomUUID();
      }
      return `remote-action-${Date.now()}`;
    });
  const { status } = useCollaborationStatus({ api });
  const { snapshot, controller: readModelController } = useCollaborationReadModels({
    api,
    profileId: null,
    projectId: null,
    manageActiveProject: false
  });

  const sessionConnected = isCollaborationSessionConnected(status);
  const offline =
    !api ||
    !sessionConnected ||
    status?.session.phase === "error" ||
    snapshot.syncPhase === "auth_expired" ||
    snapshot.syncPhase === "disconnected";

  const workKey = args.workItem ? workItemKey(args.workItem) : null;
  const assignment =
    workKey && snapshot.assignmentsByWorkItem[workKey]
      ? snapshot.assignmentsByWorkItem[workKey]!
      : null;
  const workAuthority =
    workKey && snapshot.workAuthorityByWorkItem[workKey]
      ? snapshot.workAuthorityByWorkItem[workKey]!
      : null;
  const legacyHostTargetPresent =
    workAuthority?.executionTarget?.target.kind === "exact_host" ||
    workAuthority?.executionTarget?.target.kind === "automatic_host";

  // Ensure independent authority projections are available for dispatch CAS.
  useEffect(() => {
    if (!args.open || !args.workItem || args.workItem.kind !== "block" || !readModelController)
      return;
    void readModelController.ensureWorkAuthority(args.workItem).catch(() => undefined);
  }, [args.open, args.workItem, readModelController]);

  const observerRun = useMemo(() => {
    if (!args.workItem) return null;
    const key = workItemKey(args.workItem);
    return (
      Object.values(snapshot.remoteRunsByDispatchId).find((run) => {
        if (!run.workItem) return false;
        return workItemKey(run.workItem) === key;
      }) ?? null
    );
  }, [args.workItem, snapshot.remoteRunsByDispatchId]);

  const [observation, setObservation] = useState<RemoteOperationObservation | null>(null);
  const [remoteAgentEndpoints, setRemoteAgentEndpoints] = useState<RemoteAgentEndpoint[]>([]);
  const [selectedAgentEndpointIdState, setSelectedAgentEndpointIdState] = useState<string | null>(
    null
  );
  const [refreshingAgentEndpoints, setRefreshingAgentEndpoints] = useState(false);
  const [pendingInteractions, setPendingInteractions] = useState<RemoteInteractionView[]>([]);
  const [replayState, setReplayState] = useState(createRemoteAcpAttemptReplayState);
  const replayStateRef = useRef(replayState);
  replayStateRef.current = replayState;
  const refreshInFlightRef = useRef(false);
  const loadingEventsRequestRef = useRef(0);
  const [loading, setLoading] = useState(false);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [loadingInteractions, setLoadingInteractions] = useState(false);
  const [actionInFlight, setActionInFlight] = useState<RemoteRunAuthorizedActionKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmKind, setConfirmKind] = useState<
    "cancel" | "retry_new_attempt" | "fail_interruption" | null
  >(null);
  const observationRef = useRef<RemoteOperationObservation | null>(null);
  observationRef.current = observation;
  const generationRef = useRef(0);
  const endpointRequestGenerationRef = useRef(0);
  const scopeGenerationRef = useRef(0);
  const workspaceId = status?.workspaceConnection.workspaceId ?? null;
  const scopeKey = JSON.stringify([snapshot.projectId ?? null, workspaceId, workKey]);
  const scopeKeyRef = useRef(scopeKey);

  const discoveredAgentEndpoints = useMemo(() => {
    const logicalExecutors =
      args.logicalExecutors ??
      logicalExecutorsFromLocalAgentEndpoints(args.localAgentEndpoints ?? []);
    return buildAvailableAgentEndpoints({
      local: args.localAgentEndpoints ?? [],
      remote: remoteAgentEndpoints,
      logicalExecutors,
      requiredProfileId: args.requiredProfileId ?? null,
      requiredAgentId: args.requiredAgentId ?? null,
      requiredCapabilities: args.requiredCapabilities ?? []
    });
  }, [
    args.localAgentEndpoints,
    args.logicalExecutors,
    args.requiredCapabilities,
    args.requiredAgentId,
    args.requiredProfileId,
    remoteAgentEndpoints
  ]);
  const agentEndpoints = args.agentEndpoints ?? discoveredAgentEndpoints;
  const hasProvidedAgentEndpoints = args.agentEndpoints !== undefined;
  const selectedAgentEndpointId =
    args.selectedAgentEndpointId === undefined
      ? selectedAgentEndpointIdState
      : args.selectedAgentEndpointId;
  const setSelectedAgentEndpointId = useCallback(
    (endpointId: string) => {
      if (args.onAgentEndpointChange) args.onAgentEndpointChange(endpointId);
      else setSelectedAgentEndpointIdState(endpointId);
    },
    [args.onAgentEndpointChange]
  );

  const workItemCanvasId = args.workItem?.canvasId;
  const refreshAgentEndpoints = useCallback(async () => {
    if (args.refreshAgentEndpoints) {
      await args.refreshAgentEndpoints();
      return;
    }
    if (hasProvidedAgentEndpoints) {
      setRefreshingAgentEndpoints(false);
      return;
    }
    const requestGeneration = ++endpointRequestGenerationRef.current;
    const requestScopeKey = scopeKey;
    const requestScopeGeneration = scopeGenerationRef.current;
    if (!api?.listCollaborationAgentEndpoints || !sessionConnected) {
      if (
        requestGeneration === endpointRequestGenerationRef.current &&
        requestScopeKey === scopeKeyRef.current &&
        requestScopeGeneration === scopeGenerationRef.current
      ) {
        setRemoteAgentEndpoints([]);
        setRefreshingAgentEndpoints(false);
      }
      return;
    }
    setRefreshingAgentEndpoints(true);
    try {
      const list = await api.listCollaborationAgentEndpoints({
        ...(workItemCanvasId ? { canvasId: workItemCanvasId } : {}),
        ...(workspaceId ? { workspaceId } : {})
      });
      if (
        requestGeneration === endpointRequestGenerationRef.current &&
        requestScopeKey === scopeKeyRef.current &&
        requestScopeGeneration === scopeGenerationRef.current
      ) {
        setRemoteAgentEndpoints(list.items);
      }
    } finally {
      if (
        requestGeneration === endpointRequestGenerationRef.current &&
        requestScopeKey === scopeKeyRef.current &&
        requestScopeGeneration === scopeGenerationRef.current
      ) {
        setRefreshingAgentEndpoints(false);
      }
    }
  }, [
    api,
    args.refreshAgentEndpoints,
    hasProvidedAgentEndpoints,
    sessionConnected,
    scopeKey,
    workItemCanvasId,
    workspaceId
  ]);

  useLayoutEffect(() => {
    if (scopeKeyRef.current !== scopeKey) {
      scopeKeyRef.current = scopeKey;
      scopeGenerationRef.current += 1;
      generationRef.current += 1;
      refreshInFlightRef.current = false;
      loadingEventsRequestRef.current += 1;
      endpointRequestGenerationRef.current += 1;
      observationRef.current = null;
      setObservation(null);
      setPendingInteractions([]);
      const emptyReplay = createRemoteAcpAttemptReplayState();
      replayStateRef.current = emptyReplay;
      setReplayState(emptyReplay);
      setActionError(null);
      setConfirmKind(null);
      setLoading(false);
      setLoadingEvents(false);
      setLoadingInteractions(false);
      setActionInFlight(null);
      setRefreshingAgentEndpoints(false);
      setRemoteAgentEndpoints([]);
      setSelectedAgentEndpointIdState(null);
    }
  }, [scopeKey]);

  useEffect(() => {
    if (!args.open) return;
    const requestScopeKey = scopeKey;
    const requestScopeGeneration = scopeGenerationRef.current;
    void refreshAgentEndpoints().catch((error) => {
      if (
        requestScopeKey !== scopeKeyRef.current ||
        requestScopeGeneration !== scopeGenerationRef.current
      ) {
        return;
      }
      setActionError(collaborationErrorMessage(mapBoundaryError(error)));
    });
  }, [args.open, refreshAgentEndpoints, scopeKey]);

  const refresh = useCallback(async () => {
    if (!api || !args.open || !args.workItem || args.workItem.kind !== "block") return;
    if (!sessionConnected) return;
    const requestScopeKey = scopeKey;
    const requestScopeGeneration = scopeGenerationRef.current;
    const isCurrentRefreshScope = () =>
      requestScopeKey === scopeKeyRef.current &&
      requestScopeGeneration === scopeGenerationRef.current;
    if (!isCurrentRefreshScope()) return;
    const generation = ++generationRef.current;
    const canWrite = () => generation === generationRef.current && isCurrentRefreshScope();
    refreshInFlightRef.current = true;
    const loadingEventsRequest = ++loadingEventsRequestRef.current;
    setLoadingEvents(false);
    setLoading(true);
    setActionError(null);
    try {
      const operationId = resolveOperationId({
        runtime: args.runtimeRemoteExecution,
        assignment,
        observerRun,
        observation: observationRef.current
      });
      if (!operationId) {
        if (canWrite()) {
          setObservation(null);
          setPendingInteractions([]);
          const emptyReplay = createRemoteAcpAttemptReplayState();
          replayStateRef.current = emptyReplay;
          setReplayState(emptyReplay);
        }
        return;
      }
      const next = await api.observeCollaborationRemoteOperation({ operationId });
      if (!canWrite()) return;
      const merged = selectRemoteOperationObservation({
        current: observationRef.current,
        incoming: next,
        expectedScopeKey: remoteOperationScopeKey({
          projectId: snapshot.projectId ?? next.projectId,
          canvasId: args.workItem.canvasId,
          blockRef: args.workItem.blockRef
        })
      });
      if (!merged) throw new Error("remote_operation_observation_scope_mismatch");
      observationRef.current = merged;
      setObservation(merged);
      const attemptReplay = scopeRemoteAcpReplayToAttempt(
        replayStateRef.current,
        merged.executionAttemptId
      );
      if (attemptReplay !== replayStateRef.current) {
        replayStateRef.current = attemptReplay;
        setReplayState(attemptReplay);
      }

      setLoadingInteractions(true);
      try {
        const page = await api.listCollaborationRemoteOperationInteractions({
          operationId,
          query: { cursor: 0, limit: 50 }
        });
        if (!canWrite()) return;
        setPendingInteractions(page.items.filter((item) => item.status === "pending"));
      } finally {
        if (canWrite()) setLoadingInteractions(false);
      }

      setLoadingEvents(true);
      const replay = await api.replayCollaborationRemoteOperationEvents({
        operationId,
        query: { afterCursor: attemptReplay.cursor }
      });
      if (!canWrite()) return;
      const projection = projectRemoteAcpReplay(replay);
      const nextReplay = applyRemoteAcpReplayPage({
        state: attemptReplay,
        requestedAfterCursor: attemptReplay.cursor,
        cursor: replay.cursor,
        hasMore: replay.hasMore,
        projection
      });
      replayStateRef.current = nextReplay;
      setReplayState(nextReplay);
    } catch (error) {
      if (!canWrite()) return;
      const mapped = mapBoundaryError(error);
      setActionError(collaborationErrorMessage(mapped));
      if (mapped.kind === "auth" || mapped.code.includes("auth")) {
        setObservation(null);
      }
    } finally {
      if (loadingEventsRequest === loadingEventsRequestRef.current) {
        setLoadingEvents(false);
      }
      if (canWrite()) {
        refreshInFlightRef.current = false;
        setLoading(false);
      }
    }
  }, [
    api,
    args.open,
    args.workItem,
    args.runtimeRemoteExecution,
    sessionConnected,
    assignment,
    observerRun,
    scopeKey,
    snapshot.projectId
  ]);

  // Refresh when observer remote-run milestones advance for this work item.
  // biome-ignore lint/correctness/useExhaustiveDependencies: observer milestone-driven refresh
  useEffect(() => {
    if (!args.open) return;
    void refresh();
    // Refresh when observer remote-run milestones advance for this work item.
    // deliberate on observer status only — not every refresh identity churn
  }, [
    args.open,
    workKey,
    observerRun?.status,
    observerRun?.updatedAt,
    args.runtimeRemoteExecution?.identity.operationId,
    sessionConnected
  ]);

  const loadMoreEvents = useCallback(async () => {
    if (!api || !observation || !replayState.hasMore || refreshInFlightRef.current) return;
    const generation = generationRef.current;
    const requestedState = replayState;
    const loadingEventsRequest = ++loadingEventsRequestRef.current;
    setLoadingEvents(true);
    setActionError(null);
    try {
      const replay = await api.replayCollaborationRemoteOperationEvents({
        operationId: observation.operationId,
        query: { afterCursor: requestedState.cursor }
      });
      if (
        generation !== generationRef.current ||
        !remoteAcpReplayRequestMatchesState(requestedState, replayStateRef.current)
      ) {
        return;
      }
      const projection = projectRemoteAcpReplay(replay);
      const nextReplay = applyRemoteAcpReplayPage({
        state: requestedState,
        requestedAfterCursor: requestedState.cursor,
        cursor: replay.cursor,
        hasMore: replay.hasMore,
        projection
      });
      replayStateRef.current = nextReplay;
      setReplayState(nextReplay);
    } catch (error) {
      if (
        generation !== generationRef.current ||
        !remoteAcpReplayRequestMatchesState(requestedState, replayStateRef.current)
      ) {
        return;
      }
      setActionError(collaborationErrorMessage(mapBoundaryError(error)));
    } finally {
      if (loadingEventsRequest === loadingEventsRequestRef.current) setLoadingEvents(false);
    }
  }, [api, observation, replayState]);

  const runAction = useCallback(
    async (
      kind: RemoteRunAuthorizedActionKind,
      execute: (isCurrentScope: () => boolean) => Promise<void>
    ): Promise<void> => {
      if (actionInFlight) return;
      const actionScopeKey = scopeKey;
      const actionScopeGeneration = scopeGenerationRef.current;
      const isCurrentScope = () =>
        actionScopeKey === scopeKeyRef.current &&
        actionScopeGeneration === scopeGenerationRef.current;
      setActionInFlight(kind);
      setActionError(null);
      try {
        await execute(isCurrentScope);
        if (!isCurrentScope()) return;
        setConfirmKind(null);
        await refresh();
      } catch (error) {
        if (!isCurrentScope()) return;
        const mapped = mapBoundaryError(error);
        setActionError(collaborationErrorMessage(mapped));
        if (
          (mapped.kind === "conflict" || mapped.code.includes("stale")) &&
          !mapped.code.startsWith("agent_endpoint_")
        ) {
          await refresh();
        }
      } finally {
        if (isCurrentScope()) setActionInFlight(null);
      }
    },
    [actionInFlight, refresh, scopeKey]
  );

  const dispatch = useCallback(async () => {
    const workItem = args.workItem;
    if (!workItem || workItem.kind !== "block") return;
    const selectedEndpoint = agentEndpoints.find(
      (endpoint) => endpoint.id === selectedAgentEndpointId
    );
    if (!selectedEndpoint?.available) {
      setActionError("agent_endpoint_selection_required");
      return;
    }
    if (selectedEndpoint.source === "local") {
      await runAction("dispatch", async () => {
        if (!bridge || !args.canvasRef) throw new Error("local_agent_endpoint_unavailable");
        if (!selectedEndpoint.localExecutorName) {
          throw new Error("agent_endpoint_selection_required");
        }
        await bridge.startAutoRun(
          args.canvasRef,
          { kind: "block", blockRef: workItem.blockRef },
          20,
          { executorOverride: selectedEndpoint.localExecutorName }
        );
      });
      return;
    }
    if (!api) return;
    const projectId =
      snapshot.projectId ??
      status?.profiles.find((profile) => profile.profileId === status.activeProfileId)?.projectId ??
      null;
    if (!projectId) {
      setActionError("collaboration_project_unavailable");
      return;
    }
    await runAction("dispatch", async (isCurrentScope) => {
      if (!workAuthority) throw new Error("work_authority_unavailable");
      const revisions = workAuthority.revisions;
      if (!selectedEndpoint.remoteEndpointId) throw new Error("agent_endpoint_selection_required");
      try {
        const result = await api.dispatchCollaborationRemoteOperation({
          schemaVersion: "remote-run/v3",
          projectId,
          canvasId: workItem.canvasId,
          blockRef: workItem.blockRef,
          agentEndpointId: selectedEndpoint.remoteEndpointId,
          idempotencyKey: `desktop-dispatch-${createId()}`,
          expectedResponsibilityRevision: revisions.responsibilityRevision,
          expectedReviewerRevision: revisions.reviewerRevision
        });
        if (isCurrentScope()) {
          const merged = selectRemoteOperationObservation({
            current: observationRef.current,
            incoming: result,
            expectedScopeKey: remoteOperationScopeKey({
              projectId,
              canvasId: workItem.canvasId,
              blockRef: workItem.blockRef
            })
          });
          observationRef.current = merged;
          setObservation(merged);
        }
      } catch (error) {
        const mapped = mapBoundaryError(error);
        if (
          isCurrentScope() &&
          mapped.kind === "conflict" &&
          mapped.code.startsWith("agent_endpoint_")
        ) {
          try {
            await refreshAgentEndpoints();
          } catch (refreshError) {
            console.warn(collaborationErrorMessage(mapBoundaryError(refreshError)));
          }
        }
        throw error;
      }
    });
  }, [
    api,
    args.workItem,
    runAction,
    createId,
    snapshot.projectId,
    status,
    workAuthority,
    agentEndpoints,
    selectedAgentEndpointId,
    args.canvasRef,
    refreshAgentEndpoints
  ]);

  const cancel = useCallback(
    async (reason: string) => {
      if (!api || !observation) return;
      await runAction("cancel", async () => {
        const action = buildRemoteActionIdentity({
          observation,
          kind: "cancel",
          actionId: createId(),
          reason
        });
        await api.executeCollaborationRemoteOperationAction({
          operationId: observation.operationId,
          action
        });
      });
    },
    [api, observation, runAction, createId]
  );

  const failInterruption = useCallback(
    async (reason: string) => {
      if (!api || !observation) return;
      await runAction("fail_interruption", async () => {
        const action = buildRemoteActionIdentity({
          observation,
          kind: "fail",
          actionId: createId(),
          reason,
          failure: {
            code: "remote_execution_failed",
            message: reason,
            retryable: false
          }
        });
        await api.executeCollaborationRemoteOperationAction({
          operationId: observation.operationId,
          action
        });
      });
    },
    [api, observation, runAction, createId]
  );

  const resume = useCallback(
    async (reason: string) => {
      if (!api || !observation) return;
      await runAction("resume_same_session", async () => {
        const action = buildRemoteActionIdentity({
          observation,
          kind: "resume_same_session",
          actionId: createId(),
          reason
        });
        await api.executeCollaborationRemoteOperationAction({
          operationId: observation.operationId,
          action
        });
      });
    },
    [api, observation, runAction, createId]
  );

  const retryNewAttempt = useCallback(
    async (input: { newDispatchId: string; newExecutionAttemptId: string; reason: string }) => {
      if (!api || !observation) return;
      await runAction("retry_new_attempt", async () => {
        const action = buildRemoteActionIdentity({
          observation,
          kind: "retry_new_attempt",
          actionId: createId(),
          reason: input.reason,
          newDispatchId: input.newDispatchId,
          newExecutionAttemptId: input.newExecutionAttemptId
        });
        await api.executeCollaborationRemoteOperationAction({
          operationId: observation.operationId,
          action
        });
      });
    },
    [api, observation, runAction, createId]
  );

  const answerInteraction = useCallback(
    async (settlement: RemoteInteractionResponse) => {
      if (!api || !observation) return;
      await runAction("answer_interaction", async () => {
        await api.settleCollaborationRemoteOperationInteraction({
          operationId: observation.operationId,
          settlement
        });
      });
    },
    [api, observation, runAction]
  );

  const viewModel = useMemo(() => {
    const selectedEndpoint = agentEndpoints.find(
      (endpoint) => endpoint.id === selectedAgentEndpointId
    );
    const localSelected = selectedEndpoint?.source === "local";
    return projectRemoteRunPanelViewModel({
      observation,
      runtime: args.runtimeRemoteExecution ?? null,
      assignment,
      observerRun,
      pendingInteractions,
      eventProtocolVersion: replayState.eventProtocolVersion,
      events: adaptRemoteAcpEvents(replayState.events),
      replayDiagnostics: replayState.diagnostics,
      eventCursor: replayState.cursor,
      eventsHasMore: replayState.hasMore,
      authorized: localSelected
        ? Boolean(bridge && args.canvasRef)
        : !offline && Boolean(sessionConnected),
      offline: localSelected ? false : Boolean(offline),
      localAutoRunActive: Boolean(args.localAutoRunActive),
      hostOnline: assignment?.host?.online ?? null,
      endpointDispatchAvailable: Boolean(selectedEndpoint?.available)
    });
  }, [
    observation,
    args.runtimeRemoteExecution,
    args.localAutoRunActive,
    assignment,
    observerRun,
    pendingInteractions,
    replayState,
    offline,
    sessionConnected,
    agentEndpoints,
    selectedAgentEndpointId,
    args.canvasRef
  ]);

  return {
    viewModel,
    loading,
    loadingEvents,
    loadingInteractions,
    actionInFlight,
    actionError,
    agentEndpoints,
    selectedAgentEndpointId,
    setSelectedAgentEndpointId,
    refreshingAgentEndpoints: args.refreshingAgentEndpoints ?? refreshingAgentEndpoints,
    legacyHostTargetPresent,
    refreshAgentEndpoints,
    confirmKind,
    setConfirmKind,
    refresh,
    loadMoreEvents,
    dispatch,
    cancel,
    failInterruption,
    resume,
    retryNewAttempt,
    answerInteraction
  };
}
