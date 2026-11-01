import { AgentHostOutboxDataError, AgentHostOutboxDrain } from "./agentHostOutboxDrain.js";
import { HostConnectionWatchdog } from "./hostConnectionWatchdog.js";
import { assertHostOutboundControlBudget } from "./hostOutboundControlBudget.js";
import { classifyRemoteRunnerHttpFailure } from "./remoteRunnerHttpFailure.js";
import { WebSocket } from "ws";
import {
  ACP_CONVERSATION_MIN_HOST_EVENT_PAYLOAD_BYTES,
  HOST_EVENT_PAYLOAD_BUDGET_VERSION_HEADER,
  HOST_EVENT_MAX_PAYLOAD_BYTES_HEADER,
  requireHostEventPayloadBudget,
  hostEventPayloadBytes,
  hostReadinessObservationSchema,
  CANVAS_RUNTIME_CAPABILITY,
  EXACT_PERMISSION_OPTIONS_VERSION_HEADER,
  HISTORICAL_PERMISSION_REPLAY_VERSION_HEADER,
  requireExactPermissionOptionsVersion,
  ACP_CONVERSATION_CAPABILITY,
  type HostReadinessObservation
} from "@planweave-ai/agent-host-protocol";
import {
  parseAgentHostCapabilities,
  parseAgentHostDispatchResult,
  parseAgentHostServerEvent,
  serializeAgentHostHello,
  type ServerEvent
} from "../protocol.js";
import { HttpArtifactClient } from "../artifacts/httpArtifactTransfer.js";
import {
  AgentHostSessionLoadError,
  type AgentHostExecutionContext
} from "../execution/agentHostExecutor.js";
import type { AgentHostExecution, AgentHostExecutionSettlement } from "../state/agentHostState.js";
import {
  type HostTransport,
  type HostTransportClock,
  type HostTransportLimits,
  type HostTransportStatus,
  type HostTransportStatusListener,
  parseHostTransportLimits,
  systemHostTransportClock
} from "./hostTransport.js";
import { ExecutionLeaseDeadline } from "./executionLeaseDeadline.js";
import { CalibratedServerClock } from "./calibratedServerClock.js";
import { parseReconnectBackoffOptions, reconnectDelay } from "./reconnectBackoff.js";

import {
  discoverRemoteRunnerEventProtocol,
  RemoteRunnerDiscoveryError
} from "./remoteRunnerDiscovery.js";
export { selectRemoteRunnerEventProtocolVersion } from "./remoteRunnerDiscovery.js";

export type { AgentHostClientOptions } from "./agentHostClientOptions.js";
import type { AgentHostClientOptions } from "./agentHostClientOptions.js";

type ActiveExecution = {
  execution: AgentHostExecution;
  controller: AbortController;
  sessionStart: AgentHostExecutionContext["sessionStart"];
  cleanupTimer?: unknown;
  cleanupFailed: boolean;
};

function endpoint(base: URL, path: string, websocket: boolean): URL {
  const result = new URL(base.origin);
  result.protocol = websocket ? (base.protocol === "https:" ? "wss:" : "ws:") : base.protocol;
  result.pathname = path;
  return result;
}

import { executionFailure, executionCleanupFailed } from "./agentHostExecutionOutcome.js";
import type { ReconnectBackoffOptions } from "./reconnectBackoff.js";

export class AgentHostClient implements HostTransport {
  private readonly readiness: HostReadinessObservation;
  private outboundMaxPayloadBytes: number;
  private readonly baseUrl: URL;
  private readonly capabilities: string[];
  private readonly artifacts: HttpArtifactClient;
  private token: string;
  private readonly active = new Map<number, ActiveExecution>();
  private readonly runs = new Set<Promise<void>>();
  private readonly canvasRuns = new Set<Promise<void>>();
  private socket?: WebSocket;
  private readonly clock: HostTransportClock;
  private readonly limits: HostTransportLimits;
  private readonly reconnect: ReconnectBackoffOptions;
  private readonly listeners = new Set<HostTransportStatusListener>();
  private readonly outbox: AgentHostOutboxDrain;
  private heartbeatTimer?: unknown;
  private connectionWatchdog?: HostConnectionWatchdog;
  private reconnectTimer?: unknown;
  private currentStatus: HostTransportStatus = { state: "stopped" };
  private reconnectAttempt = 0;
  private queuedMessages = 0;
  private processing = Promise.resolve();
  private welcomed = false;
  private compatibilityShutdown?: Promise<void>;
  private stopped = true;
  private startupAbort?: AbortController;
  private startup?: Promise<void>;
  private startupAttempt = 0;
  private stopping?: Promise<void>;
  private restartAfterStop = false;
  private lifecycleGeneration = 0;
  private recoveredGeneration = 0;
  private readonly serverClock: CalibratedServerClock;
  private readonly leaseDeadline: ExecutionLeaseDeadline;
  private leaseProtectionActive = false;
  private leaseProtectionFailed = false;
  private leasePersistenceFailed = false;
  private credentialRenewalInFlight?: Promise<void>;
  private credentialRenewalAbort?: AbortController;

