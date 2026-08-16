import { join } from "node:path";
import {
  AgentHostOperator,
  FileHostCredentialStore,
  handoffInstanceKey,
  listSupportedHostAcpProfiles,
  loadAgentHostConfig,
  readHostConnectionStatus,
  resolveAgentHostDefaultPaths,
  supportsPlatformBackgroundService,
  type AgentExposureMutationResult,
  type AgentHostBackgroundLauncher,
  type AgentHostBackgroundResult,
  type PortableEnrollmentResult
} from "@planweave-ai/agent-host";
import { parseAgentHostSetupHandoff } from "@planweave-ai/agent-host-protocol";
import {
  operatorLocalAgentHostStatusSchema,
  type OperatorLocalAgentHostServerConnection,
  type OperatorLocalAgentHostStatus
} from "../../shared/operatorControl.js";
import { LocalAgentHostRegistrationStore } from "./localAgentHostRegistrationStore.js";

export interface LocalAgentHostOperatorPort {
  enrollHandoff(
    handoff: string,
    options: {
      installBackground: boolean;
      executablePath: string;
      fixedArgs: readonly string[];
    }
  ): Promise<PortableEnrollmentResult>;
  reconcileAgentExposure(
    configPath: string,
    profileIds: readonly string[]
  ): Promise<AgentExposureMutationResult>;
  listAgents(configPath: string): Promise<PortableEnrollmentResult["agents"]>;
  requireUsableCredential(configPath: string): Promise<void>;
  installBackground(
    configPath: string,
    launcher: AgentHostBackgroundLauncher
  ): Promise<AgentHostBackgroundResult>;
  backgroundStatus(configPath: string): Promise<AgentHostBackgroundResult>;
}

export interface LocalAgentHostProvisioner {
  status(profileId?: string): Promise<OperatorLocalAgentHostStatus>;
  repair(
    profileId: string | undefined,
    exposedProfileIds: readonly string[]
  ): Promise<OperatorLocalAgentHostStatus>;
  register(
    profileId: string | undefined,
    handoff: string,
    exposedProfileIds: readonly string[]
  ): Promise<OperatorLocalAgentHostStatus>;
}

export type LocalAgentHostProvisionerOptions = {
  platform?: NodeJS.Platform;
  launcher: AgentHostBackgroundLauncher;
  operator?: LocalAgentHostOperatorPort;
  registrations?: LocalAgentHostRegistrationStore;
};

const agentHostErrorCodePattern = /^(?:agent_host|local_agent_host)_[a-z0-9_]+$/;

function systemErrorSuffix(error: unknown): string | null {
  let candidate = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!candidate || typeof candidate !== "object") return null;
    if ("code" in candidate) {
      if (typeof candidate.code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(candidate.code)) {
        return candidate.code.toLowerCase();
      }
      if (
        typeof candidate.code === "number" &&
        Number.isSafeInteger(candidate.code) &&
        candidate.code >= 0 &&
        candidate.code <= 65_535
      ) {
        return `exit_${candidate.code}`;
      }
    }
    candidate = "cause" in candidate ? candidate.cause : null;
  }
  return null;
}

function localAgentHostStageError(stageCode: string, error: unknown): Error {
  if (error instanceof Error && agentHostErrorCodePattern.test(error.message)) return error;
  const suffix = systemErrorSuffix(error);
  return new Error(suffix ? `${stageCode}_${suffix}` : stageCode, { cause: error });
}

async function withinLocalAgentHostStage<T>(
  stageCode: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw localAgentHostStageError(stageCode, error);
  }
}

function supportedProfiles() {
  return listSupportedHostAcpProfiles().map((profile) => ({
    profileId: profile.profileId,
    agentId: profile.agentId,
    displayName: profile.displayName,
    detected: false,
    exposed: false,
    ready: false
  }));
}

function isAgentHostCredentialUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message === "agent_host_credential_unavailable";
}

function notRegisteredStatus(): OperatorLocalAgentHostStatus {
  return operatorLocalAgentHostStatusSchema.parse({
    supported: true,
    state: "not_registered",
    agents: supportedProfiles()
  });
}

function resolveEnrollmentInstanceKey(
  enrollment: PortableEnrollmentResult,
  handoff: string
): string {
  return enrollment.workspaceId ?? handoffInstanceKey(parseAgentHostSetupHandoff(handoff));
}

