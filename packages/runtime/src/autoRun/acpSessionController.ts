import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentCapabilities,
  CreateElicitationResponse,
  RequestPermissionResponse,
  SessionNotification,
  TerminalOutputRequest,
  TerminalOutputResponse
} from "@agentclientprotocol/sdk";
import { writeJsonFile } from "../json.js";
import type { AgentFamily, ExecutorAdapterResult } from "../types.js";
import { createAcpConnection, type AcpConnection, type CreateAcpConnectionOptions } from "./acpConnection.js";
import { ExecutorCancelledError } from "./executorShared.js";
import {
  extractFinalArtifactEnvelope,
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
  normalizeAcpElicitationHistory,
  normalizeAcpPermissionHistory,
  normalizeAcpSessionNotification,
  normalizeAcpTerminalOutput
} from "./acpEventNormalization.js";
import { acpCorrelationSchema, runnerIdentitySchema, runnerRunIdentitySchema } from "./runnerContractSchemas.js";
import { acpEventReadModels, type AcpEventReadModelRegistry } from "./acpEventReadModel.js";

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
    let elicitationOrdinal = 0;
    let interactionOrdinal = 0;
    const pendingRequests = new Map<string, LivePendingRequestHandle>();
    const releasePendingRequest = (requestId: string): void => {
      pendingRequests.delete(requestId);
      if (pendingRequests.size === 0 && handle?.lifecycleState === "waiting_interaction") {
        this.registry.transition(handle, "running");
      }
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
        if (eventStore) await eventStore.append(
          normalizeAcpSessionNotification(notification),
          acpCorrelationSchema.parse({ sessionId: notification.sessionId })
        );
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
          if (eventStore) await eventStore.append(
            normalizeAcpPermissionHistory(request),
            acpCorrelationSchema.parse({ sessionId: request.sessionId })
          );
          if (!options?.interactionBroker) return { outcome: { outcome: "cancelled" } };
          const requestId = `permission-${++interactionOrdinal}`;
          return new Promise<RequestPermissionResponse>((resolve, reject) => {
            let settled = false;
            const finish = (response: { outcome: { outcome: "cancelled" } } | { outcome: { outcome: "selected"; optionId: string } }): void => {
              if (settled) throw new Error(`Live runner request '${requestId}' was already answered.`);
              settled = true;
              releasePendingRequest(requestId);
              resolve(response);
            };
            const pending: LivePendingRequestHandle = {
              requestId,
              interactionId: requestId,
              kind: "permission",
              requestedAt: new Date().toISOString(),
              summary: JSON.stringify(redactRunnerEventPayload(request.options)),
              respond: async (value: JsonRpcValue) => {
                if (typeof value !== "string" || !request.options.some((option) => option.optionId === value)) {
                  throw new Error(`Permission response for '${requestId}' must select an advertised option id.`);
                }
                finish({ outcome: { outcome: "selected", optionId: value } });
              },
              reject: async () => finish({ outcome: { outcome: "cancelled" } })
            };
            pendingRequests.set(requestId, pending);
            if (handle?.lifecycleState === "running") this.registry.transition(handle, "waiting_interaction");
            Promise.resolve(options.interactionBroker?.requestAvailable(pending)).catch((error) => {
              releasePendingRequest(requestId);
              reject(error);
            });
          });
        },
        onElicitationRequest: async (request) => {
          elicitationOrdinal += 1;
          const sessionId = "sessionId" in request && typeof request.sessionId === "string"
            ? request.sessionId
            : null;
          if (eventStore) await eventStore.append(
            normalizeAcpElicitationHistory(request, elicitationOrdinal),
            sessionId ? acpCorrelationSchema.parse({ sessionId }) : undefined
          );
          if (!options?.interactionBroker || request.mode !== "form") return { action: "cancel" };
          const requestId = `elicitation-${++interactionOrdinal}`;
          return new Promise<CreateElicitationResponse>((resolve, reject) => {
            let settled = false;
            const finish = (response: { action: string; [key: string]: unknown }): void => {
              if (settled) throw new Error(`Live runner request '${requestId}' was already answered.`);
              settled = true;
              releasePendingRequest(requestId);
              resolve(response);
            };
            const pending: LivePendingRequestHandle = {
              requestId,
              interactionId: requestId,
              kind: "elicitation",
              requestedAt: new Date().toISOString(),
              summary: JSON.stringify(redactRunnerEventPayload(request)),
              respond: async (value: JsonRpcValue) => {
                if (typeof value !== "object" || value === null || Array.isArray(value) || typeof value.action !== "string") {
                  throw new Error(`Elicitation response for '${requestId}' must contain an ACP action.`);
                }
                finish({ ...value, action: value.action });
              },
              reject: async () => finish({ action: "cancel" })
            };
            pendingRequests.set(requestId, pending);
            if (handle?.lifecycleState === "running") this.registry.transition(handle, "waiting_interaction");
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
      const response = await connection.prompt(
        { sessionId: session.sessionId, prompt: [{ type: "text", text: run.prompt }] },
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
      const expected = expectedArtifact(run);
      const envelope = extractFinalArtifactEnvelope(output, expected);
      const artifactReference = await materializeFinalArtifact({
        envelope,
        expected,
        rootDir: run.runDir,
        relativePath: artifactRelative
      });
      validatedArtifactReference = artifactReference;
      cleanupAttempted = true;
      await this.registry.remove(
        handle,
        "ACP claim completed and released live ownership.",
        "succeeded",
        true
      );
      if (eventStore) await eventStore.drain();
      if (protocolObserverError !== undefined) throw protocolObserverError;
      if (eventStore) await eventStore.append({
        kind: "terminal",
        outcome: { version: "planweave.runner/v1", state: "succeeded", exitCode: 0, finishedAt: new Date().toISOString(), diagnostic: null, artifactValidated: true }
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
          } else if (connection) {
            await connection.dispose();
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
      const timedOut = /timed out/i.test(message);
      const cancelled =
        cancelledBeforeCleanup ||
        handle?.lifecycleState === "cancelled";
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
