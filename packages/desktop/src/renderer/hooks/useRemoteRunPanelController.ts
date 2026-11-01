import type {
  RemoteInteractionResponse,
  RemoteInteractionView
} from "@planweave-ai/collaboration-protocol/remote-run";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { RemoteAgentEndpoint } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import {
  type DesktopCanvasReference,
  type ProjectedRemoteAcpEvent,
  type RemoteBlockExecutionReadModel
} from "@planweave-ai/runtime";
import {
  projectRemoteAcpReplay,
  projectWorkspaceExecutionTimeline
} from "@planweave-ai/runtime/browser";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  desktopWorkspaceExecutionStartInputSchema,
  desktopWorkspaceExecutionFollowInputSchema,
  desktopWorkspaceExecutionCancelInputSchema,
  desktopWorkspaceExecutionRespondInputSchema,
  type DesktopWorkspaceExecutionResponse,
  type DesktopWorkspaceExecutionStartInput,
  type PlanWeaveWorkspaceExecutionApi
} from "../../shared/workspaceExecution.js";
import { bridge, workspaceExecutionBridge } from "../bridge";
import {
  buildAvailableAgentEndpoints,
  type AvailableAgentEndpoint,
  type LocalAgentEndpointInput,
  type LogicalAgentEndpointInput
} from "../collaboration/agentEndpointViewModel";
import {
  projectRemoteRunPanelViewModel,
  type RemoteRunActionAvailability,
  type RemoteRunAuthorizedActionKind,
  type RemoteRunPanelViewModel
} from "../collaboration/remoteRunViewModels";
import type { createTranslator } from "../i18n";

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

export type RemoteRunExecutionLocator = DesktopWorkspaceExecutionStartInput["locator"];

export type UseRemoteRunPanelControllerArgs = {
  agentEndpoints?: readonly AvailableAgentEndpoint[];
  workItem: WorkItemRef | null;
  runtimeRemoteExecution?: RemoteBlockExecutionReadModel | null;
  refreshRuntimeRemoteExecution?: () => Promise<RemoteBlockExecutionReadModel | null>;
  localAutoRunActive?: boolean;
  canvasRef?: DesktopCanvasReference | null;
  executionLocator?: RemoteRunExecutionLocator | null;
  localAgentEndpoints?: readonly LocalAgentEndpointInput[];
  logicalExecutors?: readonly LogicalAgentEndpointInput[];
  requiredProfileId?: string | null;
  requiredAgentId?: RemoteAgentEndpoint["agentId"] | null;
  requiredCapabilities?: readonly string[];
  open: boolean;
  executionApi?: PlanWeaveWorkspaceExecutionApi | null;
  onAgentEndpointChange?: (endpointId: string) => void;
  refreshAgentEndpoints?: () => Promise<void>;
  refreshingAgentEndpoints?: boolean;
  selectedAgentEndpointId?: string | null;
  t: ReturnType<typeof createTranslator>;
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
  confirmKind: "cancel" | null;
  setConfirmKind: (kind: "cancel" | null) => void;
  refresh: () => Promise<void>;
  loadMoreEvents: () => Promise<void>;
  dispatch: () => Promise<void>;
  cancel: (reason: string) => Promise<void>;
  resume: (reason: string) => Promise<void>;
  answerInteraction: (response: RemoteInteractionResponse) => Promise<void>;
};

function descriptor(
  endpoint: AvailableAgentEndpoint | undefined,
  args: UseRemoteRunPanelControllerArgs,
  fallbackId?: string
) {
  const agentEndpointId = endpoint?.remoteEndpointId ?? fallbackId;
  const name = endpoint?.executorName ?? args.requiredProfileId;
  const agentId = endpoint?.agentId ?? args.requiredAgentId;
  if (!agentEndpointId || !name || !agentId)
    throw new Error("remote_execution_identity_unavailable");
  return { agentEndpointId, effectiveExecutor: { name, agentId } };
}

function phase(view: DesktopWorkspaceExecutionResponse) {
  return {
    created: "preparing",
    running: "running",
    blocked: "action_required",
    completed: "terminal_success",
    failed: "terminal_failure",
    stopped: "terminal_cancelled"
  }[view.session.phase] as RemoteRunPanelViewModel["phase"];
}