async function resolveServerConnection(
  configPath: string,
  backgroundState: OperatorLocalAgentHostStatus["background"]
): Promise<OperatorLocalAgentHostServerConnection> {
  let serverOrigin: string | undefined;
  let dataDirectory: string | undefined;
  try {
    const config = await loadAgentHostConfig(configPath);
    serverOrigin = config.coordinator.endpoint?.serverOrigin ?? config.coordinator.url;
    dataDirectory = config.dataDirectory;
  } catch {
    // Config may be temporarily unreadable; still report a connection state below.
  }

  if (backgroundState !== "running") {
    return {
      state: "stopped",
      ...(serverOrigin ? { serverOrigin } : {})
    };
  }

  if (!dataDirectory) {
    return {
      state: "unknown",
      ...(serverOrigin ? { serverOrigin } : {})
    };
  }

  try {
    const document = await readHostConnectionStatus(dataDirectory);
    if (!document) {
      return {
        state: "unknown",
        ...(serverOrigin ? { serverOrigin } : {})
      };
    }
    const base = {
      updatedAt: document.updatedAt,
      ...(serverOrigin ? { serverOrigin } : {})
    };
    switch (document.transport.state) {
      case "connected":
        return {
          ...base,
          state: "connected",
          connectedAt: document.transport.connectedAt
        };
      case "connecting":
        return {
          ...base,
          state: "connecting",
          attempt: document.transport.attempt
        };
      case "backing-off":
        return {
          ...base,
          state: "backing-off",
          attempt: document.transport.attempt,
          delayMs: document.transport.delayMs,
          retryAt: document.transport.retryAt
        };
      case "degraded":
        return {
          ...base,
          state: "degraded",
          reason: document.transport.reason
        };
      case "reconciliation-required":
        return {
          ...base,
          state: "reconciliation-required",
          reason: document.transport.reason
        };
      case "auth-failed":
        return {
          ...base,
          state: "auth-failed",
          reason: document.transport.reason
        };
      case "stopped":
        return {
          ...base,
          state: "stopped"
        };
    }
  } catch {
    return {
      state: "unknown",
      ...(serverOrigin ? { serverOrigin } : {})
    };
  }
}

function createDefaultLocalAgentHostOperator(): LocalAgentHostOperatorPort {
  const operator = new AgentHostOperator();
  return {
    enrollHandoff: (handoff, options) => operator.enrollHandoff(handoff, options),
    reconcileAgentExposure: (configPath, profileIds) =>
      operator.reconcileAgentExposure(configPath, profileIds),
    listAgents: (configPath) => operator.listAgents(configPath),
    requireUsableCredential: async (configPath) => {
      const config = await loadAgentHostConfig(configPath);
      await new FileHostCredentialStore(
        join(config.dataDirectory, "credentials.json")
      ).requireUsable();
    },
    installBackground: (configPath, launcher) => operator.installBackground(configPath, launcher),
    backgroundStatus: (configPath) => operator.backgroundStatus(configPath)
  };
}

export class DesktopLocalAgentHostProvisioner implements LocalAgentHostProvisioner {
  private readonly platform: NodeJS.Platform;
  private readonly launcher: AgentHostBackgroundLauncher;
  private readonly operator: LocalAgentHostOperatorPort;
  private readonly registrations: LocalAgentHostRegistrationStore;

  constructor(options: LocalAgentHostProvisionerOptions) {
    this.platform = options.platform ?? process.platform;
    this.launcher = options.launcher;
    this.operator = options.operator ?? createDefaultLocalAgentHostOperator();
    this.registrations = options.registrations ?? new LocalAgentHostRegistrationStore();
  }

  async status(profileId?: string): Promise<OperatorLocalAgentHostStatus> {
    if (!supportsPlatformBackgroundService(this.platform)) {
      return operatorLocalAgentHostStatusSchema.parse({
        supported: false,
        state: "not_registered",
        agents: supportedProfiles()
      });
    }
    const registration =
      (profileId ? await this.registrations.get(profileId) : null) ??
      (await this.registrations.latest());
    if (!registration) {
      return notRegisteredStatus();
    }
    const configPath = resolveAgentHostDefaultPaths(registration.workspaceId).configPath;
    let agents: PortableEnrollmentResult["agents"];
    try {
      agents = await this.operator.listAgents(configPath);
    } catch (error) {
      if (systemErrorSuffix(error) === "enoent") {
        await this.registrations.remove(registration.profileId);
        return notRegisteredStatus();
      }
      throw localAgentHostStageError("local_agent_host_agent_status_read_failed", error);
    }
    try {
      await this.operator.requireUsableCredential(configPath);
    } catch (error) {
      if (isAgentHostCredentialUnavailable(error) || systemErrorSuffix(error) === "enoent") {
        // Stale Desktop registration with missing/expired Host credential → restore paste UI.
        // Keep the real exposure list so checkboxes are not falsely cleared before re-enroll.
        await this.registrations.remove(registration.profileId);
        return operatorLocalAgentHostStatusSchema.parse({
          supported: true,
          state: "not_registered",
          workspaceId: registration.workspaceId,
          agents: agents.length > 0 ? agents : supportedProfiles()
        });
      }
      throw localAgentHostStageError("local_agent_host_credential_status_failed", error);
    }
    const background = await withinLocalAgentHostStage(
      "local_agent_host_background_status_read_failed",
      () => this.operator.backgroundStatus(configPath)
    );
    const serverConnection = await resolveServerConnection(configPath, background.state);
    return operatorLocalAgentHostStatusSchema.parse({
      supported: true,
      state: background.state === "running" ? "ready" : "background_setup_required",
      workspaceId: registration.workspaceId,
      background: background.state,
      serverConnection,
      agents
    });
  }

