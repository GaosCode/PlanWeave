import type { FixedArgvOptions } from "./processRunner.js";

export const DEFAULT_AGENT_HOST_BACKGROUND_STATUS_BUDGET_MS = 15_000;

export type AgentHostBackgroundStatusOptions = Pick<FixedArgvOptions, "deadline" | "signal">;

export type AgentHostBackgroundState = "running" | "stopped" | "not_installed";

export type AgentHostBackgroundLauncher = {
  executablePath: string;
  fixedArgs?: readonly string[];
};

export type AgentHostBackgroundInstall = AgentHostBackgroundLauncher & {
  workspaceId: string;
  configPath: string;
  privateDirectory: string;
};

export type AgentHostBackgroundIdentity = Pick<
  AgentHostBackgroundInstall,
  "workspaceId" | "privateDirectory"
>;

export type AgentHostBackgroundGuidance =
  | "enable_user_linger"
  | "check_launch_agent_permissions"
  | "configure_ca_certificate"
  | "run_agent_host_manually";

export type AgentHostBackgroundResult = {
  state: AgentHostBackgroundState;
  platform: "linux-systemd-user" | "macos-launch-agent" | "windows-user-startup";
  guidance?: AgentHostBackgroundGuidance;
};

export type AgentHostBackgroundLogs =
  | {
      platform: "linux-systemd-user";
      source: "systemd-journal";
      command: { executable: "journalctl"; args: readonly string[] };
    }
  | {
      platform: "macos-launch-agent";
      source: "launch-agent-files";
      stdoutPath: string;
      stderrPath: string;
    }
  | {
      platform: "windows-user-startup";
      source: "user-startup-diagnostics";
      registryValueName: string;
      capturesHostStdout: false;
    };

export class AgentHostBackgroundSetupError extends Error {
  readonly code = "agent_host_background_setup_required";

  constructor(
    readonly guidance: AgentHostBackgroundGuidance,
    options?: ErrorOptions
  ) {
    super("agent_host_background_setup_required", options);
  }
}

export interface AgentHostBackgroundService {
  install(input: AgentHostBackgroundInstall): Promise<AgentHostBackgroundResult>;
  uninstall(identity: AgentHostBackgroundIdentity): Promise<AgentHostBackgroundResult>;
  status(
    identity: AgentHostBackgroundIdentity,
    options?: AgentHostBackgroundStatusOptions
  ): Promise<AgentHostBackgroundResult>;
  restart(identity: AgentHostBackgroundIdentity): Promise<AgentHostBackgroundResult>;
  logs(identity: AgentHostBackgroundIdentity): Promise<AgentHostBackgroundLogs>;
}
