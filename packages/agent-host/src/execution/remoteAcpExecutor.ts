import type { AcpConversationPromptCommand } from "@planweave-ai/agent-host-protocol";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  AcpEngineCapabilityError,
  DEFAULT_ACP_EXECUTION_LIMITS,
  executeAcp,
  normalizedRedactedContent,
  planWeaveAcpExecutionAuthentication,
  sessionConfigurationFromNewSession,
  sessionConfigurationFromProtocol,
  type AcpEngineEvent,
  type AcpEngineInteractionBroker,
  type AcpEngineLifecycleEvent,
  type AcpExecutionLimits,
  type AcpSharedPoolIdentity
} from "@planweave-ai/runtime";
import { parseAgentHostExecuteCommand } from "../protocol.js";
import {
  hasCanvasRuntimeExecutionCapability,
  hasLegacyWorkspaceCanvasExecutionCapability
} from "@planweave-ai/agent-host-protocol";
import {
  AgentHostExecutionError,
  AgentHostSessionLoadError,
  type AgentHostExecutionContext,
  type AgentHostExecutor
} from "./agentHostExecutor.js";
import type {
  AgentHostAcpProfileResolver,
  AgentHostRemoteExecutionIdentity,
  AgentHostRemoteExecutionOutbox,
  AgentHostRemoteInteractionResponder,
  AgentHostRuntimeWorkspaceResolver,
  AgentHostWorkspaceResolver,
  ResolvedAgentHostAcpProfile
} from "./remoteAcpPorts.js";
import { agentHostRemoteEngineEventSchema } from "./remoteAcpPorts.js";
import { agentHostPackageVersion } from "../packageInfo.js";
import { prepareInputArtifacts } from "./inputArtifactWorkspace.js";

type RemoteAcpExecutorOptions = {
  workspaceResolver: AgentHostWorkspaceResolver;
  runtimeWorkspaceResolver: AgentHostRuntimeWorkspaceResolver;
  profileResolver: AgentHostAcpProfileResolver;
  outbox: AgentHostRemoteExecutionOutbox;
  hostCapabilities: readonly string[];
  interactionResponder?: AgentHostRemoteInteractionResponder;
  limits?: Partial<AcpExecutionLimits>;
};

export const AGENT_HOST_RESUME_PROMPT =
  "Resume this interrupted PlanWeave execution in the loaded session. First inspect the existing session and workspace state. Do not assume an interrupted operation succeeded or failed, and do not repeat side effects without evidence. Complete only the remaining work you can establish. Prior pending permissions are invalid; request permission again when needed. Complete the required report.";

function failure(code: string, message: string, retryable = false): AgentHostExecutionError {
  return new AgentHostExecutionError({ code, message, retryable });
}

function engineFailure(reason: string, diagnostic?: string): AgentHostExecutionError {
  const code = `acp_${reason}`;
  const messages: Record<string, string> = {
    acp_authentication_required: "ACP authentication is required.",
    acp_capability_missing: "The ACP agent is missing a required capability.",
    acp_cleanup_failed: "ACP execution cleanup failed.",
    acp_event_sink_failed: "ACP event persistence failed.",
    acp_incomplete_response: "ACP execution ended without a complete response.",
    acp_interaction_failed: "ACP interaction handling failed.",
    acp_interaction_timeout: "ACP interaction handling timed out.",
    acp_limit_exceeded: "ACP execution exceeded a configured limit.",
    acp_operation_timeout: "ACP execution timed out.",
    acp_process_error: "The ACP process failed.",
    acp_protocol_error: "The ACP process violated the protocol.",
    acp_unknown_error: "ACP execution failed."
  };
  const base = messages[code] ?? "ACP execution failed.";
  const detail = diagnostic?.trim();
  // Keep the stable prefix so Desktop can match known codes, but retain the engine diagnostic.
  return failure(code, detail && detail !== base ? `${base} ${detail}` : base);
}

function identityOf(command: ReturnType<typeof parseAgentHostExecuteCommand>) {
  return {
    dispatchId: command.dispatchId,
    leaseId: command.leaseId,
    executionAttemptId: command.executionAttemptId
  } satisfies AgentHostRemoteExecutionIdentity;
}

