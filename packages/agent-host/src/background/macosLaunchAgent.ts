import { mkdir, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writePrivateTextFile } from "../config/privateConfigWriter.js";
import type {
  AgentHostBackgroundIdentity,
  AgentHostBackgroundInstall,
  AgentHostBackgroundLogs,
  AgentHostBackgroundResult,
  AgentHostBackgroundService
} from "./backgroundService.js";
import { AgentHostBackgroundSetupError } from "./backgroundService.js";
import { runFixedArgv, type FixedArgvRunner } from "./processRunner.js";

function launchAgentLabel(workspaceId: string): string {
  return `com.planweave.agent-host.${workspaceId.replace(/[^A-Za-z0-9.-]/gu, "-")}`;
}

function xmlText(value: string): string {
  if (
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? -1;
      return code === 0 || (code < 32 && code !== 9 && code !== 10 && code !== 13);
    })
  ) {
    throw new Error("agent_host_background_launch_agent_value_invalid");
  }
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function launchAgentPlist(input: AgentHostBackgroundInstall): string {
  const programArguments = [
    input.executablePath,
    ...(input.fixedArgs ?? []),
    "run",
    "--config",
    input.configPath
  ];
  const stdoutPath = join(input.privateDirectory, "agent-host.stdout.log");
  const stderrPath = join(input.privateDirectory, "agent-host.stderr.log");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlText(launchAgentLabel(input.workspaceId))}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...programArguments.map((argument) => `    <string>${xmlText(argument)}</string>`),
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>ThrottleInterval</key>",
    "  <integer>5</integer>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlText(stdoutPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlText(stderrPath)}</string>`,
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}

function processErrorCode(error: unknown): number | string | undefined {
  return error && typeof error === "object" && "code" in error
    ? typeof error.code === "number" || typeof error.code === "string"
      ? error.code
      : undefined
    : undefined;
}

function isMissingService(error: unknown): boolean {
  const code = processErrorCode(error);
  return code === 3 || code === 113;
}

function isMissingFile(error: unknown): boolean {
  return processErrorCode(error) === "ENOENT";
}

function isTransientBootstrapFailure(error: unknown): boolean {
  return processErrorCode(error) === 5;
}

const launchAgentReplacementBootstrapRetries = 19;

export class MacosLaunchAgentService implements AgentHostBackgroundService {
  private readonly logDirectories = new Map<string, string>();

  constructor(
    private readonly runner: FixedArgvRunner = runFixedArgv,
    private readonly launchAgentsDirectory = join(homedir(), "Library", "LaunchAgents"),
    private readonly getUid: () => number | undefined = () => process.getuid?.(),
    private readonly waitForReplacement: () => Promise<void> = () => delay(100)
  ) {}

  async install(input: AgentHostBackgroundInstall): Promise<AgentHostBackgroundResult> {
    const label = launchAgentLabel(input.workspaceId);
    const path = join(this.launchAgentsDirectory, `${label}.plist`);
    const domain = this.domain();
    await mkdir(this.launchAgentsDirectory, { recursive: true, mode: 0o700 });
    await writePrivateTextFile(path, launchAgentPlist(input));
    this.logDirectories.set(input.workspaceId, input.privateDirectory);
    try {
      let replacedExistingService = false;
      try {
        await this.runner("launchctl", ["print", `${domain}/${label}`]);
        await this.runner("launchctl", ["bootout", `${domain}/${label}`]);
        replacedExistingService = true;
      } catch (error) {
        if (!isMissingService(error)) throw error;
      }
      await this.bootstrap(domain, path, replacedExistingService);
      await this.runner("launchctl", ["kickstart", "-k", `${domain}/${label}`]);
      return { state: "running", platform: "macos-launch-agent" };
    } catch (error) {
      throw new AgentHostBackgroundSetupError("check_launch_agent_permissions", { cause: error });
    }
  }

  async uninstall({
    workspaceId
  }: AgentHostBackgroundIdentity): Promise<AgentHostBackgroundResult> {
    const label = launchAgentLabel(workspaceId);
    try {
      await this.runner("launchctl", ["bootout", `${this.domain()}/${label}`]);
    } catch (error) {
      if (!isMissingService(error)) throw error;
    }
    try {
      await unlink(join(this.launchAgentsDirectory, `${label}.plist`));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    this.logDirectories.delete(workspaceId);
    return { state: "not_installed", platform: "macos-launch-agent" };
  }

  async status({ workspaceId }: AgentHostBackgroundIdentity): Promise<AgentHostBackgroundResult> {
    const label = launchAgentLabel(workspaceId);
    try {
      const result = await this.runner("launchctl", ["print", `${this.domain()}/${label}`]);
      return {
        state: /\bstate\s*=\s*running\b/u.test(result.stdout) ? "running" : "stopped",
        platform: "macos-launch-agent"
      };
    } catch (error) {
      if (!isMissingService(error)) throw error;
      try {
        await readFile(join(this.launchAgentsDirectory, `${label}.plist`));
        return { state: "stopped", platform: "macos-launch-agent" };
      } catch (fileError) {
        if (isMissingFile(fileError)) {
          return { state: "not_installed", platform: "macos-launch-agent" };
        }
        throw fileError;
      }
    }
  }

  async restart(identity: AgentHostBackgroundIdentity): Promise<AgentHostBackgroundResult> {
    const { workspaceId } = identity;
    const label = launchAgentLabel(workspaceId);
    const status = await this.status(identity);
    if (status.state === "not_installed") return status;
    const domain = this.domain();
    if (status.state === "stopped") {
      await this.runner("launchctl", [
        "bootstrap",
        domain,
        join(this.launchAgentsDirectory, `${label}.plist`)
      ]);
    }
    await this.runner("launchctl", ["kickstart", "-k", `${domain}/${label}`]);
    return { state: "running", platform: "macos-launch-agent" };
  }

  async logs({
    workspaceId,
    privateDirectory
  }: AgentHostBackgroundIdentity): Promise<AgentHostBackgroundLogs> {
    const directory = this.logDirectories.get(workspaceId) ?? privateDirectory;
    return {
      platform: "macos-launch-agent",
      source: "launch-agent-files",
      stdoutPath: join(directory, "agent-host.stdout.log"),
      stderrPath: join(directory, "agent-host.stderr.log")
    };
  }

  private domain(): string {
    const uid = this.getUid();
    if (!Number.isSafeInteger(uid) || (uid ?? -1) < 0) {
      throw new AgentHostBackgroundSetupError("check_launch_agent_permissions");
    }
    return `gui/${uid}`;
  }

  private async bootstrap(domain: string, path: string, replacedExistingService: boolean) {
    let retriesRemaining = launchAgentReplacementBootstrapRetries;
    for (;;) {
      try {
        await this.runner("launchctl", ["bootstrap", domain, path]);
        return;
      } catch (error) {
        if (
          !replacedExistingService ||
          !isTransientBootstrapFailure(error) ||
          retriesRemaining === 0
        ) {
          throw error;
        }
        retriesRemaining -= 1;
        await this.waitForReplacement();
      }
    }
  }
}

export {
  launchAgentLabel as macosAgentHostLaunchAgentLabel,
  launchAgentPlist as macosAgentHostLaunchAgentPlist
};
