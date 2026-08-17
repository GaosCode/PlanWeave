import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  AgentCapabilities,
  SessionNotification,
  TerminalOutputRequest
} from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type { ExecutorAdapterResult } from "../types.js";
import {
  AcpOperationTimeoutError,
  DEFAULT_ACP_OPERATION_TIMEOUT_MS,
  type AcpConnection,
  type CreateAcpConnectionOptions
} from "./acpConnection.js";
import type { AcpLiveRunTransport } from "./acpConnectionProvider.js";
import {
  AcpAuthenticationRequiredError,
  mayProbeSessionDespiteAuthRequired
} from "./acpAuthentication.js";
import { ExecutorCancelledError } from "./executorCancellation.js";
import {
  extractFinalArtifactEnvelope,
  finalArtifactPromptInstruction,
  finalArtifactRelativePath,
  materializeFinalArtifact,
  type ExpectedFinalArtifactIdentity
} from "./finalArtifactContract.js";
import {
  activeAgentRunRegistry,
  throwAgentRunCleanupFailures,
  type ActiveAgentRunHandle,
  type ActiveAgentRunRegistry
} from "./activeAgentRunRegistry.js";
import { redactAcpProtocolPayload, redactRunnerEventText } from "./runnerEventRedaction.js";
import { normalizedRedactedContent } from "./normalizedEventContract.js";
import type { LivePendingRequestHandle, RunnerInteractionBroker } from "./liveControl.js";
import {
  normalizeAcpSessionNotification,
  normalizeAcpTerminalOutput
} from "./acpEventNormalization.js";
import {
  acpCorrelationSchema,
  runnerIdentitySchema,
  runnerRunIdentitySchema,
  runnerSessionActionIdentitySchema
} from "./runnerContractSchemas.js";
import { acpEventReadModels, type AcpEventReadModelRegistry } from "./acpEventReadModel.js";
import { createPersistentAcpPermissionHandler } from "./acpPermissionInteraction.js";
import { AcpOwnerStateWriter } from "./acpOwnerState.js";
import { AcpOwnerWriteFence } from "./acpOwnerWriteFence.js";
import {
  availableAgentRunControlSummary,
  unavailableAgentRunControlSummary
} from "./agentRunControlAvailability.js";
import { agentRunControlLeaseIdSchema } from "./agentRunControlContract.js";
import { AgentRunControlServer } from "./agentRunControlServer.js";
import { createActiveAgentRunControlTarget } from "./agentRunControlTarget.js";
import { RunnerInteractionChannelError } from "./persistentRunnerInteractionChannel.js";
import type { RunnerInteractionObserver } from "./runnerInteractionObserver.js";
import type { DesktopAcpSessionDefaults } from "./desktopAgentSettings.js";
import { sessionConfigurationFromNewSession } from "./acpSessionConfiguration.js";
import { acpSessionStartSchema } from "./acpRunRecovery.js";
import { projectRunnerNextActions } from "./runnerNextActions.js";
import { applyDesktopAcpSessionDefaultsWithConfigurator } from "./acpSessionDefaults.js";
import { createLocalAcpPromptSource, executeLocalAcpAdapter } from "./acpLocalExecutionAdapter.js";
import type { AcpEngineLifecycleEvent } from "./acpExecutionEngineContracts.js";
import { createLocalAcpInteractionBroker } from "./acpLocalInteractionBroker.js";
import { createLocalAcpActiveRunHandle } from "./acpLocalActiveRunHandle.js";
import { prepareExecutionHostInvocation } from "../process/wslExecutionHost.js";
import type { AcpCapabilitySnapshot } from "./acpCapabilityGate.js";
import type { AcpSessionRun } from "./acpSessionRunContract.js";

export { applyDesktopAcpSessionDefaults } from "./acpSessionDefaults.js";
export type { AcpSessionRun, AcpSessionRunKind } from "./acpSessionRunContract.js";

type ConnectionFactory = (options: CreateAcpConnectionOptions) => AcpConnection;
type TerminalStatus = "completed" | "failed" | "cancelled" | "timed_out";

function diagnostic(error: unknown): string {
  if (error instanceof AggregateError) {
    return error.errors.map((item) => diagnostic(item)).join("; ");
  }
  return redactRunnerEventText(error instanceof Error ? error.message : String(error)).text;
}

