import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { parseAgentHostConfig, type AgentHostConfig } from "../config/schema.js";
import { observeHostReadiness } from "../config/readiness.js";
import { ConfiguredAcpProfileResolver, ConfiguredWorkspaceResolver } from "../config/resolvers.js";
import {
  composeAgentHost,
  type AgentHostComposition
} from "../composition/agentHostComposition.js";
import { FileHostCredentialStore } from "../credentials/fileCredentialStore.js";
import { AgentHostCredentialRenewal } from "../credentials/credentialRenewal.js";
import { credentialInstanceId } from "../credentials/credentialContract.js";
import {
  pendingProvenanceMatchesHandoff,
  portableHandoffConfigMatches
} from "../credentials/handoffProvenance.js";
import { AgentHostEnrollmentService } from "../enrollment/enrollmentService.js";
import { HttpAgentHostEnrollmentExchange } from "../enrollment/httpEnrollmentExchange.js";
import { HttpAgentHostSetupCodeRedeem } from "../enrollment/httpSetupCodeRedeem.js";
import { RemoteAcpExecutor } from "../execution/remoteAcpExecutor.js";
import { DurableAcpInteractionRelay } from "../execution/durableAcpRelay.js";
import { openAgentHostState } from "../state/agentHostState.js";
import {
  assertDurableStateReplacementSafe,
  clearDurableStateForReenrollment,
  ensureDurableHostIdentity
} from "../state/durableHostIdentity.js";
import { AgentHostClient } from "../transport/agentHostClient.js";
import { agentHostPackageVersion } from "../packageInfo.js";
import { createAgentHostTlsTrust } from "../tls/trust.js";
import { findSupportedHostAcpProfile } from "../realAcp/supportedProfiles.js";
import { writePrivateJsonFile } from "../config/privateConfigWriter.js";
import {
  listAgentExposure,
  parseAgentExposureProfileId,
  readExposedAgentProfileIds,
  requireSupportedAgentProfile,
  writeExposedAgentProfileIds,
  type AgentExposureStatus
} from "./agentExposure.js";
import { parseAgentHostSetupHandoff } from "@planweave-ai/agent-host-protocol";
import {
  configFromAgentHostSetupHandoff,
  handoffInstanceKey,
  resolveAgentHostDefaultPaths
} from "../config/defaultPaths.js";
import { createPlatformBackgroundService } from "../background/platformBackground.js";
import {
  AgentHostBackgroundSetupError,
  type AgentHostBackgroundLauncher,
  type AgentHostBackgroundGuidance,
  type AgentHostBackgroundLogs,
  type AgentHostBackgroundResult,
  type AgentHostBackgroundService
} from "../background/backgroundService.js";
import { resolveHostExecutable } from "../platform/resolveHostExecutable.js";
import { agentProcessEnv } from "@planweave-ai/runtime";

const MAX_CONFIG_BYTES = 256 * 1_024;

export type AgentHostDiagnostics = {
  version: typeof agentHostPackageVersion;
  hostId?: string;
  workspaceId?: string;
  credential: "missing" | "pending" | "active" | "revoked" | "expired";
  capabilities: string[];
  capacity: number;
  connection: "online" | "offline";
  recoverableExecutions: number;
  actionableError?: string;
};

export type PortableEnrollmentResult = {
  state: "ready" | "background_setup_required" | "tls_trust_configuration_required";
  /** Legacy collaboration workspace scope; omitted for server-scoped fleet enrollment. */
  workspaceId?: string;
  credential: AgentHostDiagnostics["credential"];
  background: "running" | "disabled" | "setup_required";
  backgroundGuidance?: AgentHostBackgroundGuidance;
  configPath: string;
  agents: AgentExposureStatus[];
  nextSteps: {
    listAgents: PortableAgentHostCommand;
    exposeAgent: PortableAgentHostCommand;
    hideAgent: PortableAgentHostCommand;
    runManually: PortableAgentHostCommand;
  };
};

export type PortableAgentHostCommand = {
  command: "planweave";
  args: readonly string[];
};

