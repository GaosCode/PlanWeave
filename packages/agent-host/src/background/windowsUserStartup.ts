import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
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

const userRunKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const launcherFileName = "windows-user-startup.json";

const launcherSchema = z
  .object({
    executablePath: z.string().min(1),
    args: z.array(z.string()).max(32),
    marker: z.string().regex(/^[a-f0-9]{16}$/u)
  })
  .strict();

type WindowsUserStartupLauncher = z.infer<typeof launcherSchema>;
export type DetachedProcessStarter = (
  executablePath: string,
  args: readonly string[]
) => Promise<void>;

function registryValueName(workspaceId: string): string {
  const digest = createHash("sha256").update(workspaceId).digest("hex").slice(0, 16);
  return `PlanWeaveAgentHost-${digest}`;
}

function quoteWindowsCommand(value: string): string {
  if ([...value].some((character) => [0, 10, 13].includes(character.codePointAt(0) ?? -1))) {
    throw new Error("agent_host_background_startup_value_invalid");
  }
  const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1");
  return `"${escaped}"`;
}

function startupLauncher(input: AgentHostBackgroundInstall): WindowsUserStartupLauncher {
  const marker = registryValueName(input.workspaceId).slice(-16);
  return launcherSchema.parse({
    executablePath: input.executablePath,
    args: [
      ...(input.fixedArgs ?? []),
      "run",
      "--config",
      input.configPath,
      "--background-instance",
      marker
    ],
    marker
  });
}

function contractWindowsEnvironmentPath(value: string, environment: NodeJS.ProcessEnv): string {
  for (const [name, directory] of [
    ["LOCALAPPDATA", environment.LOCALAPPDATA],
    ["USERPROFILE", environment.USERPROFILE]
  ] as const) {
    if (!directory) continue;
    const normalizedDirectory = directory.replace(/[\\/]+$/u, "");
    if (
      value.localeCompare(normalizedDirectory, undefined, { sensitivity: "accent" }) === 0 ||
      value.toLocaleLowerCase().startsWith(`${normalizedDirectory.toLocaleLowerCase()}\\`)
    ) {
      return `%${name}%${value.slice(normalizedDirectory.length)}`;
    }
  }
  return value;
}

function startupCommand(
  launcher: WindowsUserStartupLauncher,
  environment: NodeJS.ProcessEnv = process.env
): string {
  const command = [launcher.executablePath, ...launcher.args]
    .map((value) => contractWindowsEnvironmentPath(value, environment))
    .map(quoteWindowsCommand)
    .join(" ");
  if (command.length > 260) throw new Error("agent_host_background_startup_command_too_long");
  return command;
}

function launcherPath(privateDirectory: string): string {
  return join(privateDirectory, launcherFileName);
}

async function readLauncher(privateDirectory: string): Promise<WindowsUserStartupLauncher> {
  return launcherSchema.parse(JSON.parse(await readFile(launcherPath(privateDirectory), "utf8")));
}

function processErrorCode(error: unknown): number | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "number"
    ? error.code
    : undefined;
}

const PROCESS_STATE_SCRIPT = [
  "$ErrorActionPreference='Stop';",
  "$marker=$env:PLANWEAVE_AGENT_HOST_INSTANCE;",
  "$found=@(Get-CimInstance Win32_Process | Where-Object {",
  "  $_.CommandLine -and $_.CommandLine.Contains('--background-instance') -and $_.CommandLine.Contains($marker)",
  "}).Count -gt 0;",
  "[Console]::Out.Write($(if($found){'1'}else{'0'}))"
].join("");

const STOP_PROCESS_SCRIPT = [
  "$ErrorActionPreference='Stop';",
  "$marker=$env:PLANWEAVE_AGENT_HOST_INSTANCE;",
  "Get-CimInstance Win32_Process | Where-Object {",
  "  $_.CommandLine -and $_.CommandLine.Contains('--background-instance') -and $_.CommandLine.Contains($marker)",
  "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }"
].join("");

