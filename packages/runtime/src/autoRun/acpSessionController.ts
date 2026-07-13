import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
  AgentCapabilities,
  CreateElicitationResponse,
  RequestPermissionResponse,
  SessionNotification,
  TerminalOutputRequest,
  TerminalOutputResponse
} from "@agentclientprotocol/sdk";
import {
  CreateElicitationRequest as CreateElicitationRequestGuard,
  RequestError
} from "@agentclientprotocol/sdk";
import { writeJsonFile } from "../json.js";
import type { AgentFamily, ExecutorAdapterResult } from "../types.js";
import {
  AcpOperationTimeoutError,
  createAcpConnection,
  type AcpConnection,
  type CreateAcpConnectionOptions
} from "./acpConnection.js";
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
import { redactRunnerEventPayload, redactRunnerEventText } from "./runnerEventRedaction.js";
import {
  createLiveOwnership,
  type JsonRpcValue,
  type LivePendingRequestHandle,
  type RunnerInteractionBroker
} from "./liveControl.js";
import {
  createAcpInteractionRequestId,
  normalizeAcpElicitationHistory,
  normalizeAcpPermissionHistory,
  normalizeAcpSessionNotification,
  normalizeAcpTerminalOutput
} from "./acpEventNormalization.js";
import { acpCorrelationSchema, runnerIdentitySchema, runnerRunIdentitySchema } from "./runnerContractSchemas.js";
import { acpEventReadModels, type AcpEventReadModelRegistry } from "./acpEventReadModel.js";
import { createAcpElicitationSettlement } from "./acpElicitationSettlement.js";
import { createAcpInteractionSettlement } from "./acpInteractionSettlement.js";