export type AgentExposureMutationResult = {
  agents: AgentExposureStatus[];
  reload: "restarted" | "restart_required";
};

export async function loadAgentHostConfig(path: string): Promise<AgentHostConfig> {
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_CONFIG_BYTES) throw new Error("agent_host_config_too_large");
  try {
    return parseAgentHostConfig(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw new Error("agent_host_config_invalid", { cause: error });
  }
}

function credentialStore(config: AgentHostConfig): FileHostCredentialStore {
  return new FileHostCredentialStore(join(config.dataDirectory, "credentials.json"));
}

function transportOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  return url.origin;
}

export class AgentHostOperator {
  constructor(
    private readonly backgroundService: AgentHostBackgroundService | null = createPlatformBackgroundService(),
    private readonly hostPlatform: NodeJS.Platform = process.platform,
    private readonly hostEnvironment: Readonly<Record<string, string | undefined>> = process.env
  ) {}

  private async resolvePresetCommand(command: string): Promise<string> {
    const resolved = await resolveHostExecutable({
      command,
      platform: this.hostPlatform,
      env: agentProcessEnv({
        platform: this.hostPlatform,
        env: { ...this.hostEnvironment }
      })
    });
    if (!resolved) throw new Error("agent_host_preset_binary_missing");
    return resolved;
  }

  async initializePreset(configPath: string, presetId: string): Promise<AgentHostConfig> {
    if (presetId !== "codex-acp") throw new Error("agent_host_preset_unsupported");
    const config = await loadAgentHostConfig(configPath);
    const preset = findSupportedHostAcpProfile(presetId);
    if (!preset) throw new Error("agent_host_preset_unsupported");
    const command = await this.resolvePresetCommand(preset.command);
    const profile = {
      id: preset.profileId,
      agentId: preset.agentId,
      command,
      args: [...preset.args],
      environment: [...preset.environment]
    };
    const existing = config.agentProfiles.find((candidate) => candidate.id === profile.id);
    if (
      existing &&
      (existing.agentId !== profile.agentId || existing.command !== profile.command)
    ) {
      throw new Error("agent_host_preset_profile_conflict");
    }
    const next = parseAgentHostConfig({
      ...config,
      host: {
        ...config.host,
        capabilities: [...new Set([...config.host.capabilities, `acp.${preset.agentId}`])]
      },
      agentProfiles: existing ? config.agentProfiles : [...config.agentProfiles, profile]
    });
    await writePrivateJsonFile(configPath, next);
    return next;
  }

  async listAgents(configPath: string): Promise<AgentExposureStatus[]> {
    const config = await loadAgentHostConfig(configPath);
    return listAgentExposure(config, (command) => this.resolvePresetCommand(command));
  }

  async reconcileAgentExposure(
    configPath: string,
    profileIds: readonly string[]
  ): Promise<AgentExposureMutationResult> {
    const requested = new Set<string>();
    const presets = profileIds.map((profileId) => {
      const parsedProfileId = parseAgentExposureProfileId(profileId);
      if (requested.has(parsedProfileId)) {
        throw new Error("duplicate_exposed_agent_profile");
      }
      requested.add(parsedProfileId);
      return requireSupportedAgentProfile(parsedProfileId);
    });
    const config = await loadAgentHostConfig(configPath);
    const additions: AgentHostConfig["agentProfiles"] = [];
    const capabilities = new Set(config.host.capabilities);
    for (const preset of presets) {
      const existing = config.agentProfiles.find((profile) => profile.id === preset.profileId);
      if (existing && existing.agentId !== preset.agentId) {
        throw new Error("agent_host_agent_profile_conflict");
      }
      const command = await this.resolvePresetCommand(existing?.command ?? preset.command);
      capabilities.add(`acp.${preset.agentId}`);
      if (!existing) {
        additions.push({
          id: preset.profileId,
          agentId: preset.agentId,
          command,
          args: [...preset.args],
          environment: [...preset.environment]
        });
      }
    }
    const next =
      additions.length === 0 && capabilities.size === config.host.capabilities.length
        ? config
        : parseAgentHostConfig({
            ...config,
            host: { ...config.host, capabilities: [...capabilities] },
            agentProfiles: [...config.agentProfiles, ...additions]
          });
    if (next !== config) await writePrivateJsonFile(configPath, next);
    await writeExposedAgentProfileIds(next, [...requested]);
    return {
      agents: await this.listAgents(configPath),
      reload: await this.reloadBackground(next)
    };
  }

