import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type {
  AgentCapabilities,
  CreateElicitationResponse,
  NewSessionResponse,
  SessionNotification,
  TerminalOutputRequest,
  TerminalOutputResponse
} from "@agentclientprotocol/sdk";
import {
  CreateElicitationRequest as CreateElicitationRequestGuard,
  RequestError
} from "@agentclientprotocol/sdk";
import type { AgentFamily, ExecutorAdapterResult } from "../types.js";
import {
  AcpOperationTimeoutError,
  DEFAULT_ACP_OPERATION_TIMEOUT_MS,
  createAcpConnection,
  type AcpConnection,
  type CreateAcpConnectionOptions
} from "./acpConnection.js";
import {
  AcpAuthenticationRequiredError,
  coordinateAcpAuthentication,
  type AcpAuthenticationHints
} from "./acpAuthentication.js";
import { ExecutorCancelledError } from "./executorShared.js";
import {
  extractFinalArtifactEnvelope,
  finalArtifactPromptInstruction,
  finalArtifactRelativePath,
  materializeFinalArtifact,
  type ExpectedFinalArtifactIdentity
} from "./finalArtifactContract.js";
import {
  activeAgentRunRegistry,
  type ActiveAgentRunHandle,
  type ActiveAgentRunIdentity,
  type ActiveAgentRunRegistry
} from "./activeAgentRunRegistry.js";
import {
  redactAcpProtocolPayload,
  redactRunnerEventPayload,
  redactRunnerEventText
} from "./runnerEventRedaction.js";
import { normalizedRedactedContent } from "./normalizedEventContract.js";
import {
  createLiveOwnership,
  type JsonRpcValue,
  type LivePendingRequestHandle,
  type RunnerInteractionBroker
} from "./liveControl.js";
import {
  createAcpInteractionRequestId,
  normalizeAcpElicitationHistory,
  normalizeAcpSessionNotification,
  normalizeAcpTerminalOutput
} from "./acpEventNormalization.js";
import {
  acpCorrelationSchema,
  runnerIdentitySchema,
  runnerRunIdentitySchema
} from "./runnerContractSchemas.js";
import { acpEventReadModels, type AcpEventReadModelRegistry } from "./acpEventReadModel.js";
import { createAcpElicitationSettlement } from "./acpElicitationSettlement.js";
import { createPersistentAcpPermissionHandler } from "./acpPermissionInteraction.js";
import { AcpOwnerStateWriter } from "./acpOwnerState.js";
import { RunnerInteractionChannelError } from "./persistentRunnerInteractionChannel.js";
import type { DesktopAcpSessionDefaults } from "./desktopAgentSettings.js";
import {
  sessionConfigurationFromNewSession,
  sessionConfigurationFromProtocol,
  type AcpSessionConfiguration
} from "./acpSessionConfiguration.js";

export type AcpSessionRunKind = "implementation" | "review" | "feedback";
export type AcpSessionRun = {
  kind: AcpSessionRunKind;
  identity: Omit<ActiveAgentRunIdentity, "sessionId">;
  runDir: string;
  metadataPath: string;
  prompt: string;
  cwd: string;
  launch: { command: string; args: readonly string[] };
  authenticationHints?: AcpAuthenticationHints;
  executorName: string;
  agentId: AgentFamily;
  taskId: string;
  metadataIdentity: Record<string, string>;
  projectId?: string;
  canvasId?: string;
  terminalOutputHandler?: (
    request: TerminalOutputRequest
  ) => TerminalOutputResponse | Promise<TerminalOutputResponse>;
};

type ConnectionFactory = (options: CreateAcpConnectionOptions) => AcpConnection;
type TerminalStatus = "completed" | "failed" | "cancelled" | "timed_out";

function environment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function updateText(notification: SessionNotification): string | null {
  const update = notification.update;
  if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return null;
  return update.content.text;
}

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