  constructor(private readonly options: AgentHostClientOptions) {
    this.baseUrl = new URL(options.serverUrl);
    if (!["http:", "https:"].includes(this.baseUrl.protocol)) {
      throw new Error("agent_host_server_url_must_be_http");
    }
    if (this.baseUrl.protocol !== "https:" && !options.allowInsecureTransport) {
      throw new Error("agent_host_secure_transport_required");
    }
    if (!options.hostId || !options.token) throw new Error("agent_host_credentials_required");
    if (!Number.isInteger(options.capacity) || options.capacity < 1 || options.capacity > 128) {
      throw new Error("agent_host_capacity_out_of_range");
    }
    this.clock = options.clock ?? systemHostTransportClock;
    this.serverClock = options.serverClock ?? new CalibratedServerClock(this.clock);
    this.limits = parseHostTransportLimits(options.limits);
    this.outboundMaxPayloadBytes = this.limits.maxPayloadBytes;
    this.capabilities = parseAgentHostCapabilities(options.capabilities);
    this.readiness = hostReadinessObservationSchema.parse(options.readiness);
    if (
      this.capabilities.includes(ACP_CONVERSATION_CAPABILITY) &&
      this.limits.maxPayloadBytes < ACP_CONVERSATION_MIN_HOST_EVENT_PAYLOAD_BYTES
    )
      throw new Error("agent_host_conversation_payload_budget_too_small");
    assertHostOutboundControlBudget(
      this.limits.maxPayloadBytes,
      this.capabilities,
      options.capacity,
      this.readiness
    );
    options.state.setHostEventMaxPayloadBytes(this.limits.maxPayloadBytes);
    this.outbox = new AgentHostOutboxDrain(
      options.state,
      this.clock,
      this.limits,
      (error) => this.handleOutboxError(error),
      () => this.rejectPermissionCompatibility("historical_permission_replay_unsupported")
    );
    this.leaseDeadline = new ExecutionLeaseDeadline(this.clock, () => {
      this.checkExecutionLeases();
      this.outbox.request();
    });
    this.reconnect = parseReconnectBackoffOptions(options.reconnect);
    if (
      this.capabilities.includes(CANVAS_RUNTIME_CAPABILITY) &&
      (!options.canvasRuntime || !options.canvasRuntime.enabled())
    ) {
      throw new Error("canvas_runtime_capability_service_mismatch");
    }
    if (this.capabilities.includes(ACP_CONVERSATION_CAPABILITY) && !options.conversations)
      throw new Error("acp_conversation_capability_service_mismatch");
    this.token = options.token;
    this.artifacts = new HttpArtifactClient({
      baseUrl: this.baseUrl,
      hostId: this.options.hostId,
      getToken: () => {
        if (this.stopped) throw new Error("artifact_host_stopped");
        return this.token;
      },
      request: this.options.request
    });
  }

  start(): void {
    if (this.stopping) {
      this.restartAfterStop = true;
      return;
    }
    if (
      !this.stopped ||
      this.compatibilityShutdown ||
      this.runs.size > 0 ||
      this.active.size > 0 ||
      this.canvasRuns.size > 0
    )
      return;
    this.connectionWatchdog?.stop();
    const generation = ++this.lifecycleGeneration;
    this.stopped = false;
    this.outbox.start();
    this.leaseProtectionActive = true;
    this.leaseProtectionFailed = false;
    this.leasePersistenceFailed = false;
    const controller = new AbortController();
    this.startupAbort = controller;
    this.startupAttempt = 0;
    this.reconnectAttempt = 0;
    try {
      this.options.canvasRuntime?.start();
      this.options.state.recoverInterruptedExecutions();
    } catch (error) {
      this.failExecutionProtection("startup_local_state_failed");
      throw error;
    }
    if (!this.checkExecutionLeases()) return;
    this.beginDiscovery(generation, controller);
  }

  private isCurrentLifecycle(generation: number, controller: AbortController): boolean {
    return !controller.signal.aborted && !this.stopped && this.lifecycleGeneration === generation;
  }

  private beginDiscovery(generation: number, controller: AbortController): void {
    if (!this.isCurrentLifecycle(generation, controller)) return;
    const startup = this.discoverAndConnect(generation, controller)
      .catch(() => {
        if (this.isCurrentLifecycle(generation, controller)) {
          this.failExecutionProtection("startup_local_failure");
        }
      })
      .finally(() => {
        if (this.startup === startup) this.startup = undefined;
      });
    this.startup = startup;
  }