  async exposeAgent(configPath: string, profileId: string): Promise<AgentExposureMutationResult> {
    const preset = requireSupportedAgentProfile(profileId);
    const config = await loadAgentHostConfig(configPath);
    const existing = config.agentProfiles.find((profile) => profile.id === profileId);
    if (existing && existing.agentId !== preset.agentId) {
      throw new Error("agent_host_agent_profile_conflict");
    }
    const command = await this.resolvePresetCommand(existing?.command ?? preset.command);
    const next = existing
      ? config
      : parseAgentHostConfig({
          ...config,
          host: {
            ...config.host,
            capabilities: [...new Set([...config.host.capabilities, `acp.${preset.agentId}`])]
          },
          agentProfiles: [
            ...config.agentProfiles,
            {
              id: preset.profileId,
              agentId: preset.agentId,
              command,
              args: [...preset.args],
              environment: [...preset.environment]
            }
          ]
        });
    if (next !== config) await writePrivateJsonFile(configPath, next);
    const exposed = new Set(await readExposedAgentProfileIds(next));
    exposed.add(profileId);
    await writeExposedAgentProfileIds(next, [...exposed]);
    return {
      agents: await this.listAgents(configPath),
      reload: await this.reloadBackground(next)
    };
  }

  async hideAgent(configPath: string, profileId: string): Promise<AgentExposureMutationResult> {
    const parsedProfileId = parseAgentExposureProfileId(profileId);
    const config = await loadAgentHostConfig(configPath);
    const exposed = new Set(await readExposedAgentProfileIds(config));
    exposed.delete(parsedProfileId);
    await writeExposedAgentProfileIds(config, [...exposed]);
    return {
      agents: await this.listAgents(configPath),
      reload: await this.reloadBackground(config)
    };
  }