function expectedExecutionKey(identity: AgentHostRemoteExecutionIdentity): string {
  return `${identity.dispatchId}:${identity.leaseId}:${identity.executionAttemptId}`;
}

function validateLocalCapabilities(
  required: readonly string[],
  available: ReadonlySet<string>
): void {
  const missing = required.filter((capability) => !available.has(capability));
  if (missing.length > 0) {
    throw failure(
      "host_capability_missing",
      `Agent Host is missing required capabilities: ${missing.join(", ")}.`
    );
  }
}

function sessionCapabilityError(): AcpEngineCapabilityError {
  return new AcpEngineCapabilityError(
    "Requested ACP session configuration is not supported by the resolved local profile and agent."
  );
}

function hostPoolIdentity(
  profile: ResolvedAgentHostAcpProfile,
  cwd: string
): AcpSharedPoolIdentity {
  return {
    projectRoot: cwd,
    profileFingerprint:
      profile.fingerprint ??
      createHash("sha256")
        .update(
          JSON.stringify({
            agentId: profile.agentId,
            launch: profile.launch,
            capabilities: profile.capabilityPolicy,
            shutdown: profile.shutdown,
            connection: profile.connection ?? { mode: "dedicated" }
          })
        )
        .digest("hex"),
    host: profile.host ?? { kind: "native" }
  };
}

function includesSelectValue(
  options: readonly ({ value: string } | { options: readonly { value: string }[] })[],
  value: string
): boolean {
  return options.some((option) =>
    "value" in option ? option.value === value : option.options.some((item) => item.value === value)
  );
}

async function configureSession(
  event: Extract<AcpEngineLifecycleEvent, { kind: "session_ready" }>,
  profile: ResolvedAgentHostAcpProfile,
  requested: ReturnType<typeof parseAgentHostExecuteCommand>["envelope"]["session"]
) {
  let modes = event.session.modes;
  let configOptions = event.session.configOptions;
  if (requested.modeId) {
    const modeId = profile.session?.modes?.[requested.modeId];
    if (!modeId || !event.session.modes?.availableModes.some((mode) => mode.id === modeId)) {
      throw sessionCapabilityError();
    }
    await event.configurator.setMode(modeId);
    modes = { ...event.session.modes, currentModeId: modeId };
  }
  for (const requestedOption of requested.configOptions ?? []) {
    const mapping = profile.session?.configOptions?.[requestedOption.optionId];
    const value = mapping?.values[requestedOption.valueId];
    const advertised = event.session.configOptions?.find(
      (option) => option.id === mapping?.configId
    );
    if (!mapping || value === undefined || !advertised) throw sessionCapabilityError();
    if (
      (advertised.type === "boolean" && typeof value !== "boolean") ||
      (advertised.type === "select" &&
        (typeof value !== "string" || !includesSelectValue(advertised.options, value)))
    ) {
      throw sessionCapabilityError();
    }
    configOptions = [
      ...(await event.configurator.setConfigOption({ configId: mapping.configId, value }))
    ];
  }
  return sessionConfigurationFromProtocol({ modes, configOptions });
}

function interactionBroker(options: {
  identity: AgentHostRemoteExecutionIdentity;
  outbox: AgentHostRemoteExecutionOutbox;
  responder?: AgentHostRemoteInteractionResponder;
}): AcpEngineInteractionBroker {
  return {
    advertiseElicitation: true,
    requestPermission: async (request, context) => {
      await options.outbox.append({
        kind: "permission_request",
        identity: options.identity,
        request: { ...request, options: [...request.options] },
        deadline: context.deadline.toISOString()
      });
      if (options.responder) {
        return options.responder.requestPermission(options.identity, request, context);
      }
      return new Promise<never>(() => undefined);
    },
    requestElicitation: async (request, context) => {
      await options.outbox.append({
        kind: "elicitation_request",
        identity: options.identity,
        request,
        deadline: context.deadline.toISOString()
      });
      if (options.responder) {
        return options.responder.requestElicitation(options.identity, request, context);
      }
      return new Promise<never>(() => undefined);
    }
  };
}

export class RemoteAcpExecutor implements AgentHostExecutor {
  private readonly hostCapabilities: ReadonlySet<string>;

  constructor(private readonly options: RemoteAcpExecutorOptions) {
    this.hostCapabilities = new Set(options.hostCapabilities);
  }