function expectedArtifact(run: AcpSessionRun): ExpectedFinalArtifactIdentity {
  if (run.kind === "feedback") {
    return {
      kind: "feedback",
      feedbackId: run.metadataIdentity.feedbackId,
      sourceReviewBlockRef: run.metadataIdentity.sourceReviewBlockRef,
      taskId: run.taskId
    };
  }
  return { kind: run.kind, ref: run.identity.claimRef, taskId: run.taskId };
}

export class AcpSessionController {
  constructor(
    private readonly registry: ActiveAgentRunRegistry = activeAgentRunRegistry,
    private readonly connect?: ConnectionFactory,
    private readonly eventReadModels: AcpEventReadModelRegistry = acpEventReadModels
  ) {}

  async execute(
    run: AcpSessionRun,
    options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      interactionBroker?: RunnerInteractionBroker;
      interactionObserver?: RunnerInteractionObserver;
      sessionDefaults?: DesktopAcpSessionDefaults;
      onMetadataPersisted?: () => void | Promise<void>;
    }
  ): Promise<ExecutorAdapterResult> {
    await mkdir(run.runDir, { recursive: true });
    const heartbeatPath = join(run.runDir, "heartbeat.json");
    const startedAt = new Date().toISOString();
    const ownerLeaseId = randomUUID();
    const agentRunControlLeaseId = agentRunControlLeaseIdSchema.parse(ownerLeaseId);
    const ownerGeneration = 1;
    const ownerWriteFence = new AcpOwnerWriteFence(run.runDir, ownerLeaseId, ownerGeneration);
    const sessionStart = acpSessionStartSchema.parse(run.sessionStart ?? { kind: "new" });
    const executionHost = run.host ?? { kind: "native" };
    let output = "";
    let executionPhase: "connecting" | "session" | "prompt" | "artifact" | "cleanup" = "connecting";
    let initializedCapabilities: AgentCapabilities | undefined;
    let capabilitySnapshot: AcpCapabilitySnapshot | null = null;
    const negotiatedCapability = (
      capability: AcpCapabilitySnapshot["negotiated"][number]
    ): boolean => capabilitySnapshot?.negotiated.includes(capability) === true;
    let initializedSessionId: string | null = null;
    let handle: ActiveAgentRunHandle | null = null;
    let handleRegistered = false;
    let cleanupAttempted = false;
    let cleanupCompleted = false;
    let validatedArtifactReference: Awaited<ReturnType<typeof materializeFinalArtifact>> | null =
      null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let controlServer: AgentRunControlServer | null = null;
    let controlStopPromise: Promise<void> | null = null;
    const abortController = new AbortController();
    const blockId = run.metadataIdentity.blockId ?? run.identity.claimRef.split("#")[1];
    if (!blockId) throw new Error("ACP run is missing a block id for its event identity.");
    if ((run.projectId === undefined) !== (run.canvasId === undefined)) {
      throw new Error("ACP event identity requires both projectId and canvasId.");
    }
    const eventModel =
      run.projectId && run.canvasId
        ? await this.eventReadModels.create({
            runDir: run.runDir,
            identity: runnerRunIdentitySchema.parse({
              projectId: run.projectId,
              canvasId: run.canvasId,
              taskId: run.taskId,
              blockId,
              claimRef: run.identity.claimRef,
              runId: run.identity.executorRunId,
              runOwner: "executor",
              runSessionId: run.identity.runSessionId ?? null,
              desktopRunId: run.identity.desktopRunId ?? null,
              executorRunId: run.identity.executorRunId
            }),
            runner: runnerIdentitySchema.parse({
              version: "planweave.runner/v1",
              runnerKind: "acp",
              agentId: run.agentId
            }),
            writeGuard: (operation) => ownerWriteFence.withOwnerWrite(operation)
          })
        : null;
    const eventStore = eventModel?.store ?? null;
    if (eventStore)
      await eventStore.append({ kind: "lifecycle", state: "created", message: "ACP run created." });
    let interactionFailure: RunnerInteractionChannelError | null = null;
    let operationDeadline: Date | null = null;
    const pendingRequests = new Map<string, LivePendingRequestHandle>();
    const releasePendingRequest = (requestId: string): void => {
      pendingRequests.delete(requestId);
      if (pendingRequests.size === 0 && handle?.lifecycleState === "waiting_interaction") {
        this.registry.transition(handle, "running");
      }
      if (handle) this.registry.notifyInteractionChanged(handle);
    };
    let protocolObserverError: unknown;
    const terminalOutputHandler = run.terminalOutputHandler;
    const ownerState = new AcpOwnerStateWriter({
      heartbeatPath,
      metadataPath: run.metadataPath,
      ownerLeaseId,
      ownerGeneration,
      startedAt,
      controlAvailability: unavailableAgentRunControlSummary("initializing"),
      metadata: {
        runId: run.identity.executorRunId,
        ref: run.identity.claimRef,
        taskId: run.taskId,
        executor: run.executorName,
        agentId: run.agentId,
        runnerKind: "acp",
        executionHost,
        executorProfile: run.executorName,
        ...(run.profileIdentity.source === "builtin" ? { acpLaunch: run.launch } : {}),
        acpProfile: {
          profileId: run.profileIdentity.profileId,
          fingerprint: run.profileIdentity.fingerprint,
          source: run.profileIdentity.source,
          host: executionHost,
          ...(run.profileIdentity.source === "builtin" ? { launch: run.launch } : {}),
          environmentNames: [...run.profileIdentity.environmentNames],
          missingEnvironmentNames: []
        },
        recovery: sessionStart.kind === "load" ? sessionStart.recovery : null,
        recoveryInterruptionReason: null,
        projectId: run.projectId,
        canvasId: run.canvasId,
        ...run.identity,
        desktopRunId: run.identity.desktopRunId ?? null,
        runSessionId: run.identity.runSessionId ?? null,
        ...run.metadataIdentity
      },
      writeGuard: (operation) => ownerWriteFence.withOwnerWrite(operation)
    });
    const relayAbort = (): void => abortController.abort(options?.signal?.reason);
    options?.signal?.addEventListener("abort", relayAbort, { once: true });
    const writeState = async (
      status: "running" | TerminalStatus,
      patch: Record<string, unknown> = {}
    ): Promise<void> => {
      await ownerState.update(status, patch);
    };
    const prepareControlRemoval = async (): Promise<void> => {
      const results = await Promise.allSettled([
        controlServer?.requestShutdown(),
        ownerState.setControlAvailability(unavailableAgentRunControlSummary("owner_terminal"))
      ]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      throwAgentRunCleanupFailures(
        failures,
        "ACP control endpoint could not prepare for owner removal."
      );
    };
    const stopControlEndpoint = (): Promise<void> => {
      if (controlStopPromise) return controlStopPromise;
      const attempt = (async () => {
        const results = await Promise.allSettled([
          controlServer?.stop(),
          ownerState.setControlAvailability(unavailableAgentRunControlSummary("owner_terminal"))
        ]);
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : []
        );
        throwAgentRunCleanupFailures(failures, "ACP control endpoint could not stop cleanly.");
      })();
      controlStopPromise = attempt;
      void attempt.catch(() => {
        if (controlStopPromise === attempt) controlStopPromise = null;
      });
      return attempt;
    };
    const removeControlHandle = async (
      ownedHandle: ActiveAgentRunHandle,
      reason: string,
      terminalState: "succeeded" | "failed" | "cancelled",
      artifactValidated = false
    ): Promise<void> => {
      const failures: unknown[] = [];
      try {
        await this.registry.remove(ownedHandle, reason, terminalState, artifactValidated);
      } catch (error) {
        failures.push(error);
      }
      try {
        await stopControlEndpoint();
      } catch (error) {
        failures.push(error);
      }
      throwAgentRunCleanupFailures(failures, "Runner terminal cleanup did not complete cleanly.");
    };
    const currentHandle = (): ActiveAgentRunHandle | null => handle;
    try {
      await writeState("running", {
        sessionId: null,
        capabilities: null,
        acpCapabilitySnapshot: null,
        pid: null,
        diagnosticArtifacts: {
          protocol: "protocol.ndjson",
          events: "events.ndjson",
          conversationJson: "conversation.json",
          conversationMarkdown: "conversation.md"
        }
      });
      await options?.onMetadataPersisted?.();
      heartbeatTimer = setInterval(() => {
        void ownerState.heartbeat().catch((error) => {
          const failure = new RunnerInteractionChannelError(
            "interaction_persistence_failed",
            "ACP owner heartbeat could not be persisted.",
            { cause: error }
          );
          interactionFailure ??= failure;
          abortController.abort(failure);
        });
      }, 5_000);
      heartbeatTimer.unref();
      if (abortController.signal.aborted) {
        throw new ExecutorCancelledError(diagnostic(abortController.signal.reason));
      }
      const eventSink = async (notification: SessionNotification): Promise<void> => {
        const normalized = normalizeAcpSessionNotification(notification);
        if (eventStore && normalized) {
          await eventStore.append(
            normalized,
            acpCorrelationSchema.parse({ sessionId: notification.sessionId })
          );
        }
      };
      const spawnEnvironment = run.environment.env;
      const preparedLaunch = await prepareExecutionHostInvocation({
        host: executionHost,
        command: run.launch.command,
        args: run.launch.args,
        cwd: run.cwd,
        env: spawnEnvironment
      });
      const permissionHandler = createPersistentAcpPermissionHandler({
        runDir: run.runDir,
        identity: {
          projectId: run.projectId,
          canvasId: run.canvasId,
          claimRef: run.identity.claimRef,
          executorRunId: run.identity.executorRunId,
          ownerLeaseId,
          ownerGeneration
        },
        eventStore,
        signal: abortController.signal,
        deadline: () => operationDeadline,
        interactionBroker: options?.interactionBroker,
        interactionObserver: options?.interactionObserver,
        setWaiting: async (requestId, waiting) => {
          await ownerState.setInteractionWaiting(requestId, waiting);
          if (waiting && handle?.lifecycleState === "running") {
            this.registry.transition(handle, "waiting_interaction");
          }
          if (handle) this.registry.notifyInteractionChanged(handle);
        },
        addPending: (pending) => pendingRequests.set(pending.requestId, pending),
        releasePending: releasePendingRequest,
        recordFailure: (failure) => {
          interactionFailure ??= failure;
        }
      });
      const engineInteractionBroker = createLocalAcpInteractionBroker({
        permissionHandler,
        eventStore,
        interactionBroker: options?.interactionBroker,
        setOperationDeadline: (deadline) => {
          operationDeadline = deadline;
        },
        addPending: (pending) => {
          pendingRequests.set(pending.requestId, pending);
          if (handle?.lifecycleState === "running") {
            this.registry.transition(handle, "waiting_interaction");
          }
          if (handle) this.registry.notifyInteractionChanged(handle);
        },
        releasePending: releasePendingRequest
      });
      const expected = expectedArtifact(run);
      const artifactRelative = finalArtifactRelativePath(run.kind);
      const artifactPath = join(run.runDir, artifactRelative);
      const agentPrompt = `${run.prompt}\n\n${finalArtifactPromptInstruction(expected)}`;
      const markReady = async (): Promise<void> => {
        if (!handle || handle.lifecycleState !== "initializing") return;
        handle.control.interventionCapabilities.cancel = true;
        handle.control.interventionCapabilities.permission = eventStore !== null;
        handle.control.interventionCapabilities.elicitationPreview =
          options?.interactionBroker != null;
        this.registry.transition(handle, "ready");
        if (eventStore) {
          await eventStore.append({
            kind: "lifecycle",
            state: "ready",
            message: "ACP runner is ready."
          });
        }
      };
      const publishConnection = (created: AcpLiveRunTransport): void => {
        handle = createLocalAcpActiveRunHandle({
          identity: run.identity,
          connection: created,
          abortController,
          eventSink,
          agentRunControlLeaseId,
          pendingRequests,
          supportsSessionClose: () => negotiatedCapability("session-close")
        });
        this.registry.register(handle);
        handleRegistered = true;
      };
      const followUpPrompts = createLocalAcpPromptSource(async (deliver) => {
        if (!handle) throw new Error("ACP prompt source started before live ownership was ready.");
        await this.registry.drainPromptQueue(handle, deliver);
      });
      const lifecycleObserver = async (event: AcpEngineLifecycleEvent): Promise<void> => {
        switch (event.kind) {
          case "connection_ready":
            if (eventStore) {
              await eventStore.append({
                kind: "lifecycle",
                state: "initializing",
                message: "ACP connection initialized."
              });
            }
            await writeState("running", { pid: event.processId });
            return;
          case "initialized":
            initializedCapabilities = event.agentCapabilities;
            return;
          case "capability_gated":
            capabilitySnapshot = event.snapshot;
            await writeState("running", { acpCapabilitySnapshot: event.snapshot });
            return;
          case "authentication_completed":
            if (event.authentication.kind === "auth_required") {
              if (!mayProbeSessionDespiteAuthRequired(event.authentication) && eventStore) {
                await eventStore.append({
                  kind: "lifecycle",
                  state: "initializing",
                  message: "ACP authentication requires user action."
                });
              }
              return;
            }
            if (eventStore) {
              if (event.authentication.kind === "authenticated") {
                await eventStore.append({
                  kind: "lifecycle",
                  state: "initializing",
                  message: diagnostic(
                    `ACP authentication method selected: ${event.authentication.methodId}`
                  )
                });
                await eventStore.append({
                  kind: "lifecycle",
                  state: "initializing",
                  message: "ACP authentication completed."
                });
              } else {
                await eventStore.append({
                  kind: "lifecycle",
                  state: "initializing",
                  message: "ACP agent did not advertise authentication methods."
                });
              }
            }
            await markReady();
            return;
          case "authentication_probe":
            if (eventStore) {
              await eventStore.append({
                kind: "lifecycle",
                state: "initializing",
                message:
                  event.state === "starting"
                    ? "ACP advertised interactive authentication; probing whether an existing login can open a session."
                    : event.state === "failed"
                      ? "ACP session probe failed; interactive authentication is still required."
                      : "ACP session opened with an existing agent login (no protocol authenticate)."
              });
            }
            if (event.state === "succeeded") await markReady();
            return;
          case "session_ready": {
            executionPhase = "session";
            initializedSessionId = event.session.sessionId;
            const sessionCorrelation = acpCorrelationSchema.parse({
              sessionId: event.session.sessionId
            });
            if (event.loaded && eventStore) {
              await eventStore.append({
                kind: "lifecycle",
                state: "initializing",
                message: `ACP recovery loaded source session '${event.session.sessionId}'.`
              });
            }
            if (eventStore) {
              await eventStore.append(
                {
                  kind: "session_configuration_snapshot",
                  phase: "initial",
                  configuration: sessionConfigurationFromNewSession(event.session)
                },
                sessionCorrelation
              );
            }
            if (options?.sessionDefaults) {
              const configuredSession = await applyDesktopAcpSessionDefaultsWithConfigurator({
                agentId: run.agentId,
                defaults: options.sessionDefaults,
                configurator: event.configurator,
                session: event.session
              });
              if (eventStore) {
                await eventStore.append(
                  {
                    kind: "session_configuration_snapshot",
                    phase: "defaults_applied",
                    configuration: configuredSession
                  },
                  sessionCorrelation
                );
              }
            }
            if (!handle) throw new Error("ACP session became ready without live ownership.");
            this.registry.bindSession(handle, event.session.sessionId);
            this.registry.transition(handle, "running");
            await writeState("running", {
              sessionId: event.session.sessionId,
              agentSessionId: event.session.sessionId,
              capabilities: initializedCapabilities ?? {}
            });
            if (run.identity.runSessionId) {
              try {
                const identity = runnerSessionActionIdentitySchema.parse({
                  scope: run.identity.scope,
                  executorRunId: run.identity.executorRunId,
                  desktopRunId: run.identity.desktopRunId ?? null,
                  runSessionId: run.identity.runSessionId,
                  claimRef: run.identity.claimRef,
                  sessionId: event.session.sessionId
                });
                controlServer = new AgentRunControlServer({
                  runDir: run.runDir,
                  leaseId: agentRunControlLeaseId,
                  target: createActiveAgentRunControlTarget({
                    registry: this.registry,
                    handle,
                    identity
                  })
                });
                handle.beforeRemove = prepareControlRemoval;
                const descriptor = await controlServer.start();
                await ownerState.setControlAvailability(
                  availableAgentRunControlSummary(descriptor.ownerPid)
                );
              } catch (startError) {
                const cleanup = await Promise.allSettled([
                  controlServer?.stop(),
                  ownerState.setControlAvailability(
                    unavailableAgentRunControlSummary("endpoint_start_failed")
                  ),
                  ownerState.update("running", {
                    controlStartError: diagnostic(startError)
                  })
                ]);
                const cleanupFailures = cleanup.flatMap((result) =>
                  result.status === "rejected" ? [result.reason] : []
                );
                if (cleanupFailures.length > 0) {
                  throw new AggregateError(
                    [startError, ...cleanupFailures],
                    "ACP control endpoint startup cleanup failed."
                  );
                }
                controlServer = null;
                handle.beforeRemove = undefined;
              }
            } else {
              await ownerState.setControlAvailability(
                unavailableAgentRunControlSummary("identity_unavailable")
              );
            }
            if (eventStore) {
              await eventStore.append(
                { kind: "lifecycle", state: "running", message: "ACP session is running." },
                sessionCorrelation
              );
            }
            return;
          }
          case "prompt_starting":
            executionPhase = "prompt";
            operationDeadline = new Date(
              Date.now() + (options?.timeoutMs ?? DEFAULT_ACP_OPERATION_TIMEOUT_MS)
            );
            if (event.followUp && eventStore) {
              await eventStore.append(
                {
                  kind: "message",
                  role: "user",
                  messageId: `desktop-live-turn-${randomUUID()}`,
                  chunk: false,
                  ...normalizedRedactedContent(event.prompt)
                },
                acpCorrelationSchema.parse({ sessionId: event.sessionId })
              );
            }
            return;
          case "prompt_completed":
            operationDeadline = null;
            if (interactionFailure) throw interactionFailure;
            if (event.stopReason === "cancelled" || abortController.signal.aborted) {
              throw new ExecutorCancelledError(
                event.stopReason === "cancelled"
                  ? event.followUp
                    ? "ACP agent cancelled the queued conversation turn."
                    : "ACP agent cancelled the session."
                  : diagnostic(abortController.signal.reason)
              );
            }
            return;
          case "prompts_completed": {
            output = event.output;
            if (eventStore) await eventStore.drain();
            if (protocolObserverError !== undefined) throw protocolObserverError;
            executionPhase = "artifact";
            const envelope = extractFinalArtifactEnvelope(output, expected);
            const artifactReference = await materializeFinalArtifact({
              envelope,
              expected,
              rootDir: run.runDir,
              relativePath: artifactRelative
            });
            validatedArtifactReference = artifactReference;
            if (eventStore) {
              await eventStore.append({ kind: "artifact", artifact: artifactReference });
              await eventStore.drain();
            }
            return;
          }
          case "cleanup_starting":
            executionPhase = "cleanup";
            cleanupAttempted = true;
            if (handle && handleRegistered) {
              const succeeded =
                event.terminal.state === "succeeded" && validatedArtifactReference !== null;
              await removeControlHandle(
                handle,
                succeeded
                  ? "ACP claim completed and released live ownership."
                  : "ACP claim failed and released live ownership.",
                succeeded
                  ? "succeeded"
                  : event.terminal.state === "cancelled"
                    ? "cancelled"
                    : "failed",
                succeeded
              );
            }
            cleanupCompleted = true;
            if (eventStore) await eventStore.drain();
            if (protocolObserverError !== undefined) throw protocolObserverError;
            return;
          case "cleanup_completed":
            cleanupCompleted = cleanupCompleted && event.cleanup.completed;
            return;
        }
      };
      const engineResult = await executeLocalAcpAdapter({
        launch: { command: preparedLaunch.command, args: preparedLaunch.args },
        cwd: preparedLaunch.sessionCwd,
        spawnCwd: preparedLaunch.spawnCwd ?? null,
        decorateProcessTree: preparedLaunch.decorateProcessTree,
        ...(preparedLaunch.cleanupExitedProcessTree
          ? { cleanupExitedProcessTree: preparedLaunch.cleanupExitedProcessTree }
          : {}),
        availableEnvironmentVariables: new Set(run.environment.availableNames),
        agentId: run.agentId,
        env: preparedLaunch.spawnEnvironment,
        shutdown: run.shutdown,
        capabilityPolicy: run.capabilityPolicy,
        prompt: agentPrompt,
        sessionStart,
        authenticationHints: run.authenticationHints,
        signal: abortController.signal,
        timeoutMs: options?.timeoutMs,
        connectionMode: run.connectionMode ?? "dedicated",
        poolIdentity: {
          projectRoot: run.projectRoot ?? run.cwd,
          profileFingerprint: run.profileIdentity.fingerprint,
          host: executionHost
        },
        ...(this.connect ? { connect: this.connect } : {}),
        onConnection: publishConnection,
        connectionExtensions: {
          ...(terminalOutputHandler
            ? {
                onTerminalOutput: async (request: TerminalOutputRequest) => {
                  const response = await terminalOutputHandler(request);
                  if (eventStore) {
                    await eventStore.append(
                      normalizeAcpTerminalOutput(request, response),
                      acpCorrelationSchema.parse({ sessionId: request.sessionId })
                    );
                  }
                  return response;
                }
              }
            : {}),
          ...(eventStore
            ? {
                observer: {
                  redact: redactAcpProtocolPayload,
                  observe: (observation: { direction: string; payload: unknown }) => {
                    void eventStore
                      .appendProtocol(observation.direction, observation.payload)
                      .catch((error) => {
                        protocolObserverError ??= error;
                      });
                  }
                }
              }
            : {})
        },
        interactionBroker: engineInteractionBroker,
        interactionDeadline: () => operationDeadline,
        followUpPrompts,
        eventSink: async (event) => {
          if (event.kind === "session_update" && eventStore) {
            await eventStore.append(
              event.body,
              acpCorrelationSchema.parse({ sessionId: event.sessionId })
            );
          }
        },
        lifecycleObserver
      });
      output = engineResult.output;
      const sessionId = engineResult.sessionId;
      if (!sessionId || !validatedArtifactReference) {
        throw new Error("ACP engine succeeded without a validated local artifact.");
      }
      if (eventStore) {
        await eventStore.append(
          {
            kind: "terminal",
            outcome: {
              version: "planweave.runner/v1",
              state: "succeeded",
              reason: "completed",
              cleanup: { status: "succeeded" },
              exitCode: 0,
              finishedAt: new Date().toISOString(),
              diagnostic: null,
              artifactValidated: true,
              nextActions: projectRunnerNextActions({
                sourceRecordId: `${run.identity.claimRef}::${run.identity.executorRunId}`,
                sourceRunId: run.identity.executorRunId,
                recoverAcpSession: false,
                retryNewSession: false
              })
            }
          },
          acpCorrelationSchema.parse({ sessionId })
        );
        await eventStore.drain();
      }
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      const finishedAt = new Date().toISOString();
      await writeState("completed", {
        sessionId,
        exitCode: 0,
        artifactReference: validatedArtifactReference
      });
      const common = {
        runId: run.identity.executorRunId,
        executor: run.executorName,
        agentId: run.agentId,
        runnerKind: "acp" as const,
        stdout: output,
        stderr: engineResult.stderr.join(""),
        exitCode: 0,
        startedAt,
        finishedAt,
        agentSessionId: sessionId
      };
      return run.kind === "review"
        ? { kind: "review", resultPath: artifactPath, ...common }
        : run.kind === "feedback"
          ? { kind: "feedback", reportPath: artifactPath, ...common }
          : { kind: "block", reportPath: artifactPath, ...common };
    } catch (error) {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      const cancelledBeforeCleanup =
        error instanceof ExecutorCancelledError || options?.signal?.aborted === true;
      const failedHandle = currentHandle();
      if (error instanceof AcpOperationTimeoutError && failedHandle) {
        failedHandle.control.sessionId = null;
      }
      let cleanupError: unknown;
      if (!cleanupAttempted) {
        cleanupAttempted = true;
        try {
          if (failedHandle && handleRegistered) {
            await removeControlHandle(
              failedHandle,
              "ACP claim failed and released live ownership.",
              cancelledBeforeCleanup ? "cancelled" : "failed"
            );
            cleanupCompleted = true;
          } else {
            cleanupCompleted = true;
          }
        } catch (caught) {
          cleanupError = caught;
        }
      }
      let controlCleanupRetryError: unknown;
      try {
        await stopControlEndpoint();
      } catch (caught) {
        controlCleanupRetryError = caught;
      }
      const executionMessage =
        cleanupAttempted && validatedArtifactReference
          ? "Execution succeeded and artifact was validated."
          : diagnostic(error);
      const cleanupDiagnostics: unknown[] = [];
      if (validatedArtifactReference) cleanupDiagnostics.push(error);
      else if (cleanupError !== undefined) cleanupDiagnostics.push(cleanupError);
      if (
        controlCleanupRetryError !== undefined &&
        controlCleanupRetryError !== error &&
        controlCleanupRetryError !== cleanupError
      ) {
        cleanupDiagnostics.push(controlCleanupRetryError);
      }
      const cleanupMessage =
        cleanupDiagnostics.length > 0 ? cleanupDiagnostics.map(diagnostic).join("; ") : null;
      const message = cleanupMessage
        ? `Execution: ${executionMessage}; cleanup: ${cleanupMessage}`
        : executionMessage;
      const timedOut = error instanceof AcpOperationTimeoutError;
      const cancelled = cancelledBeforeCleanup || failedHandle?.lifecycleState === "cancelled";
      const cleanupFailed =
        cleanupError !== undefined ||
        controlCleanupRetryError !== undefined ||
        (cleanupAttempted && !cleanupCompleted);
      const status: TerminalStatus = timedOut ? "timed_out" : cancelled ? "cancelled" : "failed";
      const transportInterrupted =
        !(error instanceof RequestError) &&
        !(error instanceof AcpAuthenticationRequiredError) &&
        protocolObserverError === undefined &&
        (executionPhase === "connecting" ||
          executionPhase === "session" ||
          executionPhase === "prompt");
      const recoveryInterruptionReason = timedOut
        ? "timed_out"
        : cancelled
          ? "recoverable_cancel"
          : transportInterrupted
            ? "transport_lost"
            : null;
      const eventLogErrors: unknown[] = [];
      if (eventStore && !cancelled) {
        try {
          await eventStore.append({
            kind: "diagnostic",
            code: "protocol_error",
            message
          });
        } catch (caught) {
          eventLogErrors.push(caught);
        }
      }
      if (eventStore) {
        try {
          await eventStore.append({
            kind: "terminal",
            outcome: {
              version: "planweave.runner/v1",
              state: cancelled ? "cancelled" : "failed",
              reason: timedOut ? "timed_out" : cancelled ? "cancelled" : "failed",
              cleanup: { status: cleanupFailed ? "failed" : "succeeded" },
              exitCode: cancelled ? 130 : 1,
              finishedAt: new Date().toISOString(),
              diagnostic: message,
              artifactValidated: validatedArtifactReference !== null,
              nextActions: projectRunnerNextActions({
                sourceRecordId: `${run.identity.claimRef}::${run.identity.executorRunId}`,
                sourceRunId: run.identity.executorRunId,
                recoverAcpSession:
                  recoveryInterruptionReason !== null &&
                  initializedSessionId !== null &&
                  negotiatedCapability("history-load"),
                retryNewSession: true
              })
            }
          });
        } catch (caught) {
          eventLogErrors.push(caught);
        }
        try {
          await eventStore.drain();
        } catch (caught) {
          eventLogErrors.push(caught);
        }
      }
      await writeState(status, {
        failureReason: message,
        timedOut,
        recoveryInterruptionReason,
        exitCode: cancelled ? 130 : 1,
        ...(validatedArtifactReference
          ? { artifactReference: validatedArtifactReference, executionOutcome: "succeeded" }
          : {})
      });
      const finalizationErrors: unknown[] = [];
      if (cleanupError !== undefined && cleanupError !== error) {
        finalizationErrors.push(cleanupError);
      }
      if (
        controlCleanupRetryError !== undefined &&
        controlCleanupRetryError !== error &&
        controlCleanupRetryError !== cleanupError
      ) {
        finalizationErrors.push(controlCleanupRetryError);
      }
      finalizationErrors.push(...eventLogErrors.filter((caught) => caught !== error));
      if (cleanupFailed || finalizationErrors.length > 0) {
        const cleanupMarker = "Runner terminal cleanup did not complete cleanly.";
        // Keep an already-canonical cleanup AggregateError nested (not flattened) so callers
        // can still locate preparation/stop failures by the exact marker message.
        if (cleanupFailed && error instanceof AggregateError && error.message === cleanupMarker) {
          if (finalizationErrors.length === 0) {
            throw error;
          }
          throw new AggregateError([error, ...finalizationErrors], message);
        }
        const executionErrors = error instanceof AggregateError ? error.errors : [error];
        throw new AggregateError(
          [...executionErrors, ...finalizationErrors],
          cleanupFailed ? `${cleanupMarker} ${message}` : message
        );
      }
      if (cancelled && !(error instanceof ExecutorCancelledError)) {
        throw new ExecutorCancelledError(message);
      }
      throw error;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      options?.signal?.removeEventListener("abort", relayAbort);
      this.eventReadModels.release(run.runDir);
    }
  }
}