export async function applyDesktopAcpSessionDefaults(options: {
  agentId: AgentFamily;
  defaults: DesktopAcpSessionDefaults;
  connection: AcpConnection;
  session: NewSessionResponse;
  operation?: { signal?: AbortSignal; timeoutMs?: number };
}): Promise<AcpSessionConfiguration> {
  const defaults = options.defaults;
  let advertised = options.session.configOptions ?? [];
  let modes = options.session.modes;
  const configuredEntries = Object.entries(defaults.configOptions);
  for (const [configId, value] of configuredEntries) {
    const config = advertised.find((candidate) => candidate.id === configId);
    if (!config) {
      throw new Error(
        `ACP agent '${options.agentId}' did not advertise configured option '${configId}'.`
      );
    }
    if (config.type === "boolean") {
      if (typeof value !== "boolean") {
        throw new Error(`ACP option '${configId}' requires a boolean value.`);
      }
      const response = await options.connection.setSessionConfigOption(
        { sessionId: options.session.sessionId, configId, type: "boolean", value },
        options.operation
      );
      advertised = response.configOptions;
      continue;
    }
    if (typeof value !== "string") {
      throw new Error(`ACP option '${configId}' requires a selected value id.`);
    }
    const available = config.options.flatMap((candidate) =>
      "group" in candidate ? candidate.options : [candidate]
    );
    if (!available.some((candidate) => candidate.value === value)) {
      throw new Error(`ACP option '${configId}' did not advertise configured value '${value}'.`);
    }
    const response = await options.connection.setSessionConfigOption(
      { sessionId: options.session.sessionId, configId, value },
      options.operation
    );
    advertised = response.configOptions;
  }

  const configuredProtocolMode = advertised.some(
    (option) => option.category === "mode" && Object.hasOwn(defaults.configOptions, option.id)
  );
  if (defaults.modeId && !configuredProtocolMode) {
    if (!modes?.availableModes.some((mode) => mode.id === defaults.modeId)) {
      throw new Error(
        `ACP agent '${options.agentId}' did not advertise configured session mode '${defaults.modeId}'.`
      );
    }
    await options.connection.setSessionMode(
      { sessionId: options.session.sessionId, modeId: defaults.modeId },
      options.operation
    );
    modes = { ...modes, currentModeId: defaults.modeId };
  }
  return sessionConfigurationFromProtocol({ modes, configOptions: advertised });
}

export class AcpSessionController {
  constructor(
    private readonly registry: ActiveAgentRunRegistry = activeAgentRunRegistry,
    private readonly connect: ConnectionFactory = createAcpConnection,
    private readonly eventReadModels: AcpEventReadModelRegistry = acpEventReadModels
  ) {}