const startDetachedProcess: DetachedProcessStarter = async (executablePath, args) => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executablePath, [...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
};

export class WindowsUserStartupService implements AgentHostBackgroundService {
  constructor(
    private readonly runner: FixedArgvRunner = runFixedArgv,
    private readonly starter: DetachedProcessStarter = startDetachedProcess,
    private readonly environment: NodeJS.ProcessEnv = process.env
  ) {}

  async install(input: AgentHostBackgroundInstall): Promise<AgentHostBackgroundResult> {
    const launcher = startupLauncher(input);
    const valueName = registryValueName(input.workspaceId);
    try {
      await writePrivateTextFile(launcherPath(input.privateDirectory), JSON.stringify(launcher));
      await this.runner("reg.exe", [
        "ADD",
        userRunKey,
        "/V",
        valueName,
        "/T",
        "REG_EXPAND_SZ",
        "/D",
        startupCommand(launcher, this.environment),
        "/F"
      ]);
      await this.stop(input.workspaceId);
      await this.starter(launcher.executablePath, launcher.args);
      return { state: "running", platform: "windows-user-startup" };
    } catch (error) {
      throw new AgentHostBackgroundSetupError("run_agent_host_manually", { cause: error });
    }
  }

  async uninstall(identity: AgentHostBackgroundIdentity): Promise<AgentHostBackgroundResult> {
    await this.stop(identity.workspaceId);
    try {
      await this.runner("reg.exe", [
        "DELETE",
        userRunKey,
        "/V",
        registryValueName(identity.workspaceId),
        "/F"
      ]);
    } catch (error) {
      if (processErrorCode(error) !== 1) throw error;
    }
    try {
      await unlink(launcherPath(identity.privateDirectory));
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    return { state: "not_installed", platform: "windows-user-startup" };
  }

  async status(
    identity: AgentHostBackgroundIdentity,
    options?: AgentHostBackgroundStatusOptions
  ): Promise<AgentHostBackgroundResult> {
    try {
      await this.runner(
        "reg.exe",
        ["QUERY", userRunKey, "/V", registryValueName(identity.workspaceId)],
        ...(options ? [options] : [])
      );
    } catch (error) {
      if (processErrorCode(error) === 1) {
        return { state: "not_installed", platform: "windows-user-startup" };
      }
      throw error;
    }
    const result = await this.runner(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", PROCESS_STATE_SCRIPT],
      {
        ...options,
        environment: {
          PLANWEAVE_AGENT_HOST_INSTANCE: registryValueName(identity.workspaceId).slice(-16)
        }
      }
    );
    return {
      state: result.stdout.trim() === "1" ? "running" : "stopped",
      platform: "windows-user-startup"
    };
  }

  async restart(identity: AgentHostBackgroundIdentity): Promise<AgentHostBackgroundResult> {
    const status = await this.status(identity);
    if (status.state === "not_installed") return status;
    await this.stop(identity.workspaceId);
    const launcher = await readLauncher(identity.privateDirectory);
    await this.starter(launcher.executablePath, launcher.args);
    return { state: "running", platform: "windows-user-startup" };
  }

  async logs(identity: AgentHostBackgroundIdentity): Promise<AgentHostBackgroundLogs> {
    return {
      platform: "windows-user-startup",
      source: "user-startup-diagnostics",
      registryValueName: registryValueName(identity.workspaceId),
      capturesHostStdout: false
    };
  }

  private async stop(workspaceId: string): Promise<void> {
    await this.runner(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", STOP_PROCESS_SCRIPT],
      { environment: { PLANWEAVE_AGENT_HOST_INSTANCE: registryValueName(workspaceId).slice(-16) } }
    );
  }
}

export {
  registryValueName as windowsAgentHostRegistryValueName,
  startupCommand as windowsAgentHostStartupCommand
};