  private async discoverAndConnect(generation: number, controller: AbortController): Promise<void> {
    if (this.options.credentialRenewal) {
      const credential = await this.options.credentialRenewal.readActiveCredential();
      if (!this.isCurrentLifecycle(generation, controller)) return;
      if (credential.credentialToken !== this.token) {
        this.token = credential.credentialToken;
        this.options.canvasRuntime?.updateCredentialToken(this.token);
      }
    }
    let version: 2;
    try {
      version = await discoverRemoteRunnerEventProtocol({
        url: endpoint(this.baseUrl, "/version", false),
        request: this.options.request,
        signal: controller.signal,
        clock: this.clock
      });
    } catch (error) {
      if (!this.isCurrentLifecycle(generation, controller)) return;
      if (error instanceof RemoteRunnerDiscoveryError && error.kind === "retryable") {
        const attempt = ++this.startupAttempt;
        const delayMs = Math.min(
          30_000,
          Math.max(
            reconnectDelay(attempt, this.options.random ?? Math.random, this.reconnect),
            error.retryAfterMs ?? 0
          )
        );
        this.transition({
          state: "backing-off",
          attempt,
          delayMs,
          retryAt: new Date(this.clock.now().getTime() + delayMs).toISOString(),
          reason: error.code
        });
        if (!this.isCurrentLifecycle(generation, controller)) return;
        const timer = this.clock.setTimeout(() => {
          if (this.reconnectTimer !== timer) return;
          this.reconnectTimer = undefined;
          this.beginDiscovery(generation, controller);
        }, delayMs);
        this.reconnectTimer = timer;
        return;
      }
      this.stopped = true;
      this.transition({
        state:
          error instanceof RemoteRunnerDiscoveryError && error.kind === "auth"
            ? "auth-failed"
            : "degraded",
        reason: error instanceof RemoteRunnerDiscoveryError ? error.code : "startup_local_failure"
      });
      return;
    }
    if (!this.isCurrentLifecycle(generation, controller)) return;
    try {
      this.options.state.setRemoteRunnerEventProtocolVersion(version);
    } catch {
      this.failExecutionProtection("startup_local_state_failed");
      return;
    }
    if (!this.isCurrentLifecycle(generation, controller)) return;
    this.startupAttempt = 0;
    this.connect();
  }

  status(): HostTransportStatus {
    return this.currentStatus;
  }