export type AcpSessionRunKind = "implementation" | "review" | "feedback";
export type AcpSessionRun = {
  kind: AcpSessionRunKind;
  identity: Omit<ActiveAgentRunIdentity, "sessionId">;
  runDir: string;
  metadataPath: string;
  prompt: string;
  cwd: string;
  launch: { command: string; args: readonly string[] };
  executorName: string;
  agentId: AgentFamily;
  taskId: string;
  metadataIdentity: Record<string, string>;
  projectId?: string;
  canvasId?: string;
  terminalOutputHandler?: (request: TerminalOutputRequest) => TerminalOutputResponse | Promise<TerminalOutputResponse>;
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

export class AcpSessionController {
  constructor(
    private readonly registry: ActiveAgentRunRegistry = activeAgentRunRegistry,
    private readonly connect: ConnectionFactory = createAcpConnection,
    private readonly eventReadModels: AcpEventReadModelRegistry = acpEventReadModels
  ) {}

  async execute(run: AcpSessionRun, options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    interactionBroker?: RunnerInteractionBroker;
  }): Promise<ExecutorAdapterResult> {
    await mkdir(run.runDir, { recursive: true });
    const heartbeatPath = join(run.runDir, "heartbeat.json");
    const startedAt = new Date().toISOString();
    let output = "";
    let connection: AcpConnection | null = null;
    let initializedCapabilities: AgentCapabilities | undefined;
    let handle: ActiveAgentRunHandle | null = null;
    let handleRegistered = false;
    let cleanupAttempted = false;
    let cleanupCompleted = false;
    let validatedArtifactReference: Awaited<ReturnType<typeof materializeFinalArtifact>> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const abortController = new AbortController();
    const persistedDetails: Record<string, unknown> = {};
    const blockId = run.metadataIdentity.blockId ?? run.identity.claimRef.split("#")[1];
    if (!blockId) throw new Error("ACP run is missing a block id for its event identity.");
    if ((run.projectId === undefined) !== (run.canvasId === undefined)) {
      throw new Error("ACP event identity requires both projectId and canvasId.");
    }
    const eventModel = run.projectId && run.canvasId ? await this.eventReadModels.create({
      runDir: run.runDir,
      identity: runnerRunIdentitySchema.parse({
        projectId: run.projectId, canvasId: run.canvasId, taskId: run.taskId, blockId,
        claimRef: run.identity.claimRef, runId: run.identity.executorRunId, runOwner: "executor",
        runSessionId: run.identity.runSessionId ?? null, desktopRunId: run.identity.desktopRunId ?? null,
        executorRunId: run.identity.executorRunId
      }),
      runner: runnerIdentitySchema.parse({ version: "planweave.runner/v1", runnerKind: "acp", agentId: run.agentId })
    }) : null;
    const eventStore = eventModel?.store ?? null;
    if (eventStore) await eventStore.append({ kind: "lifecycle", state: "created", message: "ACP run created." });
    let interactionOrdinal = 0;
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
    let stateWrite = Promise.resolve();
    const relayAbort = (): void => abortController.abort(options?.signal?.reason);
    options?.signal?.addEventListener("abort", relayAbort, { once: true });
    const writeState = async (status: "running" | TerminalStatus, patch: Record<string, unknown> = {}): Promise<void> => {
      Object.assign(persistedDetails, patch);
      const now = new Date().toISOString();
      const details = { ...persistedDetails };
      stateWrite = stateWrite.then(async () => Promise.all([
        writeJsonFile(heartbeatPath, {
          status,
          pid: null,
          startedAt,
          lastHeartbeatAt: now,
          finishedAt: status === "running" ? null : now,
          ...details
        }),
        writeJsonFile(run.metadataPath, {
          runId: run.identity.executorRunId,
          ref: run.identity.claimRef,
          taskId: run.taskId,
          executor: run.executorName,
          agentId: run.agentId,
          runnerKind: "acp",
          status,
          outcome: status === "completed" ? "succeeded" : status,
          startedAt,
          finishedAt: status === "running" ? null : now,
          ...run.identity,
          ...run.metadataIdentity,
          ...details
        })
      ]).then(() => undefined));
      await stateWrite;
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
    heartbeatTimer = setInterval(() => {
      void writeState("running");
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
      connection = this.connect({
        launch: { trusted: true, ...run.launch },
        cwd: run.cwd,
        env: environment(),
        clientInfo: { name: "planweave", version: "1" },
        ...(options?.interactionBroker ? {
          clientCapabilities: { elicitation: { form: {} } }
        } : {}),
        defaultTimeoutMs: options?.timeoutMs,
        onSessionUpdate: eventSink,
        onPermissionRequest: async (request) => {
          const requestId = createAcpInteractionRequestId(
            "permission",
            ++interactionOrdinal
          );
          const requestedAt = new Date().toISOString();
          if (eventStore) await eventStore.append(
            normalizeAcpPermissionHistory(request, requestId, requestedAt),
            acpCorrelationSchema.parse({ sessionId: request.sessionId })
          );
          if (!options?.interactionBroker) {
            if (eventStore) await eventStore.append({
              kind: "interaction_result",
              requestId,
              interactionId: requestId,
              interactionKind: "permission",
              outcome: "cancelled",
              message: "Permission request was cancelled by the headless default-deny policy."
            }, acpCorrelationSchema.parse({ sessionId: request.sessionId }));
            return { outcome: { outcome: "cancelled" } };
          }
          return new Promise<RequestPermissionResponse>((resolve, reject) => {
            const finish = (response: RequestPermissionResponse): void => {
              releasePendingRequest(requestId);
              resolve(response);
            };
            type PermissionDecision =
              | { kind: "select"; optionId: string }
              | { kind: "cancel" };
            type PermissionResult = {
              outcome: "approved" | "denied" | "cancelled";
              message: string;
            };
            const settlement = createAcpInteractionSettlement<
              PermissionDecision,
              RequestPermissionResponse,
              PermissionResult
            >({
              requestId,
              normalize: (decision: PermissionDecision) => {
                if (decision.kind === "cancel") {
                  return {
                    response: { outcome: { outcome: "cancelled" as const } },
                    result: {
                      outcome: "cancelled" as const,
                      message: "Permission request was cancelled."
                    }
                  };
                }
                const option = request.options.find(
                  (candidate) => candidate.optionId === decision.optionId
                );
                if (!option) {
                  throw new Error(
                    `Permission option '${decision.optionId}' is not advertised.`
                  );
                }
                const denied = option.kind.startsWith("reject");
                return {
                  response: {
                    outcome: {
                      outcome: "selected" as const,
                      optionId: decision.optionId
                    }
                  },
                  result: {
                    outcome: denied ? "denied" as const : "approved" as const,
                    message: denied
                      ? "Permission request was denied."
                      : "Permission request was approved."
                  }
                };
              },
              publishResult: async (result) => {
                if (eventStore) await eventStore.append({
                  kind: "interaction_result",
                  requestId,
                  interactionId: requestId,
                  interactionKind: "permission",
                  outcome: result.outcome,
                  message: result.message
                }, acpCorrelationSchema.parse({ sessionId: request.sessionId }));
              },
              complete: finish
            });
            const pending: LivePendingRequestHandle = {
              requestId,
              interactionId: requestId,
              kind: "permission",
              requestedAt,
              summary: JSON.stringify(redactRunnerEventPayload(request.options)),
              respond: async (value: JsonRpcValue) => {
                if (typeof value !== "string") {
                  throw new Error(`Permission response for '${requestId}' must select an advertised option id.`);
                }
                await settlement.settle({ kind: "select", optionId: value });
              },
              reject: async () => {
                await settlement.settle({ kind: "cancel" });
              },
              permissionOptions: request.options.map((option) => ({
                optionId: option.optionId,
                label: redactRunnerEventText(option.name).text,
                decision: option.kind.startsWith("reject") ? "deny" as const : "approve" as const
              }))
            };
            pendingRequests.set(requestId, pending);
            if (handle?.lifecycleState === "running") this.registry.transition(handle, "waiting_interaction");
            if (handle) this.registry.notifyInteractionChanged(handle);
            Promise.resolve(options.interactionBroker?.requestAvailable(pending)).catch((error) => {
              releasePendingRequest(requestId);
              reject(error);
            });
          });
        },
        onElicitationRequest: async (request) => {
          const requestId = createAcpInteractionRequestId(
            "elicitation",
            ++interactionOrdinal
          );
          const requestedAt = new Date().toISOString();
          const sessionId = "sessionId" in request && typeof request.sessionId === "string"
            ? request.sessionId
            : null;
          if (eventStore) await eventStore.append(
            normalizeAcpElicitationHistory(request, requestId, requestedAt),
            sessionId ? acpCorrelationSchema.parse({ sessionId }) : undefined
          );
          if (!options?.interactionBroker || !CreateElicitationRequestGuard.isForm(request)) {
            if (eventStore) await eventStore.append({
              kind: "interaction_result",
              requestId,
              interactionId: requestId,
              interactionKind: "elicitation",
              outcome: "cancelled",
              message: options?.interactionBroker
                ? "Unsupported elicitation was cancelled."
                : "Elicitation was cancelled by the headless default-safe policy."
            }, sessionId ? acpCorrelationSchema.parse({ sessionId }) : undefined);
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
                  if (eventStore) await eventStore.append({
                    kind: "interaction_result",
                    requestId,
                    interactionId: requestId,
                    interactionKind: "elicitation",
                    outcome: result.outcome,
                    message: result.message
                  }, sessionId ? acpCorrelationSchema.parse({ sessionId }) : undefined);
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
              elicitationSchema: z.json().parse(
                redactRunnerEventPayload(request.requestedSchema)
              )
            };
            pendingRequests.set(requestId, pending);
            if (handle?.lifecycleState === "running") this.registry.transition(handle, "waiting_interaction");
            if (handle) this.registry.notifyInteractionChanged(handle);
            Promise.resolve(options.interactionBroker?.requestAvailable(pending)).catch((error) => {
              releasePendingRequest(requestId);
              reject(error);
            });
          });
        },
        ...(terminalOutputHandler ? {
          onTerminalOutput: async (request: TerminalOutputRequest) => {
            const response = await terminalOutputHandler(request);
            if (eventStore) await eventStore.append(
              normalizeAcpTerminalOutput(request, response),
              acpCorrelationSchema.parse({ sessionId: request.sessionId })
            );
            return response;
          }
        } : {}),
        ...(eventStore ? {
          observer: {
            redact: redactRunnerEventPayload,
            observe: (observation: { direction: string; payload: unknown }) => {
              void eventStore.appendProtocol(observation.direction, observation.payload).catch((error) => {
                protocolObserverError ??= error;
              });
            }
          }
        } : {})
      });
      if (abortController.signal.aborted) {
        await connection.dispose();
        throw new ExecutorCancelledError(diagnostic(abortController.signal.reason));
      }
      const ownership = createLiveOwnership(`${run.identity.scope}:${run.identity.executorRunId}`, 1);
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
            closeSession: async (sessionId) => { await connection?.closeSession(sessionId); },
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
      if (eventStore) await eventStore.append({ kind: "lifecycle", state: "initializing", message: "ACP connection initialized." });
      await writeState("running", { pid: connection.processId });
      const initialized = await connection.initialize({ signal: abortController.signal, timeoutMs: options?.timeoutMs });
      initializedCapabilities = initialized.agentCapabilities;
      handle.control.interventionCapabilities.cancel = true;
      handle.control.interventionCapabilities.permission = options?.interactionBroker != null;
      handle.control.interventionCapabilities.elicitationPreview =
        options?.interactionBroker != null;
      this.registry.transition(handle, "ready");
      if (eventStore) await eventStore.append({ kind: "lifecycle", state: "ready", message: "ACP runner is ready." });
      const session = await connection.newSession(
        { cwd: run.cwd, mcpServers: [] },
        { signal: abortController.signal, timeoutMs: options?.timeoutMs }
      );
      this.registry.bindSession(handle, session.sessionId);
      this.registry.transition(handle, "running");
      if (eventStore) await eventStore.append({ kind: "lifecycle", state: "running", message: "ACP session is running." }, acpCorrelationSchema.parse({ sessionId: session.sessionId }));
      await writeState("running", {
        sessionId: session.sessionId,
        agentSessionId: session.sessionId,
        capabilities: initialized.agentCapabilities ?? {}
      });
      const expected = expectedArtifact(run);
      const agentPrompt = `${run.prompt}\n\n${finalArtifactPromptInstruction(expected)}`;
      const response = await connection.prompt(
        { sessionId: session.sessionId, prompt: [{ type: "text", text: agentPrompt }] },
        { signal: abortController.signal, timeoutMs: options?.timeoutMs }
      );
      if (response.stopReason === "cancelled" || abortController.signal.aborted) {
        throw new ExecutorCancelledError(
          response.stopReason === "cancelled"
            ? "ACP agent cancelled the session."
            : diagnostic(abortController.signal.reason)
        );
      }
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
      if (eventStore) await eventStore.append({
        kind: "terminal",
        outcome: {
          version: "planweave.runner/v1", state: "succeeded", reason: "completed",
          cleanup: { status: "succeeded" }, exitCode: 0,
          finishedAt: new Date().toISOString(), diagnostic: null, artifactValidated: true
        }
      }, acpCorrelationSchema.parse({ sessionId: session.sessionId }));
      if (eventStore) await eventStore.drain();
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      const finishedAt = new Date().toISOString();
      await writeState("completed", { sessionId: session.sessionId, exitCode: 0, artifactReference });
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
      const executionMessage = cleanupAttempted && validatedArtifactReference
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
      const cancelled =
        cancelledBeforeCleanup ||
        handle?.lifecycleState === "cancelled";
      const cleanupFailed =
        cleanupError !== undefined ||
        (cleanupAttempted && !cleanupCompleted);
      const status: TerminalStatus = timedOut ? "timed_out" : cancelled ? "cancelled" : "failed";
      let eventLogError: unknown;
      try {
        if (eventStore && !cancelled) await eventStore.append({
          kind: "diagnostic", code: "protocol_error", message
        });
        if (eventStore) await eventStore.append({
          kind: "terminal",
          outcome: {
            version: "planweave.runner/v1", state: cancelled ? "cancelled" : "failed",
            reason: timedOut ? "timed_out" : cancelled ? "cancelled" : "failed",
            cleanup: { status: cleanupFailed ? "failed" : "succeeded" },
            exitCode: cancelled ? 130 : 1, finishedAt: new Date().toISOString(),
            diagnostic: message, artifactValidated: validatedArtifactReference !== null
          }
        });
        if (eventStore) await eventStore.drain();
      } catch (caught) {
        eventLogError = caught;
      }
      await writeState(status, {
        failureReason: message,
        timedOut,
        exitCode: cancelled ? 130 : 1,
        ...(validatedArtifactReference
          ? { artifactReference: validatedArtifactReference, executionOutcome: "succeeded" }
          : {})
      });
      if (cleanupError !== undefined) {
        throw new AggregateError([error, cleanupError], message);
      }
      if (eventLogError !== undefined && eventLogError !== error) {
        throw new AggregateError([error, eventLogError], message);
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