  private async resolveContext(
    envelope: ReturnType<typeof parseAgentHostExecuteCommand>["envelope"],
    sessionStartKind: "new" | "load"
  ) {
    validateLocalCapabilities(envelope.requiredCapabilities, this.hostCapabilities);
    let workspace: Awaited<ReturnType<AgentHostWorkspaceResolver["resolve"]>>;
    let profile: Awaited<ReturnType<AgentHostAcpProfileResolver["resolve"]>>;
    try {
      let workspaceResolution: ReturnType<AgentHostWorkspaceResolver["resolve"]>;
      const managedCanvasExecution = hasCanvasRuntimeExecutionCapability(
        envelope.requiredCapabilities
      );
      if (
        !managedCanvasExecution &&
        hasLegacyWorkspaceCanvasExecutionCapability(envelope.requiredCapabilities)
      ) {
        throw failure(
          "runtime_materialization_evidence_missing",
          "Legacy Workspace execution cannot resume without exact Runtime materialization evidence."
        );
      }
      if (!managedCanvasExecution) {
        workspaceResolution = this.options.workspaceResolver.resolve(
          envelope.workspaceId,
          envelope.ownerPackageLocator
        );
      } else {
        const runtimeMaterialization = envelope.runtimeMaterialization;
        if (runtimeMaterialization === undefined) {
          throw failure(
            "runtime_materialization_evidence_missing",
            "Workspace execution requires exact Runtime materialization evidence."
          );
        }
        workspaceResolution = this.options.runtimeWorkspaceResolver.resolve(
          {
            workspaceId: envelope.workspaceId,
            projectId: envelope.projectId,
            canvasId: envelope.canvasId
          },
          runtimeMaterialization
        );
      }
      [workspace, profile] = await Promise.all([
        workspaceResolution,
        this.options.profileResolver.resolve(envelope.agentProfileId, envelope.agentId)
      ]);
    } catch (error) {
      if (error instanceof AgentHostExecutionError) throw error;
      if (sessionStartKind === "load") throw new AgentHostSessionLoadError();
      if (
        hasCanvasRuntimeExecutionCapability(envelope.requiredCapabilities) &&
        error instanceof Error &&
        error.message === "runtime_materialization_evidence_mismatch"
      ) {
        throw failure(
          "runtime_materialization_evidence_mismatch",
          "The managed Runtime working set does not match the authorized execution source."
        );
      }
      throw failure(
        "host_resolution_failed",
        "The Agent Host could not resolve the requested workspace or ACP profile."
      );
    }
    if (!isAbsolute(workspace.cwd)) {
      if (sessionStartKind === "load") throw new AgentHostSessionLoadError();
      throw failure("workspace_invalid", "The resolved Agent Host workspace is invalid.");
    }
    if (profile.agentId !== envelope.agentId) {
      if (sessionStartKind === "load") throw new AgentHostSessionLoadError();
      throw failure("agent_profile_mismatch", "The resolved ACP profile does not match the agent.");
    }
    return { workspace, profile };
  }

  async converse(
    command: AcpConversationPromptCommand,
    interactionBroker: AcpEngineInteractionBroker,
    eventSink: (event: AcpEngineEvent) => Promise<void>,
    signal: AbortSignal
  ) {
    const { workspace, profile } = await this.resolveContext(command.sourceEnvelope, "load");
    let prompting = false;
    let configuration: ReturnType<typeof sessionConfigurationFromNewSession> | null = null;
    const result = await executeAcp({
      launch: { ...profile.launch, trusted: true },
      workspace,
      env: profile.env,
      capabilityPolicy: profile.capabilityPolicy,
      clientInfo: { name: "PlanWeave Agent Host", version: agentHostPackageVersion },
      shutdown: profile.shutdown,
      prompt: command.text,
      sessionStart: { kind: "load", sessionId: command.sessionId },
      authentication: planWeaveAcpExecutionAuthentication(profile.authentication),
      interactionBroker,
      interactionDeadline: () => new Date(command.expiresAt),
      lifecycleObserver: async (event) => {
        if (event.kind === "session_ready")
          configuration = sessionConfigurationFromNewSession(event.session);
        if (event.kind === "prompt_starting") {
          prompting = true;
          if (configuration)
            await eventSink({
              kind: "session_update",
              sessionId: command.sessionId,
              sequence: 1,
              timestamp: new Date().toISOString(),
              body: { kind: "session_configuration_snapshot", phase: "initial", configuration }
            });
          await eventSink({
            kind: "session_update",
            sessionId: command.sessionId,
            sequence: 1,
            timestamp: new Date().toISOString(),
            body: {
              kind: "message",
              role: "user",
              messageId: command.turnId,
              chunk: false,
              ...normalizedRedactedContent(command.text)
            }
          });
        }
      },
      eventSink: async (event) => {
        // session/load replays history; only this turn's notifications belong in its event stream.
        if (event.kind === "session_update" && !prompting) return;
        await eventSink(event);
      },
      signal,
      connectionMode: profile.connection?.mode ?? "dedicated",
      poolIdentity: hostPoolIdentity(profile, workspace.cwd),
      limits: {
        ...this.options.limits,
        operationTimeoutMs: Math.max(1, Date.parse(command.expiresAt) - Date.now())
      }
    });
    return result.terminal;
  }