  async enrollHandoff(
    encodedHandoff: string,
    options: {
      workspaceRoot?: string;
      caCertificatePath?: string;
      installBackground?: boolean;
      executablePath?: string;
      fixedArgs?: readonly string[];
    } = {}
  ): Promise<PortableEnrollmentResult> {
    const handoff = parseAgentHostSetupHandoff(encodedHandoff);
    const instanceKey = handoffInstanceKey(handoff);
    const paths = resolveAgentHostDefaultPaths(instanceKey);
    let config: AgentHostConfig;
    try {
      config = await loadAgentHostConfig(paths.configPath);
      if (!portableHandoffConfigMatches(handoff, config)) {
        throw new Error("agent_host_handoff_config_conflict");
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        if (
          !(
            error instanceof Error &&
            error.message === "agent_host_config_invalid" &&
            error.cause &&
            typeof error.cause === "object" &&
            "code" in error.cause &&
            error.cause.code === "ENOENT"
          )
        ) {
          throw error;
        }
      }
      config = configFromAgentHostSetupHandoff(handoff, {
        paths,
        workspaceRoot: options.workspaceRoot,
        hostDisplayName: hostname(),
        caCertificatePath: options.caCertificatePath
      });
      if (handoff.workspaceId !== undefined) {
        await mkdir(join(config.workspaceRoot, handoff.workspaceId), {
          recursive: true,
          mode: 0o700
        });
      }
      await writePrivateJsonFile(paths.configPath, config);
      await writeExposedAgentProfileIds(config, []);
    }

    if (handoff.endpoint.tlsTrust === "configured_ca" && !config.coordinator.caCertificatePath) {
      return {
        state: "tls_trust_configuration_required",
        workspaceId: handoff.workspaceId,
        credential: (await this.diagnostics(config)).credential,
        background: "setup_required",
        backgroundGuidance: "configure_ca_certificate",
        ...(await this.portableEnrollmentContext(paths.configPath))
      };
    }

    const store = credentialStore(config);
    const document = await store.read();
    if (document?.active && document.pending) {
      throw new Error("agent_host_handoff_pending_conflict");
    }
    if (document?.pending) {
      const conflictsWithCurrentHandoff =
        document.pending.kind !== "host_enrollment_code" ||
        !document.pending.provenance ||
        !pendingProvenanceMatchesHandoff(document.pending.provenance, handoff, config);
      if (conflictsWithCurrentHandoff) {
        if (
          document.pending.kind !== "host_enrollment_code" ||
          !document.pending.provenance ||
          document.active
        ) {
          throw new Error("agent_host_handoff_pending_conflict");
        }
        await this.enrollPortableHandoff(config, encodedHandoff, paths.configPath, true);
      } else {
        await this.resumeEnrollment(paths.configPath);
      }
    } else if (!document?.active) {
      // Credentials are gone but a prior Host left durable stores; those cannot resume without a
      // usable credential, so clear them before portable recovery enrollment.
      await clearDurableStateForReenrollment(config.dataDirectory);
      await this.enrollPortableHandoff(config, encodedHandoff, paths.configPath);
    } else if (document.active.workspaceId !== handoff.workspaceId) {
      throw new Error("agent_host_handoff_credential_conflict");
    } else {
      try {
        await store.requireUsable();
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "agent_host_credential_unavailable") {
          throw error;
        }
        // Ordinary (non-portable) credentials stay operator-managed. Portable handoff credentials may
        // be replaced by pasting a fresh handoff so Desktop can recover without a separate UI.
        if (!document.active.provenance) {
          throw error;
        }
        await clearDurableStateForReenrollment(config.dataDirectory);
        await this.enrollPortableHandoff(config, encodedHandoff, paths.configPath, false, true);
      }
    }

