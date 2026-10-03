import { mkdir, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writePrivateTextFile } from "../config/privateConfigWriter.js";
import type {
  AgentHostBackgroundIdentity,
  AgentHostBackgroundInstall,
  AgentHostBackgroundLogs,
  AgentHostBackgroundResult,
  AgentHostBackgroundService,
  AgentHostBackgroundStatusOptions
} from "./backgroundService.js";
import { AgentHostBackgroundSetupError } from "./backgroundService.js";
import { runFixedArgv, type FixedArgvRunner } from "./processRunner.js";

function serviceName(workspaceId: string): string {
  return `planweave-agent-host-${workspaceId.replace(/[^A-Za-z0-9_.-]/g, "-")}.service`;
}

function quoteSystemd(value: string): string {
  if ([...value].some((character) => [0, 10, 13].includes(character.codePointAt(0) ?? -1))) {
    throw new Error("agent_host_background_unit_value_invalid");
  }
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => "$$")}"`;
}

function unitText(input: AgentHostBackgroundInstall): string {
  return [
    "[Unit]",
    "Description=PlanWeave Agent Host",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${[
      input.executablePath,
      ...(input.fixedArgs ?? []),
      "run",
      "--config",
      input.configPath
    ]
      .map(quoteSystemd)
      .join(" ")}`,
    "Restart=always",
    "RestartSec=5s",
    "TimeoutStopSec=30s",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
}

export class LinuxUserSystemdService implements AgentHostBackgroundService {
  constructor(
    private readonly runner: FixedArgvRunner = runFixedArgv,
    private readonly userConfigDirectory = join(homedir(), ".config", "systemd", "user")
  ) {}

  async install(input: AgentHostBackgroundInstall): Promise<AgentHostBackgroundResult> {
    const unit = serviceName(input.workspaceId);
    await mkdir(this.userConfigDirectory, { recursive: true, mode: 0o700 });
    const path = join(this.userConfigDirectory, unit);
    await writePrivateTextFile(path, unitText(input));
    try {
      await this.runner("systemctl", ["--user", "daemon-reload"]);
      await this.runner("systemctl", ["--user", "enable", "--now", unit]);
      return { state: "running", platform: "linux-systemd-user" };
    } catch (error) {
      throw new AgentHostBackgroundSetupError("enable_user_linger", { cause: error });
    }
  }

  async uninstall(identity: AgentHostBackgroundIdentity): Promise<AgentHostBackgroundResult> {
    const { workspaceId } = identity;
    const unit = serviceName(workspaceId);
    try {
      await this.runner("systemctl", ["--user", "disable", "--now", unit]);
    } catch (error) {
      const status = await this.status(identity);
      if (status.state !== "not_installed") throw error;
    }
    try {
      await unlink(join(this.userConfigDirectory, unit));
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    await this.runner("systemctl", ["--user", "daemon-reload"]);
    return { state: "not_installed", platform: "linux-systemd-user" };
  }

  async status(
    { workspaceId }: AgentHostBackgroundIdentity,
    options?: AgentHostBackgroundStatusOptions
  ): Promise<AgentHostBackgroundResult> {
    const unit = serviceName(workspaceId);
    try {
      const result = await this.runner(
        "systemctl",
        ["--user", "is-active", unit],
        ...(options ? [options] : [])
      );
      return {
        state: result.stdout.trim() === "active" ? "running" : "stopped",
        platform: "linux-systemd-user"
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== 3 && code !== 4) throw error;
      try {
        await readFile(join(this.userConfigDirectory, unit));
        return { state: "stopped", platform: "linux-systemd-user" };
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return { state: "not_installed", platform: "linux-systemd-user" };
        }
        throw error;
      }
    }
  }

  async restart(identity: AgentHostBackgroundIdentity): Promise<AgentHostBackgroundResult> {
    const { workspaceId } = identity;
    const unit = serviceName(workspaceId);
    const status = await this.status(identity);
    if (status.state === "not_installed") return status;
    await this.runner("systemctl", ["--user", "restart", unit]);
    return { state: "running", platform: "linux-systemd-user" };
  }

  async logs({ workspaceId }: AgentHostBackgroundIdentity): Promise<AgentHostBackgroundLogs> {
    return {
      platform: "linux-systemd-user",
      source: "systemd-journal",
      command: {
        executable: "journalctl",
        args: ["--user", "-u", serviceName(workspaceId)]
      }
    };
  }
}

export { serviceName as linuxAgentHostServiceName, unitText as linuxAgentHostUnitText };