  async execute(commandInput: unknown, context: AgentHostExecutionContext) {
    let command: ReturnType<typeof parseAgentHostExecuteCommand>;
    try {
      command = parseAgentHostExecuteCommand(commandInput);
    } catch {
      if (context.sessionStart.kind === "load") throw new AgentHostSessionLoadError();
      throw failure(
        "execution_envelope_invalid",
        "Execution command or envelope validation failed."
      );
    }
    const identity = identityOf(command);
    if (context.executionKey !== expectedExecutionKey(identity)) {
      throw failure("execution_attempt_mismatch", "Execution context does not match this attempt.");
    }
    if (!command.envelope.output.reportRequired) {
      throw failure(
        "report_contract_unsupported",
        "Remote ACP execution requires a report artifact contract."
      );
    }
    if (command.envelope.output.maxArtifactCount < 1) {
      throw failure("report_contract_invalid", "Report artifact allowance must be at least one.");
    }
    const { workspace, profile } = await this.resolveContext(
      command.envelope,
      context.sessionStart.kind
    );
    const preparedInputs =
      context.sessionStart.kind === "load" && !command.envelope.restoration
        ? {
            prompt: AGENT_HOST_RESUME_PROMPT,
            cleanup: async () => undefined
          }
        : await prepareInputArtifacts({
            cwd: workspace.cwd,
            prompt: command.envelope.renderedPrompt,
            inputs: command.envelope.inputArtifacts,
            artifacts: context.artifacts
          });

    let sessionConfigurationFailed = false;
    let sourceSequence = 0;
    const configurationEvents: Omit<
      Extract<AcpEngineEvent, { kind: "session_update" }>,
      "sequence"
    >[] = [];
    const persistEngineEvent = async (
      event: AcpEngineEvent | Omit<Extract<AcpEngineEvent, { kind: "session_update" }>, "sequence">
    ) => {
      await this.options.outbox.append({
        kind: "engine_event",
        identity,
        event: agentHostRemoteEngineEventSchema.parse({ ...event, sequence: ++sourceSequence })
      });
    };
    const interactionTimeoutMs =
      this.options.limits?.interactionTimeoutMs ??
      DEFAULT_ACP_EXECUTION_LIMITS.interactionTimeoutMs;
    let executionOutcome:
      | { status: "succeeded"; result: Awaited<ReturnType<typeof executeAcp>> }
      | { status: "failed"; error: unknown };
    let resumedSessionLoaded = false;
    let cleanupError: unknown;
    try {
      executionOutcome = {
        status: "succeeded",
        result: await executeAcp({
          launch: {
            command: profile.launch.command,
            args: profile.launch.args,
            trusted: true
          },
          workspace,
          env: profile.env,
          capabilityPolicy: profile.capabilityPolicy,
          clientInfo: { name: "PlanWeave Agent Host", version: agentHostPackageVersion },
          shutdown: profile.shutdown,
          prompt: preparedInputs.prompt,
          sessionStart: context.sessionStart,
          authentication: planWeaveAcpExecutionAuthentication(profile.authentication),
          interactionBroker: interactionBroker({
            identity,
            outbox: this.options.outbox,
            responder: this.options.interactionResponder
          }),
          interactionDeadline: () =>
            new Date(
              Math.min(Date.parse(command.leaseExpiresAt), Date.now() + interactionTimeoutMs)
            ),
          lifecycleObserver: async (event) => {
            if (event.kind !== "session_ready") return;
            try {
              const initial = sessionConfigurationFromNewSession(event.session);
              const configured = await configureSession(event, profile, command.envelope.session);
              for (const [phase, configuration] of [
                ["initial", initial],
                ["defaults_applied", configured]
              ] as const) {
                configurationEvents.push({
                  kind: "session_update",
                  sessionId: event.session.sessionId,
                  timestamp: new Date().toISOString(),
                  body: { kind: "session_configuration_snapshot", phase, configuration }
                });
              }
            } catch {
              sessionConfigurationFailed = true;
              throw sessionCapabilityError();
            }
          },
          eventSink: async (event) => {
            if (
              event.kind === "session_update" &&
              (event.body.kind === "artifact" || event.body.kind === "terminal")
            ) {
              return;
            }
            await persistEngineEvent(event);
            if (event.kind === "session_started") {
              for (const configurationEvent of configurationEvents.splice(0)) {
                await persistEngineEvent({ ...configurationEvent, timestamp: event.timestamp });
              }
            }
            if (
              context.sessionStart.kind === "load" &&
              event.kind === "session_started" &&
              event.loaded &&
              event.sessionId === context.sessionStart.sessionId
            ) {
              resumedSessionLoaded = true;
            }
          },
          signal: context.signal,
          connectionMode: profile.connection?.mode ?? "dedicated",
          poolIdentity: hostPoolIdentity(profile, workspace.cwd),
          limits: {
            ...this.options.limits,
            outputMaxBytes: Math.min(
              this.options.limits?.outputMaxBytes ?? DEFAULT_ACP_EXECUTION_LIMITS.outputMaxBytes,
              command.envelope.output.maxArtifactBytes
            )
          }
        })
      };
    } catch (error) {
      executionOutcome = {
        status: "failed",
        error:
          context.sessionStart.kind === "load" && !resumedSessionLoaded
            ? new AgentHostSessionLoadError()
            : error
      };
    }
    try {
      await preparedInputs.cleanup();
    } catch (error) {
      cleanupError = error;
    }
    if (executionOutcome.status === "failed") {
      if (cleanupError !== undefined) {
        throw new AggregateError(
          [executionOutcome.error, cleanupError],
          "remote_acp_execution_and_input_cleanup_failed",
          { cause: executionOutcome.error }
        );
      }
      throw executionOutcome.error;
    }
    if (cleanupError !== undefined) {
      throw failure(
        "workspace_input_cleanup_failed",
        "The Agent Host could not clean up dispatch input artifacts."
      );
    }
    const result = executionOutcome.result;

    if (result.terminal.state !== "succeeded") {
      if (context.sessionStart.kind === "load" && !resumedSessionLoaded) {
        throw new AgentHostSessionLoadError();
      }
      if (sessionConfigurationFailed) {
        throw failure(
          "acp_session_config_failed",
          "Requested ACP session configuration could not be applied."
        );
      }
      if (result.terminal.state === "cancelled") {
        throw failure("execution_cancelled", "The remote ACP execution was cancelled.");
      }
      throw engineFailure(
        result.terminal.reason,
        result.terminal.state === "failed" ? result.terminal.message : undefined
      );
    }
    if (result.output.trim().length === 0) {
      throw failure("report_output_missing", "ACP completed without report output.", true);
    }
    const bytes = Buffer.from(result.output, "utf8");
    if (bytes.byteLength > command.envelope.output.maxArtifactBytes) {
      throw failure("report_output_too_large", "ACP report output exceeds its artifact contract.");
    }
    const reportArtifactRef = await context.artifacts.upload({
      bytes,
      mediaType: "text/markdown",
      purpose: "report",
      operationKey: "remote-acp-report"
    });
    const summary = result.output.trim().split(/\r?\n/, 1)[0]?.slice(0, 16_384) ?? "ACP completed.";
    return { summary, reportArtifactRef, artifactRefs: [] };
  }
}