  async execute(
    run: AcpSessionRun,
    options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      interactionBroker?: RunnerInteractionBroker;
      sessionDefaults?: DesktopAcpSessionDefaults;
      onMetadataPersisted?: () => void | Promise<void>;
    }
  ): Promise<ExecutorAdapterResult> {
    await mkdir(run.runDir, { recursive: true });
    const heartbeatPath = join(run.runDir, "heartbeat.json");
    const startedAt = new Date().toISOString();
    const ownerLeaseId = randomUUID();
    const ownerGeneration = 1;
    let output = "";
    let connection: AcpConnection | null = null;
    let initializedCapabilities: AgentCapabilities | undefined;
    let handle: ActiveAgentRunHandle | null = null;
    let handleRegistered = false;
    let cleanupAttempted = false;
    let cleanupCompleted = false;
    let validatedArtifactReference: Awaited<ReturnType<typeof materializeFinalArtifact>> | null =
      null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
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
            })
          })
        : null;
    const eventStore = eventModel?.store ?? null;
    if (eventStore)
      await eventStore.append({ kind: "lifecycle", state: "created", message: "ACP run created." });
    let interactionOrdinal = 0;
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
      metadata: {
        runId: run.identity.executorRunId,
        ref: run.identity.claimRef,
        taskId: run.taskId,
        executor: run.executorName,
        agentId: run.agentId,
        runnerKind: "acp",
        ...run.identity,
        ...run.metadataIdentity
      }
    });
    const relayAbort = (): void => abortController.abort(options?.signal?.reason);
    options?.signal?.addEventListener("abort", relayAbort, { once: true });
    const writeState = async (
      status: "running" | TerminalStatus,
      patch: Record<string, unknown> = {}
    ): Promise<void> => {
      await ownerState.update(status, patch);
    };
    await writeState("running", {
      sessionId: null,
      capabilities: null,
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
    try {
      if (abortController.signal.aborted) {
        throw new ExecutorCancelledError(diagnostic(abortController.signal.reason));
      }
      const eventSink = async (notification: SessionNotification): Promise<void> => {
        const text = updateText(notification);
        if (text !== null) output += text;
        const normalized = normalizeAcpSessionNotification(notification);
        if (eventStore && normalized) {
          await eventStore.append(
            normalized,
            acpCorrelationSchema.parse({ sessionId: notification.sessionId })
          );
        }
      };
      const spawnEnvironment = environment();
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
      connection = this.connect({
        launch: { trusted: true, ...run.launch },
        cwd: run.cwd,
        env: spawnEnvironment,
        clientInfo: { name: "planweave", version: "1" },
        ...(options?.interactionBroker
          ? {
              clientCapabilities: { elicitation: { form: {} } }
            }
          : {}),
        defaultTimeoutMs: options?.timeoutMs,
        onSessionUpdate: eventSink,
        onPermissionRequest: async (request) => {
          const requestId = createAcpInteractionRequestId("permission", ++interactionOrdinal);
          const requestedAt = new Date().toISOString();
          return permissionHandler(request, requestId, requestedAt);
        },
        onElicitationRequest: async (request) => {
          const requestId = createAcpInteractionRequestId("elicitation", ++interactionOrdinal);
          const requestedAt = new Date().toISOString();
          const sessionId =
            "sessionId" in request && typeof request.sessionId === "string"
              ? request.sessionId
              : null;
          if (eventStore)
            await eventStore.append(
              normalizeAcpElicitationHistory(request, requestId, requestedAt),
              sessionId ? acpCorrelationSchema.parse({ sessionId }) : undefined
            );
          if (!options?.interactionBroker || !CreateElicitationRequestGuard.isForm(request)) {
            if (eventStore)
              await eventStore.append(
                {
                  kind: "interaction_result",
                  requestId,
                  interactionId: requestId,
                  interactionKind: "elicitation",
                  outcome: "cancelled",
                  message: options?.interactionBroker
                    ? "Unsupported elicitation was cancelled."
                    : "Elicitation was cancelled by the headless default-safe policy."
                },
                sessionId ? acpCorrelationSchema.parse({ sessionId }) : undefined
              );
            return { action: "cancel" };
          }
          return new Promise<CreateElicitationResponse>((resolve, reject) => {
            const complete = (response: CreateElicitationResponse): void => {
              releasePendingRequest(requestId);
              resolve(response);
            };
            let settlement: ReturnType<typeof createAcpElicitationSettlement>;
            try {
              settlement = createAcpElicitationSettlement({
                requestId,
                requestedSchema: request.requestedSchema,
                complete,
                publishResult: async (result) => {
                  if (eventStore)
                    await eventStore.append(
                      {
                        kind: "interaction_result",
                        requestId,
                        interactionId: requestId,
                        interactionKind: "elicitation",
                        outcome: result.outcome,
                        message: result.message
                      },
                      sessionId ? acpCorrelationSchema.parse({ sessionId }) : undefined
                    );
                }
              });
            } catch (error) {
              throw RequestError.invalidParams(undefined, diagnostic(error));
            }
            const pending: LivePendingRequestHandle = {
              requestId,
              interactionId: requestId,
              kind: "elicitation",
              requestedAt,
              summary: JSON.stringify(redactRunnerEventPayload(request)),
              respond: settlement.respond,
              reject: settlement.cancel,
              elicitationSchema: z.json().parse(redactRunnerEventPayload(request.requestedSchema))
            };
            pendingRequests.set(requestId, pending);
            if (handle?.lifecycleState === "running")
              this.registry.transition(handle, "waiting_interaction");
            if (handle) this.registry.notifyInteractionChanged(handle);
            Promise.resolve(options.interactionBroker?.requestAvailable(pending)).catch((error) => {
              releasePendingRequest(requestId);
              reject(error);
            });
          });
        },
        ...(terminalOutputHandler
          ? {
              onTerminalOutput: async (request: TerminalOutputRequest) => {
                const response = await terminalOutputHandler(request);
                if (eventStore)
                  await eventStore.append(
                    normalizeAcpTerminalOutput(request, response),
                    acpCorrelationSchema.parse({ sessionId: request.sessionId })
                  );
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
      });
      if (abortController.signal.aborted) {
        await connection.dispose();
        throw new ExecutorCancelledError(diagnostic(abortController.signal.reason));
      }
      const ownership = createLiveOwnership(
        `${run.identity.scope}:${run.identity.executorRunId}`,
        1
      );
      handle = {
        identity: { ...run.identity },
        connection,
        abortController,
        eventSink,
        ownership,
        lifecycleState: "initializing",
        control: {
          ownership,
          process: {
            pid: connection.processId,
            terminate: async () => connection?.dispose()
          },
          connection: {
            send: async () => {
              throw new Error("ACP raw sends are not available outside the protocol connection.");
            },
            close: async () => connection?.dispose(),
            cancelSession: async (sessionId) => connection?.cancel({ sessionId }),
            closeSession: async (sessionId) => {
              await connection?.closeSession(sessionId);
            },
            get supportsSessionClose() {
              return initializedCapabilities?.sessionCapabilities?.close != null;
            }
          },
          sessionId: null,
          interventionCapabilities: {
            cancel: false,
            permission: false,
            elicitationPreview: false
          },
          pendingRequests,
          pendingOperations: connection.pendingOperations
        }
      };
      this.registry.register(handle);
      handleRegistered = true;
      if (eventStore)
        await eventStore.append({
          kind: "lifecycle",
          state: "initializing",
          message: "ACP connection initialized."
        });
      await writeState("running", { pid: connection.processId });
      const initialized = await connection.initialize({
        signal: abortController.signal,
        timeoutMs: options?.timeoutMs
      });
      initializedCapabilities = initialized.agentCapabilities;
      const authenticationOutcome = await coordinateAcpAuthentication({
        connection,
        initialized,
        hints: run.authenticationHints,
        availableEnvironmentVariables: new Set(Object.keys(spawnEnvironment)),
        operationOptions: { signal: abortController.signal, timeoutMs: options?.timeoutMs }
      });
      if (authenticationOutcome.kind === "auth_required") {
        if (eventStore)
          await eventStore.append({
            kind: "lifecycle",
            state: "initializing",
            message: "ACP authentication requires user action."
          });
        throw new AcpAuthenticationRequiredError(authenticationOutcome);
      }
      if (eventStore) {
        if (authenticationOutcome.kind === "authenticated") {
          await eventStore.append({
            kind: "lifecycle",
            state: "initializing",
            message: diagnostic(
              `ACP authentication method selected: ${authenticationOutcome.methodId}`
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
      handle.control.interventionCapabilities.cancel = true;
      handle.control.interventionCapabilities.permission = eventStore !== null;
      handle.control.interventionCapabilities.elicitationPreview =
        options?.interactionBroker != null;
      this.registry.transition(handle, "ready");
      if (eventStore)
        await eventStore.append({
          kind: "lifecycle",
          state: "ready",
          message: "ACP runner is ready."
        });
      const session = await connection.newSession(
        { cwd: run.cwd, mcpServers: [] },
        { signal: abortController.signal, timeoutMs: options?.timeoutMs }
      );
      const sessionCorrelation = acpCorrelationSchema.parse({ sessionId: session.sessionId });
      if (eventStore) {
        await eventStore.append(
          {
            kind: "session_configuration_snapshot",
            phase: "initial",
            configuration: sessionConfigurationFromNewSession(session)
          },
          sessionCorrelation
        );
      }
      if (options?.sessionDefaults) {
        const configuredSession = await applyDesktopAcpSessionDefaults({
          agentId: run.agentId,
          defaults: options.sessionDefaults,
          connection,
          session,
          operation: { signal: abortController.signal, timeoutMs: options.timeoutMs }
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
      this.registry.bindSession(handle, session.sessionId);
      this.registry.transition(handle, "running");
      if (eventStore)
        await eventStore.append(
          { kind: "lifecycle", state: "running", message: "ACP session is running." },
          sessionCorrelation
        );
      await writeState("running", {
        sessionId: session.sessionId,
        agentSessionId: session.sessionId,
        capabilities: initialized.agentCapabilities ?? {}
      });
      const expected = expectedArtifact(run);
      const agentPrompt = `${run.prompt}\n\n${finalArtifactPromptInstruction(expected)}`;
      const activeConnection = connection;
      operationDeadline = new Date(
        Date.now() + (options?.timeoutMs ?? DEFAULT_ACP_OPERATION_TIMEOUT_MS)
      );
      const response = await activeConnection.prompt(
        { sessionId: session.sessionId, prompt: [{ type: "text", text: agentPrompt }] },
        { signal: abortController.signal, timeoutMs: options?.timeoutMs }
      );
      operationDeadline = null;
      if (interactionFailure) throw interactionFailure;
      if (response.stopReason === "cancelled" || abortController.signal.aborted) {
        throw new ExecutorCancelledError(
          response.stopReason === "cancelled"
            ? "ACP agent cancelled the session."
            : diagnostic(abortController.signal.reason)
        );
      }
      await this.registry.drainPromptQueue(handle, async (text) => {
        if (eventStore) {
          await eventStore.append(
            {
              kind: "message",
              role: "user",
              messageId: `desktop-live-turn-${randomUUID()}`,
              chunk: false,
              ...normalizedRedactedContent(text)
            },
            acpCorrelationSchema.parse({ sessionId: session.sessionId })
          );
        }
        operationDeadline = new Date(
          Date.now() + (options?.timeoutMs ?? DEFAULT_ACP_OPERATION_TIMEOUT_MS)
        );
        const followUp = await activeConnection.prompt(
          { sessionId: session.sessionId, prompt: [{ type: "text", text }] },
          { signal: abortController.signal, timeoutMs: options?.timeoutMs }
        );
        operationDeadline = null;
        if (interactionFailure) throw interactionFailure;
        if (followUp.stopReason === "cancelled" || abortController.signal.aborted) {
          throw new ExecutorCancelledError(
            followUp.stopReason === "cancelled"
              ? "ACP agent cancelled the queued conversation turn."
              : diagnostic(abortController.signal.reason)
          );
        }
      });
      if (eventStore) await eventStore.drain();
      if (protocolObserverError !== undefined) throw protocolObserverError;
      const artifactRelative = finalArtifactRelativePath(run.kind);
      const artifactPath = join(run.runDir, artifactRelative);
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
      cleanupAttempted = true;
      await this.registry.remove(
        handle,
        "ACP claim completed and released live ownership.",
        "succeeded",
        true
      );
      cleanupCompleted = true;
      if (eventStore) await eventStore.drain();
      if (protocolObserverError !== undefined) throw protocolObserverError;
      if (eventStore)
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
              artifactValidated: true
            }
          },
          acpCorrelationSchema.parse({ sessionId: session.sessionId })
        );
      if (eventStore) await eventStore.drain();
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      const finishedAt = new Date().toISOString();
      await writeState("completed", {
        sessionId: session.sessionId,
        exitCode: 0,
        artifactReference
      });
      const common = {
        runId: run.identity.executorRunId,
        executor: run.executorName,
        agentId: run.agentId,
        runnerKind: "acp" as const,
        stdout: output,
        stderr: connection.stderr.join(""),
        exitCode: 0,
        startedAt,
        finishedAt,
        agentSessionId: session.sessionId
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
      if (error instanceof AcpOperationTimeoutError && handle) {
        handle.control.sessionId = null;
      }
      let cleanupError: unknown;
      if (!cleanupAttempted) {
        cleanupAttempted = true;
        try {
          if (handle && handleRegistered) {
            await this.registry.remove(
              handle,
              "ACP claim failed and released live ownership.",
              cancelledBeforeCleanup ? "cancelled" : "failed"
            );
            cleanupCompleted = true;
          } else if (connection) {
            await connection.dispose();
            cleanupCompleted = true;
          } else {
            cleanupCompleted = true;
          }
        } catch (caught) {
          cleanupError = caught;
        }
      }
      const executionMessage =
        cleanupAttempted && validatedArtifactReference
          ? "Execution succeeded and artifact was validated."
          : diagnostic(error);
      const cleanupMessage = validatedArtifactReference
        ? diagnostic(error)
        : cleanupError === undefined
          ? null
          : diagnostic(cleanupError);
      const message = cleanupMessage
        ? `Execution: ${executionMessage}; cleanup: ${cleanupMessage}`
        : executionMessage;
      const timedOut = error instanceof AcpOperationTimeoutError;
      const cancelled = cancelledBeforeCleanup || handle?.lifecycleState === "cancelled";
      const cleanupFailed = cleanupError !== undefined || (cleanupAttempted && !cleanupCompleted);
      const status: TerminalStatus = timedOut ? "timed_out" : cancelled ? "cancelled" : "failed";
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
              artifactValidated: validatedArtifactReference !== null
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
        exitCode: cancelled ? 130 : 1,
        ...(validatedArtifactReference
          ? { artifactReference: validatedArtifactReference, executionOutcome: "succeeded" }
          : {})
      });
      const finalizationErrors: unknown[] = [];
      if (cleanupError !== undefined && cleanupError !== error) {
        finalizationErrors.push(cleanupError);
      }
      finalizationErrors.push(...eventLogErrors.filter((caught) => caught !== error));
      if (finalizationErrors.length > 0) {
        throw new AggregateError([error, ...finalizationErrors], message);
      }
      if (cancelled && !(error instanceof ExecutorCancelledError)) {
        throw new ExecutorCancelledError(message);
      }
      throw error;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      options?.signal?.removeEventListener("abort", relayAbort);
    }
  }
}