  async register(
    profileId: string | undefined,
    handoff: string,
    exposedProfileIds: readonly string[]
  ): Promise<OperatorLocalAgentHostStatus> {
    if (!supportsPlatformBackgroundService(this.platform)) {
      throw new Error("local_agent_host_unavailable");
    }
    const enrollment = await withinLocalAgentHostStage("local_agent_host_enrollment_failed", () =>
      this.operator.enrollHandoff(handoff, {
        installBackground: false,
        executablePath: this.launcher.executablePath,
        fixedArgs: [...(this.launcher.fixedArgs ?? [])]
      })
    );
    const instanceKey = resolveEnrollmentInstanceKey(enrollment, handoff);
    await withinLocalAgentHostStage("local_agent_host_registration_store_failed", () =>
      this.registrations.upsert(profileId ?? instanceKey, instanceKey)
    );
    const agents = (
      await withinLocalAgentHostStage("local_agent_host_agent_exposure_failed", () =>
        this.operator.reconcileAgentExposure(enrollment.configPath, exposedProfileIds)
      )
    ).agents;
    const background = await withinLocalAgentHostStage(
      "local_agent_host_background_install_failed",
      () => this.operator.installBackground(enrollment.configPath, this.launcher)
    );
    const serverConnection = await resolveServerConnection(enrollment.configPath, background.state);
    return operatorLocalAgentHostStatusSchema.parse({
      supported: true,
      state: background.state === "running" ? "ready" : "background_setup_required",
      workspaceId: enrollment.workspaceId,
      background: background.state,
      serverConnection,
      agents
    });
  }

  async repair(
    profileId: string | undefined,
    exposedProfileIds: readonly string[]
  ): Promise<OperatorLocalAgentHostStatus> {
    const registration =
      (profileId ? await this.registrations.get(profileId) : null) ??
      (await this.registrations.latest());
    if (!registration) throw new Error("local_agent_host_registration_missing");
    const configPath = resolveAgentHostDefaultPaths(registration.workspaceId).configPath;
    let agents: OperatorLocalAgentHostStatus["agents"];
    try {
      agents = (
        await withinLocalAgentHostStage("local_agent_host_agent_exposure_failed", () =>
          this.operator.reconcileAgentExposure(configPath, exposedProfileIds)
        )
      ).agents;
    } catch (error) {
      if (isAgentHostCredentialUnavailable(error)) {
        await this.registrations.remove(registration.profileId);
        return notRegisteredStatus();
      }
      throw error;
    }
    let background: AgentHostBackgroundResult;
    try {
      background = await withinLocalAgentHostStage(
        "local_agent_host_background_install_failed",
        () => this.operator.installBackground(configPath, this.launcher)
      );
    } catch (error) {
      if (isAgentHostCredentialUnavailable(error)) {
        await this.registrations.remove(registration.profileId);
        return notRegisteredStatus();
      }
      throw error;
    }
    const serverConnection = await resolveServerConnection(configPath, background.state);
    return operatorLocalAgentHostStatusSchema.parse({
      supported: true,
      state: background.state === "running" ? "ready" : "background_setup_required",
      workspaceId: registration.workspaceId,
      background: background.state,
      serverConnection,
      agents
    });
  }
}

export function unavailableLocalAgentHostProvisioner(): LocalAgentHostProvisioner {
  return {
    status: async () =>
      operatorLocalAgentHostStatusSchema.parse({
        supported: false,
        state: "not_registered",
        agents: supportedProfiles()
      }),
    register: async () => {
      throw new Error("local_agent_host_unavailable");
    },
    repair: async () => {
      throw new Error("local_agent_host_unavailable");
    }
  };
}
