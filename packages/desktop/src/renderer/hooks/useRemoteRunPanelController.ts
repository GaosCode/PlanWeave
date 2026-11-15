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
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  desktopWorkspaceExecutionStartInputSchema,
  desktopWorkspaceExecutionFollowInputSchema,
  desktopWorkspaceExecutionCancelInputSchema,
  desktopWorkspaceExecutionRespondInputSchema,
  desktopWorkspaceExecutionResumeInputSchema,
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
  projectRemoteLifecyclePhase,
  projectRemoteRunPanelViewModel,
  type RemoteRunActionAvailability,
  type RemoteRunAuthorizedActionKind,
  type RemoteRunPanelViewModel
} from "../collaboration/remoteRunViewModels";
import {
  remoteRunOperationObservation,
  remoteRunResumeAvailabilityLabel,
  remoteRunResumeFailure,
  remoteRunResumeOutcome,
  remoteRunResumeProgress,
  type RemoteRunResumeObservation
} from "../collaboration/remoteRunResume";
import { workspaceExecutionSuccessPollDelay } from "../task-workspace/workspaceExecutionPollingCadence";
import type { createTranslator } from "../i18n";

const resumePollLimit = 14;
const resumePollMaxDelayMs = 5_000;

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
  resumePending: boolean;
  resumeNotice: string | null;
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
  resume: () => Promise<void>;
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