  subscribe(listener: HostTransportStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.currentStatus);
    return () => this.listeners.delete(listener);
  }

  stop(): Promise<void> {
    this.restartAfterStop = false;
    if (this.stopping) return this.stopping;
    const stopping = this.stopChecked().then(
      () => {
        if (this.stopping === stopping) this.stopping = undefined;
        if (this.restartAfterStop) {
          this.restartAfterStop = false;
          this.start();
        }
      },
      (error: unknown) => {
        if (this.stopping === stopping) this.stopping = undefined;
        this.restartAfterStop = false;
        throw error;
      }
    );
    this.stopping = stopping;
    return stopping;
  }

  private async stopChecked(): Promise<void> {
    try {
      await this.stopTransport();
      if ([...this.active.values()].some((active) => active.cleanupFailed)) {
        throw new Error("agent_host_execution_cleanup_failed");
      }
    } catch (error) {
      this.failExecutionProtection("execution_cleanup_failed");
      throw error;
    }
  }

  private async stopTransport(): Promise<void> {
    this.outbox.stop();
    this.credentialRenewalAbort?.abort();
    const credentialRenewal = this.credentialRenewalInFlight;
    if (this.stopped && this.currentStatus.state === "stopped" && !this.startup) {
      if (credentialRenewal) await this.waitBounded(credentialRenewal);
      if (this.options.canvasRuntime) await this.waitBounded(this.options.canvasRuntime.stop());
      return;
    }
    this.connectionWatchdog?.stop();
    const generation = ++this.lifecycleGeneration;
    const reconciliationRequired = this.currentStatus.state === "reconciliation-required";
    this.stopped = true;
    const startup = this.startup;
    this.leaseProtectionActive = false;
    this.leaseDeadline.stop();
    this.startupAbort?.abort();
    this.startupAbort = undefined;
    this.welcomed = false;
    this.outbox.disconnect();
    if (this.reconnectTimer !== undefined) this.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.heartbeatTimer) this.clock.clearTimeout(this.heartbeatTimer);
    for (const { controller } of this.active.values()) controller.abort();
    this.options.canvasRuntime?.disconnect();
    if (credentialRenewal) await this.waitBounded(credentialRenewal);
    if (this.options.canvasRuntime) await this.waitBounded(this.options.canvasRuntime.stop());
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await this.waitBounded(
        new Promise<void>((resolve) => {
          socket.once("close", () => resolve());
          socket.close(1000, "host shutdown");
        })
      );
    }
    if (startup) await this.waitBounded(startup);
    await this.waitBounded(this.options.conversations?.stop() ?? Promise.resolve());
    await this.waitBounded(this.processing);
    await this.waitBounded(Promise.allSettled([...this.runs]).then(() => undefined));
    await this.waitBounded(Promise.allSettled([...this.canvasRuns]).then(() => undefined));
    this.compatibilityShutdown = undefined;
    if (
      !reconciliationRequired &&
      this.currentStatus.state !== "reconciliation-required" &&
      this.lifecycleGeneration === generation
    ) {
      this.transition({ state: "stopped" });
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const generation = this.lifecycleGeneration;
    this.transition({ state: "connecting", attempt: this.reconnectAttempt + 1 });
    if (this.stopped || this.lifecycleGeneration !== generation) return;
    const url = endpoint(
      this.baseUrl,
      `/agent-hosts/${encodeURIComponent(this.options.hostId)}/connect`,
      true
    );
    if (this.options.workspaceId !== undefined) {
      url.searchParams.set("workspaceId", this.options.workspaceId);
    }
    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        [HOST_EVENT_PAYLOAD_BUDGET_VERSION_HEADER]: "1",
        [EXACT_PERMISSION_OPTIONS_VERSION_HEADER]: "1",
        [HISTORICAL_PERMISSION_REPLAY_VERSION_HEADER]: "1"
      },
      handshakeTimeout: 30_000,
      maxPayload: this.limits.maxPayloadBytes,
      ca: this.options.ca
    });
    this.socket = socket;
    let upgradeFailure: { reason: string; retryAfterMs?: number } | undefined;
    const watchdog = new HostConnectionWatchdog(this.clock, () => {
      if (this.socket !== socket || this.stopped) return;
      this.options.logger?.log({
        level: "warn",
        event: "host_connection_timeout",
        state: this.currentStatus.state
      });
      socket.terminate();
    });
    this.connectionWatchdog = watchdog;
    let outboundBudgetError: Error | undefined;
    socket.on("upgrade", (response) => {
      if (this.socket !== socket || this.stopped) return;
      const header = response.headers[HOST_EVENT_MAX_PAYLOAD_BYTES_HEADER];
      try {
        const bytes = Math.min(this.limits.maxPayloadBytes, requireHostEventPayloadBudget(header));
        if (
          this.capabilities.includes(ACP_CONVERSATION_CAPABILITY) &&
          bytes < ACP_CONVERSATION_MIN_HOST_EVENT_PAYLOAD_BYTES
        )
          throw new Error("agent_host_conversation_payload_budget_too_small");
        assertHostOutboundControlBudget(
          bytes,
          this.capabilities,
          this.options.capacity,
          this.readiness
        );
        this.options.state.setHostEventMaxPayloadBytes(bytes);
        this.outbox.setMaxPayloadBytes(bytes);
        this.outboundMaxPayloadBytes = bytes;
      } catch (error) {
        outboundBudgetError =
          error instanceof Error
            ? error
            : new Error("agent_host_outbound_payload_budget_unsupported");
      }
    });
    socket.on("open", () => {
      if (this.socket !== socket || this.stopped) return;
      if (outboundBudgetError) {
        this.rejectPermissionCompatibility(outboundBudgetError.message);
        return;
      }
      watchdog.received();
      try {
        this.outbox.validatePending();
      } catch (error) {
        this.handleOutboxError(error);
        return;
      }
      const hello = serializeAgentHostHello({
        type: "host.hello",
        protocolVersion: 1,
        supportedExecutionEnvelopeVersions: [1, 2],
        lastAcknowledgedSequence: this.options.state.lastAcknowledgedSequence(),
        capabilities: this.capabilities,
        capacity: this.options.capacity,
        readiness: this.readiness
      });
      const helloBytes = hostEventPayloadBytes(hello, this.outboundMaxPayloadBytes);
      if (socket.bufferedAmount + helloBytes > this.limits.maxBufferedBytes) {
        this.rejectPermissionCompatibility("agent_host_outbound_buffer_capacity_exceeded");
        return;
      }
      socket.send(hello);
    });
    socket.on("message", (data, isBinary) => {
      if (this.socket !== socket || this.stopped) return;
      if (Buffer.byteLength(data.toString()) > this.limits.maxPayloadBytes) {
        this.transition({ state: "degraded", reason: "inbound_backpressure" });
        socket.close(4009, "inbound backpressure");
        return;
      }
      if (this.queuedMessages >= this.limits.maxQueuedMessages) {
        this.transition({ state: "degraded", reason: "inbound_backpressure" });
        void this.processing.finally(() => {
          if (this.socket === socket && socket.readyState === WebSocket.OPEN) {
            socket.close(4009, "inbound backpressure");
          }
        });
        return;
      }
      this.queuedMessages += 1;
      this.processing = this.processing
        .then(async () => {
          if (this.socket !== socket || this.stopped) return;
          if (isBinary) throw new Error("binary_messages_not_supported");
          const event = parseAgentHostServerEvent(JSON.parse(data.toString()));
          watchdog.received(event.type === "host.welcome" ? event.heartbeatIntervalMs : undefined);
          await this.handleServerEvent(event);
        })
        .catch((error: unknown) => {
          if (this.socket !== socket || this.stopped) return;
          const reason = error instanceof Error ? error.message : "";
          this.stopped = true;
          this.transition(
            reason === "mailbox_message_retention_horizon_exceeded"
              ? { state: "reconciliation-required", reason }
              : { state: "degraded", reason: "invalid_server_event" }
          );
          socket.close(4003, "server event rejected");
        })
        .finally(() => this.queuedMessages--);
    });
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      if (this.socket !== socket || this.stopped) return;
      const failure = classifyRemoteRunnerHttpFailure(
        response.statusCode ?? 0,
        response.headers["retry-after"]?.toString() ?? null,
        this.clock.now()
      );
      if (failure.kind === "auth") {
        this.stopped = true;
        this.transition({ state: "auth-failed", reason: "credential_rejected" });
      } else if (failure.kind === "protocol") {
        this.stopped = true;
        this.transition({ state: "degraded", reason: `upgrade_http_${response.statusCode ?? 0}` });
      } else {
        upgradeFailure = {
          reason: `upgrade_http_${response.statusCode}`,
          retryAfterMs: failure.retryAfterMs
        };
      }
      socket.terminate();
    });
    socket.on("error", () => socket.terminate());
    socket.on("close", (code) => {
      watchdog.stop();
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.welcomed = false;
      this.outbox.disconnect();
      this.options.canvasRuntime?.disconnect();
      if (this.heartbeatTimer) this.clock.clearTimeout(this.heartbeatTimer);
      if (!this.stopped && code === 4001) {
        this.stopped = true;
        this.transition({ state: "degraded", reason: "duplicate_host_connection" });
        return;
      }
      if (!this.stopped) {
        const attempt = ++this.reconnectAttempt;
        const delayMs = Math.min(
          30_000,
          Math.max(
            reconnectDelay(attempt, this.options.random ?? Math.random, this.reconnect),
            upgradeFailure?.retryAfterMs ?? 0
          )
        );
        const generation = this.lifecycleGeneration;
        this.transition({
          state: "backing-off",
          attempt,
          delayMs,
          retryAt: new Date(this.clock.now().getTime() + delayMs).toISOString(),
          ...(upgradeFailure ? { reason: upgradeFailure.reason } : {})
        });
        if (this.stopped || this.lifecycleGeneration !== generation) return;
        const timer = this.clock.setTimeout(() => {
          if (this.reconnectTimer !== timer) return;
          this.reconnectTimer = undefined;
          if (this.lifecycleGeneration === generation) this.connect();
        }, delayMs);
        this.reconnectTimer = timer;
      }
    });
  }

  private async handleServerEvent(event: ServerEvent): Promise<void> {
    if (!this.welcomed && event.type !== "host.welcome" && event.type !== "protocol.error") {
      throw new Error("agent_host_welcome_required");
    }
    switch (event.type) {
      case "host.welcome":
        try {
          requireExactPermissionOptionsVersion(event.exactPermissionOptionsVersion);
        } catch {
          this.rejectPermissionCompatibility();
          return;
        }
        if (
          !this.socket ||
          !this.outbox.welcome(this.socket, event.historicalPermissionReplayVersion === 1)
        )
          return;
        this.welcomed = true;
        this.reconnectAttempt = 0;
        this.transition({ state: "connected", connectedAt: this.clock.now().toISOString() });
        this.serverClock.synchronize(event.serverTime, this.clock.now());
        this.options.canvasRuntime?.synchronizeServerTime(event.serverTime, this.clock.now());
        if (this.recoveredGeneration !== this.lifecycleGeneration) {
          this.recoveredGeneration = this.lifecycleGeneration;
          void this.options.canvasRuntime?.recover().then(
            () => this.outbox.request(),
            () => this.failCanvasRuntimePersistence()
          );
          this.options.conversations?.recover();
        }
        this.checkExecutionLeases();
        this.startHeartbeat(event.heartbeatIntervalMs);
        this.checkCredentialRenewal();
        this.pump();
        return;
      case "mailbox.permission_history":
        if (!this.outbox.supportsHistoricalReplay())
          throw new Error("historical_permission_replay_unsupported");
        this.options.state.receive(event, this.serverClock.now());
        this.pump();
        return;
      case "mailbox.message":
        this.options.state.receive(event, this.serverClock.now());
        if (
          event.command.type === "acp_conversation.prompt" ||
          event.command.type === "acp_conversation.cancel" ||
          event.command.type === "acp_conversation.respond"
        ) {
          if (!this.options.conversations) throw new Error("acp_conversation_service_unavailable");
          this.options.conversations.handle(event.command);
        }
        if (
          event.command.type === "canvas_runtime.request" ||
          event.command.type === "canvas_runtime.cancel"
        ) {
          if (!this.options.canvasRuntime) throw new Error("canvas_runtime_service_unavailable");
          const run = this.options.canvasRuntime.handle(event.command);
          this.canvasRuns.add(run);
          const onSettled = () => {
            this.canvasRuns.delete(run);
            this.outbox.request();
          };
          void run.then(onSettled, () => {
            onSettled();
            this.failCanvasRuntimePersistence();
          });
        }
        {
          const cancelled = this.options.interactionRelay?.accept(event.command);
          if (cancelled) {
            for (const active of this.active.values()) {
              if (
                active.execution.command.dispatchId === cancelled.dispatchId &&
                active.execution.command.leaseId === cancelled.leaseId &&
                active.execution.command.executionAttemptId === cancelled.executionAttemptId
              ) {
                active.controller.abort();
              }
            }
          }
        }
        this.checkExecutionLeases();
        this.outbox.request();
        this.pump();
        return;
      case "host.event_ack":
        this.options.state.acknowledgeEvent(event.messageId);
        this.outbox.acknowledge(event.messageId);
        return;
      case "lease.renewed":
        this.options.state.renewLease(
          event.dispatchId,
          event.leaseId,
          event.executionAttemptId,
          event.leaseExpiresAt,
          this.serverNow()
        );
        this.checkExecutionLeases();
        return;
      case "protocol.error":
        this.options.onProtocolError?.(event);
        this.stopped = true;
        // Preserve Server code + public message so Desktop connection-status can surface them.
        this.transition({
          state: "degraded",
          reason: `${event.code}: ${event.message}`.slice(0, 256)
        });
        this.socket?.close(4003, event.code.slice(0, 123));
        return;
    }
  }

  private rejectPermissionCompatibility(reason = "exact_permission_options_unsupported"): void {
    this.stopped = true;
    this.lifecycleGeneration += 1;
    this.startupAbort?.abort();
    this.connectionWatchdog?.stop();
    this.credentialRenewalAbort?.abort();
    this.leaseProtectionActive = false;
    this.leaseDeadline.stop();
    this.welcomed = false;
    this.outbox.stop();
    if (this.heartbeatTimer) this.clock.clearTimeout(this.heartbeatTimer);
    if (this.reconnectTimer) this.clock.clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    this.socket = undefined;
    socket?.terminate();
    for (const { controller } of this.active.values()) controller.abort();
    this.options.canvasRuntime?.disconnect();
    this.transition({ state: "degraded", reason });
    const cleanup = this.waitBounded(
      Promise.all([
        this.credentialRenewalInFlight ?? Promise.resolve(),
        this.options.conversations?.stop() ?? Promise.resolve(),
        this.options.canvasRuntime?.stop() ?? Promise.resolve(),
        Promise.allSettled([...this.runs]),
        Promise.allSettled([...this.canvasRuns])
      ]).then(() => undefined)
    )
      .then(() => {
        if (this.compatibilityShutdown === cleanup) this.compatibilityShutdown = undefined;
      })
      .catch((error: unknown) => {
        this.options.logger?.log({
          level: "warn",
          event: "host_permission_compatibility_shutdown_failed",
          state: this.currentStatus.state,
          reason: error instanceof Error ? error.message : "host_shutdown_failed"
        });
      });
    this.compatibilityShutdown = cleanup;
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.stopped) return;
    if (this.heartbeatTimer) this.clock.clearTimeout(this.heartbeatTimer);
    const send = () => {
      if (this.stopped || !this.welcomed) return;
      if (!this.checkExecutionLeases()) return;
      try {
        this.options.state.queueHeartbeat(this.options.state.activeLeases(), this.readiness);
      } catch (error) {
        this.failExecutionProtection(
          error instanceof Error ? error.message : "heartbeat_persistence_failed"
        );
        return;
      }
      this.outbox.request();
      this.checkCredentialRenewal();
      this.heartbeatTimer = this.clock.setTimeout(send, intervalMs);
    };
    this.heartbeatTimer = this.clock.setTimeout(send, 0);
  }

  private pump(): void {
    if (!this.welcomed || this.stopped) return;
    if (!this.checkExecutionLeases()) return;
    for (const cancellation of this.options.state.pendingCancellations()) {
      const outcome = this.options.state.applyCancellation(cancellation.sequence);
      if (outcome.shouldAbort) {
        for (const active of this.active.values()) {
          if (
            active.execution.command.dispatchId === cancellation.command.dispatchId &&
            active.execution.command.leaseId === cancellation.command.leaseId &&
            active.execution.command.executionAttemptId === cancellation.command.executionAttemptId
          ) {
            active.controller.abort();
          }
        }
      }
    }
    this.outbox.request();

    // `capacity` is advertised for the Server's collaboration reservation policy.
    // Commands delivered here have already passed the authoritative scheduler, so
    // applying the static Host value again would serialize Owner Fleet operations
    // that the canvas runtime intentionally admitted concurrently.
    for (const pending of this.options.state.pendingResumptions(Number.MAX_SAFE_INTEGER)) {
      const sessionId = this.options.state.executionEvidence(pending.sequence)?.acpSessionId;
      if (this.sessionBusy(pending.sequence, sessionId)) continue;
      const resumption = this.options.state.startResumption(pending.sequence, this.serverNow());
      if (!resumption) continue;
      this.launch(resumption.execution, { kind: "load", sessionId: resumption.sessionId });
      if (this.leaseProtectionFailed) return;
    }
    for (const pending of this.options.state.pendingExecutions(Number.MAX_SAFE_INTEGER)) {
      if (this.sessionBusy(pending.sequence, pending.command.envelope.restoration?.sessionId))
        continue;
      const execution = this.options.state.startExecution(pending.sequence, this.serverNow());
      if (!execution) continue;
      const restoration = execution.command.envelope.restoration;
      this.launch(
        execution,
        restoration ? { kind: "load", sessionId: restoration.sessionId } : { kind: "new" }
      );
      if (this.leaseProtectionFailed) return;
    }
    this.checkExecutionLeases();
  }

  private sessionBusy(sequence: number, sessionId: string | undefined): boolean {
    if (this.active.has(sequence)) return true;
    if (!sessionId) return false;
    return [...this.active.values()].some((active) => {
      const activeSessionId =
        active.sessionStart.kind === "load"
          ? active.sessionStart.sessionId
          : this.options.state.executionEvidence(active.execution.sequence)?.acpSessionId;
      return activeSessionId === sessionId;
    });
  }

  private launch(
    execution: AgentHostExecution,
    sessionStart: AgentHostExecutionContext["sessionStart"]
  ): void {
    const controller = new AbortController();
    const active: ActiveExecution = { execution, controller, sessionStart, cleanupFailed: false };
    this.active.set(execution.sequence, active);
    controller.signal.addEventListener(
      "abort",
      () => {
        active.cleanupTimer = this.clock.setTimeout(() => {
          active.cleanupTimer = undefined;
          if (this.active.get(execution.sequence) !== active) return;
          this.failExecutionProtection("execution_cleanup_timeout");
        }, this.limits.shutdownTimeoutMs);
      },
      { once: true }
    );
    this.outbox.request();
    const run = this.run(active);
    this.runs.add(run);
    void run.then(
      () => this.runs.delete(run),
      () => {
        this.runs.delete(run);
        this.failExecutionProtection("execution_persistence_failed");
      }
    );
  }

  private serverNow(): Date {
    return this.serverClock.now();
  }

  private checkExecutionLeases(): boolean {
    if (!this.leaseProtectionActive || this.leasePersistenceFailed) return false;
    try {
      this.options.state.abandonExpiredExecutions(this.serverNow());
      const leased = this.options.state.activeLeases();
      for (const active of this.active.values()) {
        if (
          !leased.some(
            (identity) =>
              identity.dispatchId === active.execution.command.dispatchId &&
              identity.leaseId === active.execution.command.leaseId &&
              identity.executionAttemptId === active.execution.command.executionAttemptId
          )
        )
          active.controller.abort();
      }
      const next = this.options.state.nextLeaseExpiresAt();
      this.leaseDeadline.reschedule(
        next === undefined ? undefined : this.serverClock.localDeadlineMs(next)
      );
      return true;
    } catch {
      // A rolled-back expiry cannot authorize more execution; cancellation is still required.
      this.failExecutionProtection("execution_lease_persistence_failed");
      return false;
    }
  }

  private failExecutionProtection(reason: string): void {
    this.leaseProtectionFailed = true;
    this.stopped = true;
    if (
      reason === "execution_lease_persistence_failed" ||
      reason === "execution_persistence_failed"
    ) {
      this.leasePersistenceFailed = true;
      this.leaseDeadline.stop();
    }
    if (this.heartbeatTimer !== undefined) this.clock.clearTimeout(this.heartbeatTimer);
    if (this.reconnectTimer !== undefined) this.clock.clearTimeout(this.reconnectTimer);
    for (const active of this.active.values()) active.controller.abort();
    this.transition({ state: "reconciliation-required", reason });
    this.socket?.close(4003, reason);
  }

  private async run(active: ActiveExecution): Promise<void> {
    const { execution, controller, sessionStart } = active;
    try {
      let outcome:
        | { kind: "completed"; result: ReturnType<typeof parseAgentHostDispatchResult> }
        | { kind: "failed"; error: unknown };
      try {
        if (!this.checkExecutionLeases() || controller.signal.aborted) return;
        if (
          execution.command.envelope.restoration &&
          execution.command.envelope.restoration.hostId !== this.options.hostId
        )
          throw new Error("acp_restore_host_changed");
        if (
          execution.command.envelope.restoration &&
          this.options.conversations?.isSessionActive(
            execution.command.envelope.restoration.sessionId
          )
        )
          throw new Error("acp_conversation_turn_in_flight");
        outcome = {
          kind: "completed",
          result: parseAgentHostDispatchResult(
            await this.options.executor.execute(execution.command, {
              signal: controller.signal,
              executionKey: `${execution.command.dispatchId}:${execution.command.leaseId}:${execution.command.executionAttemptId}`,
              artifacts: this.artifacts.forExecution(
                execution.command,
                (evidence) =>
                  this.options.state.recordArtifactTransfer(
                    execution.sequence,
                    execution.command.leaseId,
                    evidence
                  ),
                controller.signal
              ),
              sessionStart
            })
          )
        };
      } catch (error) {
        outcome = { kind: "failed", error };
      }
      if (outcome.kind === "failed" && executionCleanupFailed(outcome.error)) {
        active.cleanupFailed = true;
        this.failExecutionProtection("execution_cleanup_failed");
        return;
      }
      if (!this.checkExecutionLeases() || this.stopped) return;
      let settlement: AgentHostExecutionSettlement;
      if (outcome.kind === "completed") {
        settlement = this.options.state.completeExecution(
          execution.sequence,
          execution.command,
          outcome.result,
          this.serverNow()
        );
      } else if (
        outcome.error instanceof AgentHostSessionLoadError &&
        !controller.signal.aborted &&
        !execution.command.envelope.restoration
      ) {
        settlement = this.options.state.failResumption(
          execution.sequence,
          execution.command,
          this.serverNow()
        );
      } else {
        settlement = this.options.state.failExecution(
          execution.sequence,
          execution.command,
          executionFailure(outcome.error, controller.signal.aborted),
          this.serverNow()
        );
      }
      if (settlement !== "applied") controller.abort();
    } catch {
      this.failExecutionProtection("execution_persistence_failed");
    } finally {
      if (active.cleanupTimer !== undefined) this.clock.clearTimeout(active.cleanupTimer);
      if (this.active.get(execution.sequence) === active && !active.cleanupFailed) {
        this.active.delete(execution.sequence);
      }
      this.checkExecutionLeases();
      this.outbox.request();
      this.pump();
    }
  }

  private handleOutboxError(error: unknown): void {
    if (error instanceof AgentHostOutboxDataError) {
      const stopping = this.stop();
      this.transition({ state: "reconciliation-required", reason: error.message });
      void stopping.catch(() => this.failExecutionProtection("outbox_shutdown_failed"));
    } else {
      this.transition({ state: "degraded", reason: "outbox_delivery_failed" });
      this.socket?.close(1011, "outbox delivery failed");
    }
    this.options.logger?.log({
      level: "warn",
      event: "host_outbox_delivery_failed",
      state: this.currentStatus.state,
      reason: error instanceof Error ? error.message : "outbox_delivery_failed"
    });
  }

  private transition(status: HostTransportStatus): void {
    if (this.stopped) this.outbox.stop();
    this.currentStatus = status;
    this.options.logger?.log({
      level:
        status.state === "degraded" ||
        status.state === "reconciliation-required" ||
        status.state === "auth-failed"
          ? "warn"
          : "debug",
      event: "host_transport_state",
      state: status.state,
      reason: "reason" in status ? status.reason : undefined
    });
    for (const listener of this.listeners) listener(status);
  }

  private checkCredentialRenewal(): void {
    const renewal = this.options.credentialRenewal;
    if (!renewal || this.stopped || this.credentialRenewalInFlight) return;
    const generation = this.lifecycleGeneration;
    const controller = new AbortController();
    this.credentialRenewalAbort = controller;
    const operation = renewal
      .poll(controller.signal)
      .then(async () => {
        if (this.stopped || generation !== this.lifecycleGeneration) return;
        const credential = await renewal.readActiveCredential();
        if (this.stopped || generation !== this.lifecycleGeneration) return;
        if (credential.credentialToken === this.token) return;
        this.token = credential.credentialToken;
        this.options.canvasRuntime?.updateCredentialToken(this.token);
        this.socket?.close(1000, "credential rotated");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          if (error instanceof Error && error.name === "AbortError") return;
          throw error;
        }
        this.options.logger?.log({
          level: "warn",
          event: "host_credential_renewal_failed",
          state: this.currentStatus.state,
          reason: "credential_renewal_failed"
        });
      })
      .finally(() => {
        if (this.credentialRenewalInFlight === operation) {
          this.credentialRenewalInFlight = undefined;
          if (this.credentialRenewalAbort === controller) this.credentialRenewalAbort = undefined;
          if (!this.stopped && generation !== this.lifecycleGeneration) {
            this.checkCredentialRenewal();
          }
        }
      });
    this.credentialRenewalInFlight = operation;
  }

  private failCanvasRuntimePersistence(): void {
    this.stopped = true;
    this.transition({
      state: "reconciliation-required",
      reason: "canvas_runtime_persistence_failed"
    });
    this.socket?.close(4003, "canvas runtime persistence failed");
  }

  private async waitBounded(operation: Promise<void>): Promise<void> {
    let timer: unknown;
    try {
      const timedOut = await Promise.race([
        operation.then(() => false),
        new Promise<true>((resolve) => {
          timer = this.clock.setTimeout(() => resolve(true), this.limits.shutdownTimeoutMs);
        })
      ]);
      if (timedOut) throw new Error("agent_host_transport_shutdown_timeout");
    } finally {
      if (timer !== undefined) this.clock.clearTimeout(timer);
    }
  }
}