function actions(
  view: DesktopWorkspaceExecutionResponse,
  pending: number
): RemoteRunActionAvailability[] {
  const active = view.session.phase === "running" || view.session.phase === "blocked";
  return [
    { kind: "dispatch", available: false, reason: "wrong_lifecycle" },
    pending
      ? { kind: "answer_interaction", available: true, requiresConfirm: false }
      : { kind: "answer_interaction", available: false, reason: "no_pending_interaction" },
    active
      ? { kind: "cancel", available: true, requiresConfirm: true }
      : { kind: "cancel", available: false, reason: "wrong_lifecycle" },
    view.session.phase === "blocked"
      ? { kind: "resume_same_session", available: true, requiresConfirm: false }
      : { kind: "resume_same_session", available: false, reason: "wrong_lifecycle" },
    { kind: "fail_interruption", available: false, reason: "wrong_lifecycle" },
    { kind: "retry_new_attempt", available: false, reason: "wrong_lifecycle" }
  ];
}

function remoteEndpointId(view: DesktopWorkspaceExecutionResponse | null): string | undefined {
  return view?.handle.target === "remote" ? view.handle.agentEndpointId : undefined;
}

function pendingInteractionsFor(view: DesktopWorkspaceExecutionResponse): RemoteInteractionView[] {
  if (view.handle.target !== "remote") return [];
  const pendingActionIds = new Set(
    projectWorkspaceExecutionTimeline(view.events).pendingInteractions
  );
  const pending: RemoteInteractionView[] = [];
  for (const event of view.events) {
    if (event.type !== "interaction_required" || !pendingActionIds.has(event.data.actionId)) {
      continue;
    }
    pending.push({
      request: event.data,
      operationId: view.handle.operationId,
      hostId: view.handle.agentEndpointId,
      status: "pending",
      createdAt: event.observedAt
    });
  }
  return pending;
}

function projectedRemoteEventsFor(
  view: DesktopWorkspaceExecutionResponse
): ProjectedRemoteAcpEvent[] {
  const projected: ProjectedRemoteAcpEvent[] = [];
  for (const event of view.events) {
    if (
      event.type !== "runner_event" ||
      event.source.target !== "remote" ||
      !event.source.executionAttemptId
    ) {
      continue;
    }
    const executionAttemptId = event.source.executionAttemptId;
    if (event.data.eventProtocolVersion === 1) {
      projected.push(
        ...projectRemoteAcpReplay({
          executionAttemptId,
          eventProtocolVersion: 1,
          events: [event.data.event]
        }).events
      );
    } else {
      projected.push(
        ...projectRemoteAcpReplay({
          executionAttemptId,
          eventProtocolVersion: 2,
          events: [event.data.event]
        }).events
      );
    }
  }
  return projected;
}