    if (options.installBackground === false) {
      return {
        state: "ready",
        workspaceId: handoff.workspaceId,
        credential: "active",
        background: "disabled",
        ...(await this.portableEnrollmentContext(paths.configPath))
      };
    }
    if (!this.backgroundService) {
      return {
        state: "background_setup_required",
        workspaceId: handoff.workspaceId,
        credential: "active",
        background: "setup_required",
        backgroundGuidance: "run_agent_host_manually",
        ...(await this.portableEnrollmentContext(paths.configPath))
      };
    }
    try {
      await this.backgroundService.install({
        workspaceId: instanceKey,
        executablePath: options.executablePath ?? process.execPath,
        fixedArgs:
          options.fixedArgs ??
          (options.executablePath ? [] : process.argv[1] ? [process.argv[1]] : []),
        configPath: paths.configPath,
        privateDirectory: config.dataDirectory
      });
      return {
        state: "ready",
        workspaceId: handoff.workspaceId,
        credential: "active",
        background: "running",
        ...(await this.portableEnrollmentContext(paths.configPath))
      };
    } catch (error) {
      return {
        state: "background_setup_required",
        workspaceId: handoff.workspaceId,
        credential: "active",
        background: "setup_required",
        backgroundGuidance:
          error instanceof AgentHostBackgroundSetupError
            ? error.guidance
            : "run_agent_host_manually",
        ...(await this.portableEnrollmentContext(paths.configPath))
      };
    }
  }

  private async portableEnrollmentContext(
    configPath: string
  ): Promise<Pick<PortableEnrollmentResult, "configPath" | "agents" | "nextSteps">> {
    const command = "planweave" as const;
    return {
      configPath,
      agents: await this.listAgents(configPath),
      nextSteps: {
        listAgents: { command, args: ["agent-host", "agents", "list", "--config", configPath] },
        exposeAgent: {
          command,
          args: ["agent-host", "agents", "expose", "<supported-profile>", "--config", configPath]
        },
        hideAgent: {
          command,
          args: ["agent-host", "agents", "hide", "<supported-profile>", "--config", configPath]
        },
        runManually: { command, args: ["agent-host", "run", "--config", configPath] }
      }
    };
  }

  async resumeEnrollment(configPath: string): Promise<AgentHostDiagnostics> {
    const config = await loadAgentHostConfig(configPath);
    const trust = await createAgentHostTlsTrust(config.coordinator.caCertificatePath);
    try {
      const exchangeOptions = {
        allowInsecureDevelopment: config.coordinator.allowInsecureDevelopment,
        request: trust.request
      };
      await new AgentHostEnrollmentService(
        config,
        credentialStore(config),
        new HttpAgentHostEnrollmentExchange(config.coordinator.url, exchangeOptions),
        () => new Date(),
        new HttpAgentHostSetupCodeRedeem(config.coordinator.url, exchangeOptions)
      ).resume();
    } finally {
      await trust.close();
    }
    return this.diagnostics(config);
  }

  private async enrollPortableHandoff(
    config: AgentHostConfig,
    encodedHandoff: string,
    configPath: string,
    restartPendingEnrollment = false,
    replaceExisting = false
  ): Promise<void> {
    await this.preflight(configPath);
    // Callers that recover from unusable credentials clear durable state first. Fresh portable
    // enrollment still refuses silent replacement when prior Host state remains on disk.
    if (!replaceExisting) {
      await assertDurableStateReplacementSafe(config.dataDirectory);
    }
    const trust = await createAgentHostTlsTrust(config.coordinator.caCertificatePath);
    try {
      const exchangeOptions = {
        allowInsecureDevelopment: config.coordinator.allowInsecureDevelopment,
        request: trust.request
      };
      await new AgentHostEnrollmentService(
        config,
        credentialStore(config),
        new HttpAgentHostEnrollmentExchange(config.coordinator.url, exchangeOptions)
      ).enrollPortableHandoff(encodedHandoff, { restartPendingEnrollment, replaceExisting });
    } finally {
      await trust.close();
    }
  }

  async requireUsableCredential(configPath: string): Promise<void> {
    const config = await loadAgentHostConfig(configPath);
    await credentialStore(config).requireUsable();
  }

  async preflight(configPath: string): Promise<AgentHostDiagnostics> {
    const config = await loadAgentHostConfig(configPath);
    await realpath(config.workspaceRoot);
    await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
    await credentialStore(config).read();
    const workspaces = new ConfiguredWorkspaceResolver(config);
    const profiles = new ConfiguredAcpProfileResolver(config);
    await Promise.all([
      ...config.workspaces.map((workspace) => workspaces.resolve(workspace.id)),
      ...config.agentProfiles.map((profile) => profiles.resolve(profile.id, profile.agentId))
    ]);
    const trust = await createAgentHostTlsTrust(config.coordinator.caCertificatePath);
    await trust.close();
    return this.diagnostics(config);
  }

  async enroll(
    configPath: string,
    code: string,
    replaceExisting = false
  ): Promise<AgentHostDiagnostics> {
    const config = await loadAgentHostConfig(configPath);
    await this.preflight(configPath);
    const store = credentialStore(config);
    const credentialDocument = await store.read();
    if (replaceExisting || !credentialDocument?.active) {
      await assertDurableStateReplacementSafe(config.dataDirectory);
    }
    const trust = await createAgentHostTlsTrust(config.coordinator.caCertificatePath);
    try {
      const exchangeOptions = {
        allowInsecureDevelopment: config.coordinator.allowInsecureDevelopment,
        request: trust.request
      };
      const service = new AgentHostEnrollmentService(
        config,
        store,
        new HttpAgentHostEnrollmentExchange(config.coordinator.url, exchangeOptions),
        () => new Date(),
        new HttpAgentHostSetupCodeRedeem(config.coordinator.url, exchangeOptions)
      );
      await service.enroll(code, { replaceExisting });
    } finally {
      await trust.close();
    }
    return this.diagnostics(config);
  }

  async revoke(configPath: string): Promise<AgentHostDiagnostics> {
    const config = await loadAgentHostConfig(configPath);
    await credentialStore(config).markRevoked();
    return this.diagnostics(config);
  }

  async status(configPath: string): Promise<AgentHostDiagnostics> {
    return this.diagnostics(await loadAgentHostConfig(configPath));
  }

  async installBackground(
    configPath: string,
    launcher: AgentHostBackgroundLauncher
  ): Promise<AgentHostBackgroundResult> {
    const service = this.requireBackgroundService();
    const config = await loadAgentHostConfig(configPath);
    const credential = await credentialStore(config).requireUsable();
    return service.install({
      workspaceId: credentialInstanceId(credential),
      executablePath: launcher.executablePath,
      fixedArgs: launcher.fixedArgs,
      configPath,
      privateDirectory: config.dataDirectory
    });
  }

  async uninstallBackground(configPath: string): Promise<AgentHostBackgroundResult> {
    const service = this.requireBackgroundService();
    return service.uninstall(await this.backgroundIdentity(configPath));
  }

  async backgroundStatus(configPath: string): Promise<AgentHostBackgroundResult> {
    const service = this.requireBackgroundService();
    return service.status(await this.backgroundIdentity(configPath));
  }

  async restartBackground(configPath: string): Promise<AgentHostBackgroundResult> {
    const service = this.requireBackgroundService();
    return service.restart(await this.usableBackgroundIdentity(configPath));
  }

  async backgroundLogs(configPath: string): Promise<AgentHostBackgroundLogs> {
    const service = this.requireBackgroundService();
    return service.logs(await this.backgroundIdentity(configPath));
  }

  async createDaemon(configPath: string): Promise<AgentHostComposition> {
    const config = await loadAgentHostConfig(configPath);
    await realpath(config.workspaceRoot);
    await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
    const credentials = credentialStore(config);
    await credentials.read();
    const credential = await credentials.requireUsable();
    const readiness = await observeHostReadiness(
      config,
      process.env,
      await readExposedAgentProfileIds(config)
    );
    await ensureDurableHostIdentity(
      config.dataDirectory,
      credential.hostId,
      credentialInstanceId(credential)
    );
    const trust = await createAgentHostTlsTrust(config.coordinator.caCertificatePath);
    let state: Awaited<ReturnType<typeof openAgentHostState>> | undefined;
    try {
      state = await openAgentHostState(join(config.dataDirectory, "state.sqlite"));
      state.recoverableExecutionCount();
      await state.importLegacyRemoteExecutionStore(
        join(config.dataDirectory, "remote-execution.sqlite")
      );
      const interactionRelay = new DurableAcpInteractionRelay(state);
      const executor = new RemoteAcpExecutor({
        workspaceResolver: new ConfiguredWorkspaceResolver(config),
        profileResolver: new ConfiguredAcpProfileResolver(
          config,
          process.env,
          async (agentProfileId) =>
            (await readExposedAgentProfileIds(config)).includes(agentProfileId)
        ),
        outbox: state,
        interactionResponder: interactionRelay,
        hostCapabilities: config.host.capabilities,
        // Remote Host ACP work commonly exceeds the local 30s engine default (tool calls + writeback).
        limits: {
          operationTimeoutMs: 15 * 60_000,
          interactionTimeoutMs: 15 * 60_000,
          cleanupTimeoutMs: 30_000
        }
      });
      const transport = new AgentHostClient({
        serverUrl: transportOrigin(config.coordinator.url),
        hostId: credential.hostId,
        workspaceId: credential.workspaceId,
        token: credential.credentialToken,
        ...(credential.credentialPolicy
          ? {
              credentialRenewal: new AgentHostCredentialRenewal(
                transportOrigin(config.coordinator.url),
                credentials,
                { request: trust.request }
              )
            }
          : {}),
        capabilities: config.host.capabilities,
        capacity: config.host.capacity,
        readiness,
        state,
        executor,
        interactionRelay,
        allowInsecureTransport: config.coordinator.allowInsecureDevelopment,
        ca: trust.ca,
        request: trust.request
      });
      const { writeHostConnectionStatus } = await import("../transport/connectionStatus.js");
      transport.subscribe((status) => {
        void writeHostConnectionStatus(config.dataDirectory, status).catch(() => undefined);
      });
      return composeAgentHost({ state, transport, closeResources: trust.close });
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        state?.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await trust.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "agent_host_daemon_startup_cleanup_failed",
          {
            cause: error
          }
        );
      }
      throw error;
    }
  }

  private async diagnostics(config: AgentHostConfig): Promise<AgentHostDiagnostics> {
    let credential: AgentHostDiagnostics["credential"] = "missing";
    let hostId: string | undefined;
    let workspaceId: string | undefined;
    let actionableError: string | undefined;
    try {
      const document = await credentialStore(config).read();
      if (document?.pending) credential = "pending";
      if (document?.active) {
        hostId = document.active.hostId;
        workspaceId = document.active.workspaceId;
        credential = document.active.revokedAt
          ? "revoked"
          : Date.parse(document.active.expiresAt) <= Date.now()
            ? "expired"
            : "active";
      }
    } catch {
      actionableError = "credential_store_invalid";
    }
    let recoverableExecutions = 0;
    const statePath = join(config.dataDirectory, "state.sqlite");
    try {
      if ((await stat(statePath)).isFile()) {
        const state = await openAgentHostState(statePath);
        try {
          recoverableExecutions = state.recoverableExecutionCount();
        } finally {
          state.close();
        }
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        actionableError ??= "execution_state_invalid";
      }
    }
    let connection: AgentHostDiagnostics["connection"] = "offline";
    try {
      const { readHostConnectionStatus } = await import("../transport/connectionStatus.js");
      const status = await readHostConnectionStatus(config.dataDirectory);
      if (status?.transport.state === "connected") connection = "online";
      if (status?.transport.state === "reconciliation-required") {
        actionableError ??= "mailbox_reconciliation_required";
      }
    } catch {
      // Keep the redacted offline default when status storage is unavailable.
    }
    return {
      version: agentHostPackageVersion,
      hostId,
      workspaceId,
      credential,
      capabilities: [...config.host.capabilities],
      capacity: config.host.capacity,
      connection,
      recoverableExecutions,
      actionableError
    };
  }

  private async reloadBackground(
    config: AgentHostConfig
  ): Promise<"restarted" | "restart_required"> {
    if (!this.backgroundService) return "restart_required";
    let workspaceId: string;
    try {
      workspaceId = credentialInstanceId(await credentialStore(config).requireUsable());
    } catch (error) {
      if (error instanceof Error && error.message === "agent_host_credential_unavailable") {
        return "restart_required";
      }
      throw error;
    }
    const identity = { workspaceId, privateDirectory: config.dataDirectory };
    const status = await this.backgroundService.status(identity);
    if (status.state !== "running") return "restart_required";
    await this.backgroundService.restart(identity);
    return "restarted";
  }

  private requireBackgroundService(): AgentHostBackgroundService {
    if (!this.backgroundService) throw new Error("agent_host_background_service_unavailable");
    return this.backgroundService;
  }

  private async backgroundIdentity(
    configPath: string
  ): Promise<{ workspaceId: string; privateDirectory: string }> {
    const config = await loadAgentHostConfig(configPath);
    const document = await credentialStore(config).read();
    if (!document?.active) throw new Error("agent_host_background_identity_unavailable");
    return {
      workspaceId: credentialInstanceId(document.active),
      privateDirectory: config.dataDirectory
    };
  }

  private async usableBackgroundIdentity(
    configPath: string
  ): Promise<{ workspaceId: string; privateDirectory: string }> {
    const config = await loadAgentHostConfig(configPath);
    return {
      workspaceId: credentialInstanceId(await credentialStore(config).requireUsable()),
      privateDirectory: config.dataDirectory
    };
  }
}