function phase(
  view: DesktopWorkspaceExecutionResponse,
  observation: ReturnType<typeof remoteRunOperationObservation>
) {
  if (view.remoteResume) return "interrupted";
  if (observation)
    return projectRemoteLifecyclePhase({ observation, runtime: null, canDispatch: false });
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
  pending: number,
  canResume: boolean
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
    canResume
      ? { kind: "resume_same_session", available: true, requiresConfirm: false }
      : { kind: "resume_same_session", available: false, reason: "not_resumable" },
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
  const [resumeTarget, setResumeTarget] = useState<RemoteRunResumeObservation | null>(null);
  const [resumeRequiresRefresh, setResumeRequiresRefresh] = useState(false);
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
      setResumeTarget(null);
      setResumeRequiresRefresh(false);
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
  const refreshAgentEndpointsOnOpen = useEffectEvent(refreshAgentEndpoints);
  useEffect(() => {
    const generation = scopeGenerationRef.current;
    if (args.open)
      void refreshAgentEndpointsOnOpen().catch((error) => {
        if (scopeGenerationRef.current === generation) setActionError(String(error));
      });
  }, [args.open]);

  const currentRemoteEndpointId = remoteEndpointId(view);
  const resumeOutcome = resumeTarget && view ? remoteRunResumeOutcome(resumeTarget, view) : null;
  if (
    !retireIdentity &&
    resumeOutcome === "resumed" &&
    resumeTarget &&
    !resumeTarget.observedLoad
  ) {
    setResumeTarget({ ...resumeTarget, observedLoad: true });
  }
  const canRetryResume =
    resumeTarget?.receipt === "not_recorded" ||
    (resumeTarget?.paused && resumeTarget.receipt === "recorded");
  const resumePending =
    actionInFlight === "resume_same_session" ||
    (resumeOutcome === "awaiting" && !canRetryResume && !resumeTarget?.paused);
  const bridgeSupportsResume = typeof executionApi?.resumeWorkspaceExecution === "function";
  const canResume =
    bridgeSupportsResume &&
    args.open &&
    Boolean(args.executionLocator && view?.remoteResume?.available) &&
    !resumeRequiresRefresh &&
    (resumeOutcome !== "awaiting" || canRetryResume || resumePending);
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
      const operationToObserve =
        view?.handle.target === "remote" && (view.remoteResume || resumeOutcome === "awaiting")
          ? view.handle.operationId
          : !view
            ? existingOperationId
            : null;
      const next = operationToObserve
        ? await executionApi.followWorkspaceExecution(
            desktopWorkspaceExecutionFollowInputSchema.parse({
              locator: args.executionLocator,
              blockRef: args.workItem.blockRef,
              operationId: operationToObserve
            })
          )
        : view
          ? await executionApi.followWorkspaceExecution(
              desktopWorkspaceExecutionFollowInputSchema.parse({
                locator: args.executionLocator,
                blockRef: args.workItem.blockRef,
                ...descriptor(endpointForView, args, currentRemoteEndpointId),
                sessionId: view.session.sessionId
              })
            )
          : null;
      if (
        next &&
        scopeGenerationRef.current === scopeGeneration &&
        responseOwnerRef.current === owner
      ) {
        setView(next);
        setResumeRequiresRefresh(false);
      }
    } catch (error) {
      if (scopeGenerationRef.current === scopeGeneration && responseOwnerRef.current === owner) {
        const message = error instanceof Error ? error.message : String(error);
        if (resumeOutcome === "awaiting") {
          const failure = remoteRunResumeFailure(message, args.t);
          if (failure.requiresRefresh) {
            setResumeTarget(null);
            setResumeRequiresRefresh(true);
            setActionError(failure.message);
          }
        } else {
          setActionError(message);
        }
      }
    } finally {
      if (scopeGenerationRef.current === scopeGeneration && followOwnerRef.current === owner) {
        followOwnerRef.current = null;
        setLoading(false);
      }
    }
  }, [
    args,
    currentRemoteEndpointId,
    endpointForView,
    executionApi,
    existingOperationId,
    resumeOutcome,
    view
  ]);
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
      if (scopeGenerationRef.current === generation) {
        setResumeTarget((current) => (current?.paused ? { ...current, paused: false } : current));
        await follow();
      }
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
  const resumeLocator = args.executionLocator;
  const resumeBlockRef = args.workItem?.kind === "block" ? args.workItem.blockRef : null;
  const resumeWorkspaceExecution = executionApi?.resumeWorkspaceExecution;
  const resumePollInputs = useRef({ locator: resumeLocator, blockRef: resumeBlockRef, t: args.t });
  useEffect(() => {
    resumePollInputs.current = { locator: resumeLocator, blockRef: resumeBlockRef, t: args.t };
  }, [resumeLocator, resumeBlockRef, args.t]);
  useEffect(() => {
    if (
      !args.open ||
      resumeOutcome !== "awaiting" ||
      !resumeTarget ||
      resumeTarget.paused ||
      !resumeWorkspaceExecution
    )
      return;
    const generation = identity.generation;
    let stopped = false;
    let pollCount = 0;
    let timer: ReturnType<typeof setTimeout>;
    const isCurrent = () => !stopped && scopeGenerationRef.current === generation;
    const poll = async () => {
      if (!isCurrent()) return;
      const { locator, blockRef, t } = resumePollInputs.current;
      if (!locator || !blockRef) return;
      if (!actionOwnerRef.current && !followOwnerRef.current) {
        if (typeof resumeTarget.receipt === "object") {
          await followRef.current();
        } else {
          try {
            const receipt = await resumeWorkspaceExecution(
              desktopWorkspaceExecutionResumeInputSchema.parse({
                locator,
                blockRef,
                mode: "observe",
                expectedRemoteHandle: resumeTarget.expected
              })
            );
            if (!isCurrent()) return;
            const progress = remoteRunResumeProgress(receipt);
            if (progress !== resumeTarget.receipt) {
              setResumeTarget((current) =>
                current === resumeTarget ? { ...current, receipt: progress } : current
              );
              return;
            }
          } catch (error) {
            if (!isCurrent()) return;
            const failure = remoteRunResumeFailure(
              error instanceof Error ? error.message : String(error),
              t
            );
            if (failure.requiresRefresh) {
              setResumeTarget(null);
              setResumeRequiresRefresh(true);
              setActionError(failure.message);
              return;
            }
          }
        }
      }
      if (!isCurrent()) return;
      if (pollCount >= resumePollLimit - 1) {
        setResumeTarget((current) =>
          current === resumeTarget ? { ...current, paused: true } : current
        );
        return;
      }
      timer = setTimeout(
        poll,
        Math.min(
          workspaceExecutionSuccessPollDelay(pollCount++, resumeTarget.expected.operationId),
          resumePollMaxDelayMs
        )
      );
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [args.open, identity.generation, resumeOutcome, resumeTarget, resumeWorkspaceExecution]);
  const run = useCallback(
    async (
      kind: RemoteRunAuthorizedActionKind,
      call: (isCurrent: () => boolean) => Promise<DesktopWorkspaceExecutionResponse | undefined>
    ) => {
      if (actionOwnerRef.current) return;
      const owner = { kind };
      actionOwnerRef.current = owner;
      responseOwnerRef.current = owner;
      const scopeGeneration = scopeGenerationRef.current;
      const isCurrent = () =>
        scopeGenerationRef.current === scopeGeneration && responseOwnerRef.current === owner;
      setActionInFlight(kind);
      setActionError(null);
      try {
        const next = await call(isCurrent);
        if (isCurrent()) {
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
        if (isCurrent()) {
          const message = error instanceof Error ? error.message : String(error);
          if (kind === "resume_same_session") {
            const failure = remoteRunResumeFailure(message, args.t);
            setResumeRequiresRefresh(failure.requiresRefresh);
            setActionError(failure.message);
          } else {
            setActionError(message);
          }
        }
      } finally {
        if (scopeGenerationRef.current === scopeGeneration && actionOwnerRef.current === owner) {
          actionOwnerRef.current = null;
          setActionInFlight(null);
        }
      }
    },
    [args.t]
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
  const resume = useCallback(async () => {
    const api = executionApi;
    const locator = args.executionLocator;
    const item = args.workItem;
    const handle = view?.handle;
    if (
      !canResume ||
      resumePending ||
      !api?.resumeWorkspaceExecution ||
      !locator ||
      item?.kind !== "block" ||
      handle?.target !== "remote"
    )
      return;
    const resumeWorkspaceExecution = api.resumeWorkspaceExecution;
    return run("resume_same_session", async (isCurrent) => {
      const expected =
        resumeOutcome === "awaiting" && resumeTarget ? resumeTarget.expected : handle;
      setResumeTarget(null);
      try {
        const receipt = await resumeWorkspaceExecution(
          desktopWorkspaceExecutionResumeInputSchema.parse({
            locator,
            blockRef: item.blockRef,
            expectedRemoteHandle: expected
          })
        );
        const progress = remoteRunResumeProgress(receipt);
        if (isCurrent()) {
          setResumeTarget({ expected, observedLoad: false, receipt: progress, paused: false });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isCurrent() && !remoteRunResumeFailure(message, args.t).requiresRefresh) {
          setResumeTarget({ expected, observedLoad: false, receipt: "unknown", paused: false });
        }
        throw error;
      }
      return undefined;
    });
  }, [
    args.executionLocator,
    args.workItem,
    args.t,
    canResume,
    executionApi,
    resumeOutcome,
    resumePending,
    resumeTarget,
    run,
    view
  ]);
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
    const observation = remoteRunOperationObservation(view);
    return {
      ...base,
      phase: phase(view, observation),
      operationState: observation?.state ?? state,
      attemptStatus: observation?.attemptStatus ?? attempt,
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
      actions: actions(view, pending.length, canResume),
      actionRequired: view.session.phase === "blocked" || pending.length > 0,
      interruptionResumable: canResume,
      runtimeBindingSummary: `${view.session.phase}/${view.session.evidence.status}`,
      diagnostics: view.session.evidence.diagnostics.map((item) => item.code)
    };
  }, [args.executionLocator, args.workItem, base, canResume, view]);
  const resumeNotice =
    resumeOutcome === "awaiting" && resumeTarget?.paused
      ? args.t("remoteRunResumeObservationFailed")
      : resumeOutcome === "awaiting" && resumeTarget?.receipt === "not_recorded"
        ? args.t("remoteRunResumeNotRecorded")
        : resumePending
          ? args.t("remoteRunResumePending")
          : resumeOutcome === "resumed"
            ? args.t("remoteRunResumeSucceeded")
            : resumeOutcome === "failed"
              ? args.t("remoteRunResumeInterruptedAgain")
              : resumeOutcome === "changed"
                ? args.t("remoteRunResumeChanged")
                : viewModel.phase === "interrupted" && !canResume && !actionError
                  ? remoteRunResumeAvailabilityLabel(view, bridgeSupportsResume, args.t)
                  : null;
  return {
    viewModel,
    loading,
    loadingEvents: loading,
    loadingInteractions: loading,
    actionInFlight,
    actionError,
    resumePending,
    resumeNotice,
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