export function useRemoteRunPanelController(
  args: UseRemoteRunPanelControllerArgs
): UseRemoteRunPanelControllerResult {
  const executionApi =
    args.executionApi === undefined ? workspaceExecutionBridge : args.executionApi;
  const [view, setView] = useState<DesktopWorkspaceExecutionResponse | null>(null);
  const [selectedState, setSelectedState] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionInFlight, setActionInFlight] = useState<RemoteRunAuthorizedActionKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmKind, setConfirmKind] = useState<"cancel" | null>(null);
  const existingOperationId = args.runtimeRemoteExecution?.identity.operationId ?? null;
  const executionScopeKey = JSON.stringify([
    args.executionLocator?.kind ?? null,
    args.executionLocator?.kind === "owner_canvas"
      ? [
          args.executionLocator.operatorProfileId,
          args.executionLocator.humanPrincipalId,
          args.executionLocator.projectRoot
        ]
      : args.executionLocator?.kind === "workspace"
        ? [args.executionLocator.connectionProfileId, args.executionLocator.workspaceId]
        : null,
    args.executionLocator?.projectId ?? null,
    args.executionLocator?.canvasId ?? null,
    args.canvasRef?.projectRoot ?? null,
    args.canvasRef?.canvasId ?? null,
    args.workItem?.kind ?? null,
    args.workItem?.canvasId ?? null,
    args.workItem?.kind === "block" ? args.workItem.blockRef : null
  ]);
  const [identity, setIdentity] = useState<{
    scopeKey: string;
    runtimeOperationId: string | null;
    operationId: string | null;
    pendingStartPreviousOperationId?: string | null;
    generation: object;
  }>(() => ({
    scopeKey: executionScopeKey,
    runtimeOperationId: existingOperationId,
    operationId: existingOperationId,
    generation: {}
  }));
  const scopeGenerationRef = useRef<object | null>(identity.generation);
  const actionOwnerRef = useRef<{ kind: RemoteRunAuthorizedActionKind } | null>(null);
  const followOwnerRef = useRef<object | null>(null);
  const responseOwnerRef = useRef<object | null>(null);
  const scopeChanged = identity.scopeKey !== executionScopeKey;
  const runtimeChanged = identity.runtimeOperationId !== existingOperationId;
  const pendingStartEcho =
    identity.pendingStartPreviousOperationId !== undefined &&
    (existingOperationId === null ||
      existingOperationId === identity.pendingStartPreviousOperationId);
  const retireIdentity =
    scopeChanged ||
    (runtimeChanged && !pendingStartEcho && existingOperationId !== identity.operationId);
  if (scopeChanged || runtimeChanged) {
    setIdentity(
      retireIdentity
        ? {
            scopeKey: executionScopeKey,
            runtimeOperationId: existingOperationId,
            operationId: existingOperationId,
            generation: {}
          }
        : {
            ...identity,
            runtimeOperationId: existingOperationId,
            pendingStartPreviousOperationId: pendingStartEcho
              ? identity.pendingStartPreviousOperationId
              : undefined
          }
    );
    if (retireIdentity) {
      setView(null);
      setActionError(null);
      setLoading(false);
      setActionInFlight(null);
      setConfirmKind(null);
    }
  }
  useLayoutEffect(() => {
    scopeGenerationRef.current = identity.generation;
    actionOwnerRef.current = null;
    followOwnerRef.current = null;
    responseOwnerRef.current = null;
    return () => {
      scopeGenerationRef.current = null;
    };
  }, [identity.generation]);
  const autoFollowKey = args.open ? `${executionScopeKey}\u0000${existingOperationId ?? ""}` : null;
  const logicalExecutors =
    args.logicalExecutors ??
    logicalExecutorsFromLocalAgentEndpoints(args.localAgentEndpoints ?? []);
  const discovered = useMemo(
    () =>
      buildAvailableAgentEndpoints({
        local: args.localAgentEndpoints ?? [],
        remote: [],
        logicalExecutors,
        requiredProfileId: args.requiredProfileId ?? null,
        requiredAgentId: args.requiredAgentId ?? null,
        requiredCapabilities: args.requiredCapabilities ?? []
      }),
    [
      args.localAgentEndpoints,
      args.requiredAgentId,
      args.requiredCapabilities,
      args.requiredProfileId,
      logicalExecutors
    ]
  );
  const agentEndpoints = args.agentEndpoints ?? discovered;
  const selectedAgentEndpointId =
    args.selectedAgentEndpointId === undefined ? selectedState : args.selectedAgentEndpointId;
  const selectedEndpoint = agentEndpoints.find((item) => item.id === selectedAgentEndpointId);
  const setSelectedAgentEndpointId = useCallback(
    (id: string) => {
      args.onAgentEndpointChange ? args.onAgentEndpointChange(id) : setSelectedState(id);
    },
    [args.onAgentEndpointChange]
  );
  const refreshAgentEndpoints = useCallback(async () => {
    if (args.refreshAgentEndpoints) return args.refreshAgentEndpoints();
  }, [args.refreshAgentEndpoints]);
  useEffect(() => {
    const generation = scopeGenerationRef.current;
    if (args.open)
      void refreshAgentEndpoints().catch((error) => {
        if (scopeGenerationRef.current === generation) setActionError(String(error));
      });
  }, [args.open, refreshAgentEndpoints]);

  const currentRemoteEndpointId = remoteEndpointId(view);
  const endpointForView = currentRemoteEndpointId
    ? (agentEndpoints.find((item) => item.remoteEndpointId === currentRemoteEndpointId) ??
      selectedEndpoint)
    : selectedEndpoint;
  const follow = useCallback(async () => {
    if (
      !executionApi ||
      !args.executionLocator ||
      args.workItem?.kind !== "block" ||
      actionOwnerRef.current
    )
      return;
    const scopeGeneration = scopeGenerationRef.current;
    const owner = {};
    followOwnerRef.current = owner;
    responseOwnerRef.current = owner;
    setLoading(true);
    setActionError(null);
    try {
      const next = view
        ? await executionApi.followWorkspaceExecution(
            desktopWorkspaceExecutionFollowInputSchema.parse({
              locator: args.executionLocator,
              blockRef: args.workItem.blockRef,
              ...descriptor(endpointForView, args, currentRemoteEndpointId),
              sessionId: view.session.sessionId
            })
          )
        : existingOperationId
          ? await executionApi.followWorkspaceExecution(
              desktopWorkspaceExecutionFollowInputSchema.parse({
                locator: args.executionLocator,
                blockRef: args.workItem.blockRef,
                operationId: existingOperationId
              })
            )
          : null;
      if (
        next &&
        scopeGenerationRef.current === scopeGeneration &&
        responseOwnerRef.current === owner
      )
        setView(next);
    } catch (error) {
      if (scopeGenerationRef.current === scopeGeneration && responseOwnerRef.current === owner) {
        setActionError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (scopeGenerationRef.current === scopeGeneration && followOwnerRef.current === owner) {
        followOwnerRef.current = null;
        setLoading(false);
      }
    }
  }, [args, currentRemoteEndpointId, endpointForView, executionApi, existingOperationId, view]);
  const refresh = useCallback(async () => {
    if (actionOwnerRef.current) return;
    const generation = scopeGenerationRef.current;
    const responseOwner = responseOwnerRef.current;
    try {
      if (args.refreshRuntimeRemoteExecution) {
        const current = await args.refreshRuntimeRemoteExecution();
        if (
          scopeGenerationRef.current !== generation ||
          responseOwnerRef.current !== responseOwner ||
          (current?.identity.operationId ?? null) !== existingOperationId
        )
          return;
      }
      if (scopeGenerationRef.current === generation) await follow();
    } catch (caught) {
      if (scopeGenerationRef.current === generation && responseOwnerRef.current === responseOwner)
        setActionError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [args.refreshRuntimeRemoteExecution, existingOperationId, follow]);
  const followRef = useRef(follow);
  useEffect(() => {
    followRef.current = follow;
  }, [follow]);
  useEffect(() => {
    if (autoFollowKey) void followRef.current();
  }, [autoFollowKey]);
  const run = useCallback(
    async (
      kind: RemoteRunAuthorizedActionKind,
      call: () => Promise<DesktopWorkspaceExecutionResponse | undefined>
    ) => {
      if (actionOwnerRef.current) return;
      const owner = { kind };
      actionOwnerRef.current = owner;
      responseOwnerRef.current = owner;
      const scopeGeneration = scopeGenerationRef.current;
      setActionInFlight(kind);
      setActionError(null);
      try {
        const next = await call();
        if (scopeGenerationRef.current === scopeGeneration && responseOwnerRef.current === owner) {
          if (next) {
            setView(next);
            if (kind === "dispatch" && next.handle.target === "remote") {
              const operationId = next.handle.operationId;
              setIdentity((current) => ({
                ...current,
                operationId,
                pendingStartPreviousOperationId:
                  current.runtimeOperationId === operationId
                    ? undefined
                    : current.runtimeOperationId
              }));
            }
          }
          setConfirmKind(null);
        }
      } catch (error) {
        if (scopeGenerationRef.current === scopeGeneration && responseOwnerRef.current === owner) {
          setActionError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (scopeGenerationRef.current === scopeGeneration && actionOwnerRef.current === owner) {
          actionOwnerRef.current = null;
          setActionInFlight(null);
        }
      }
    },
    []
  );
  const dispatch = useCallback(async () => {
    const workItem = args.workItem;
    if (workItem?.kind !== "block" || !selectedEndpoint?.available)
      return setActionError("agent_endpoint_selection_required");
    if (selectedEndpoint.source === "local")
      return run("dispatch", async () => {
        if (!bridge || !args.canvasRef || !selectedEndpoint.localExecutorName)
          throw new Error("local_agent_endpoint_unavailable");
        await bridge.startAutoRun(
          args.canvasRef,
          { kind: "block", blockRef: workItem.blockRef },
          20,
          { executorOverride: selectedEndpoint.localExecutorName }
        );
        return undefined;
      });
    if (!executionApi || !args.executionLocator)
      return setActionError("workspace_execution_locator_unavailable");
    return run("dispatch", () =>
      executionApi.startWorkspaceExecution(
        desktopWorkspaceExecutionStartInputSchema.parse({
          locator: args.executionLocator!,
          blockRef: workItem.blockRef,
          ...descriptor(selectedEndpoint, args)
        })
      )
    );
  }, [args, executionApi, run, selectedEndpoint]);
  const cancel = useCallback(
    async (reason: string) => {
      const workItem = args.workItem;
      if (!executionApi || !args.executionLocator || !view || workItem?.kind !== "block") return;
      return run("cancel", () =>
        executionApi.cancelWorkspaceExecution(
          desktopWorkspaceExecutionCancelInputSchema.parse({
            locator: args.executionLocator!,
            blockRef: workItem.blockRef,
            ...descriptor(endpointForView, args, currentRemoteEndpointId),
            sessionId: view.session.sessionId,
            actionId: args.createId?.() ?? crypto.randomUUID(),
            reason
          })
        )
      );
    },
    [args, currentRemoteEndpointId, endpointForView, executionApi, run, view]
  );
  const resume = useCallback(
    async (_reason: string) => {
      await follow();
    },
    [follow]
  );
  const answerInteraction = useCallback(
    async (response: RemoteInteractionResponse) => {
      const workItem = args.workItem;
      if (!executionApi || !args.executionLocator || !view || workItem?.kind !== "block") return;
      return run("answer_interaction", () =>
        executionApi.respondWorkspaceExecution(
          desktopWorkspaceExecutionRespondInputSchema.parse({
            locator: args.executionLocator!,
            blockRef: workItem.blockRef,
            ...descriptor(endpointForView, args, currentRemoteEndpointId),
            sessionId: view.session.sessionId,
            response
          })
        )
      );
    },
    [args, currentRemoteEndpointId, endpointForView, executionApi, run, view]
  );

  const base = projectRemoteRunPanelViewModel({
    observation: null,
    runtime: args.runtimeRemoteExecution ?? null,
    assignment: null,
    observerRun: null,
    pendingInteractions: [],
    eventProtocolVersion: null,
    events: [],
    replayDiagnostics: [],
    eventCursor: 0,
    eventsHasMore: false,
    authorized:
      selectedEndpoint?.source === "local"
        ? Boolean(bridge && args.canvasRef)
        : Boolean(executionApi && args.executionLocator),
    offline: selectedEndpoint?.source === "remote" && !executionApi,
    localAutoRunActive: Boolean(args.localAutoRunActive),
    endpointDispatchAvailable: Boolean(selectedEndpoint?.available)
  });
  const viewModel = useMemo<RemoteRunPanelViewModel>(() => {
    if (!view || view.handle.target !== "remote") return base;
    const pending = pendingInteractionsFor(view);
    const events = projectedRemoteEventsFor(view);
    const state = (
      {
        created: "preparing",
        running: "running",
        blocked: "action_required",
        completed: "completed",
        failed: "failed",
        stopped: "cancelled"
      } as const
    )[view.session.phase];
    const attempt = (
      {
        created: "prepared",
        running: "running",
        blocked: "action_required",
        completed: "completed",
        failed: "failed",
        stopped: "cancelled"
      } as const
    )[view.session.phase];
    const h = view.handle;
    return {
      ...base,
      phase: phase(view),
      operationState: state,
      attemptStatus: attempt,
      identity:
        h.executionAttemptId && h.attemptStateVersion !== null
          ? {
              operationId: h.operationId,
              dispatchId: h.dispatchId,
              executionAttemptId: h.executionAttemptId,
              attemptVersion: h.attemptStateVersion,
              hostId: null,
              agentEndpoint: null,
              leaseId: h.leaseId,
              leaseExpiresAt: null,
              acpSessionId: pending[0]?.request.acpSessionId ?? null,
              recoveryId: null,
              blockRef: args.workItem?.kind === "block" ? args.workItem.blockRef : "",
              canvasId: args.workItem?.canvasId ?? "",
              projectId:
                args.executionLocator && "projectId" in args.executionLocator
                  ? args.executionLocator.projectId
                  : ""
            }
          : null,
      pendingInteractions: pending,
      eventProtocolVersion: events.at(-1)?.eventProtocolVersion ?? null,
      events,
      eventCursor: h.cursor.eventCursor,
      eventsHasMore: false,
      actions: actions(view, pending.length),
      actionRequired: view.session.phase === "blocked" || pending.length > 0,
      interruptionResumable: view.session.phase === "blocked",
      runtimeBindingSummary: `${view.session.phase}/${view.session.evidence.status}`,
      diagnostics: view.session.evidence.diagnostics.map((item) => item.code)
    };
  }, [args.executionLocator, args.workItem, base, view]);
  return {
    viewModel,
    loading,
    loadingEvents: loading,
    loadingInteractions: loading,
    actionInFlight,
    actionError,
    agentEndpoints,
    selectedAgentEndpointId,
    setSelectedAgentEndpointId,
    refreshingAgentEndpoints: args.refreshingAgentEndpoints ?? false,
    legacyHostTargetPresent: false,
    refreshAgentEndpoints,
    confirmKind,
    setConfirmKind,
    refresh,
    loadMoreEvents: follow,
    dispatch,
    cancel,
    resume,
    answerInteraction
  };
}
