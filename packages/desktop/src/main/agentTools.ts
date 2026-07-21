import { execFile, type ExecFileOptions } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  resolveWindowsProcessInvocation,
  type DesktopAgentDetection,
  type DesktopAgentToolProfile
} from "@planweave-ai/runtime";

const posixAgentPathEntries = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
const agentVersionDetectionTimeoutMs = 5_000;
const agentAcpDetectionTimeoutMs = 15_000;

const agentProfiles: DesktopAgentToolProfile[] = [
  {
    kind: "codex",
    runnerKind: "cli",
    name: "Codex",
    command: "codex",
    versionArgs: ["--version"],
    execArgs: ["exec", "-"],
    fullAccessArgs: ["exec", "--sandbox", "danger-full-access", "-"],
    loginCommands: ["codex login"]
  },
  {
    kind: "claude-code",
    runnerKind: "cli",
    name: "Claude Code",
    command: "claude",
    versionArgs: ["--version"],
    execArgs: ["-p"],
    fullAccessArgs: ["--dangerously-skip-permissions", "-p"],
    loginCommands: ["claude auth login"]
  },
  {
    kind: "opencode",
    runnerKind: "cli",
    name: "OpenCode",
    command: "opencode",
    versionArgs: ["--version"],
    execArgs: ["run", "-"],
    fullAccessArgs: ["run", "--auto", "-"],
    loginCommands: ["opencode auth login"]
  },
  {
    kind: "pi",
    runnerKind: "cli",
    name: "Pi",
    command: "pi",
    versionArgs: ["--version"],
    execArgs: ["-p"],
    fullAccessArgs: ["-p"]
  },
  {
    kind: "grok",
    runnerKind: "cli",
    name: "Grok",
    command: "grok",
    versionArgs: ["--version"],
    execArgs: ["--no-auto-update", "--prompt-file"],
    fullAccessArgs: ["--always-approve", "--no-auto-update", "--prompt-file"],
    loginCommands: ["grok auth login"]
  },
  {
    kind: "codex",
    runnerKind: "acp",
    name: "Codex",
    command: "codex-acp",
    versionArgs: [],
    execArgs: [],
    fullAccessArgs: [],
    installCommand: "npm install -g @agentclientprotocol/codex-acp",
    loginCommands: ["codex login"]
  },
  {
    kind: "claude-code",
    runnerKind: "acp",
    name: "Claude Code",
    command: "claude-agent-acp",
    versionArgs: [],
    execArgs: [],
    fullAccessArgs: [],
    installCommand: "npm install -g @agentclientprotocol/claude-agent-acp",
    loginCommands: ["claude auth login"]
  },
  {
    kind: "opencode",
    runnerKind: "acp",
    name: "OpenCode",
    command: "opencode",
    versionArgs: ["acp", "--help"],
    reportsVersion: false,
    execArgs: ["acp"],
    fullAccessArgs: [],
    loginCommands: ["opencode auth login"]
  },
  {
    kind: "pi",
    runnerKind: "acp",
    name: "Pi",
    command: "pi-acp",
    versionArgs: [],
    execArgs: [],
    fullAccessArgs: [],
    installCommand: "npm install -g pi-acp"
  },
  {
    kind: "grok",
    runnerKind: "acp",
    name: "Grok",
    command: "grok",
    versionArgs: ["--no-auto-update", "agent", "stdio", "--help"],
    reportsVersion: false,
    execArgs: ["--no-auto-update", "agent", "stdio"],
    fullAccessArgs: [],
    loginCommands: ["grok auth login"]
  }
];

function environmentValue(
  env: NodeJS.ProcessEnv | undefined,
  name: string
): string | undefined {
  if (!env) {
    return undefined;
  }
  return Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function pathDelimiterFor(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

export type AgentDetectionPathOptions = {
  envPath?: string | undefined;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};

/**
 * Build the PATH used for agent CLI/ACP detection.
 * Uses the platform path delimiter. POSIX hosts may append common shell fallbacks;
 * Windows relies only on the process environment PATH (no guessed install locations).
 */
export function agentDetectionPath(
  envPathOrOptions?: string | AgentDetectionPathOptions,
  platformArg: NodeJS.Platform = process.platform
): string {
  const options: AgentDetectionPathOptions =
    typeof envPathOrOptions === "string" || envPathOrOptions === undefined
      ? { envPath: envPathOrOptions, platform: platformArg }
      : envPathOrOptions;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathDelimiter = pathDelimiterFor(platform);
  const source =
    options.envPath ?? environmentValue(env, "PATH") ?? environmentValue(process.env, "PATH");
  const existingEntries = source?.split(pathDelimiter).filter(Boolean) ?? [];
  const fallbackEntries = platform === "win32" ? [] : posixAgentPathEntries;
  return [...new Set([...existingEntries, ...fallbackEntries])].join(pathDelimiter);
}

/**
 * Build a process env for agent detection with a single, correctly cased PATH entry.
 * On Windows this avoids leaving both `Path` and a broken `PATH` in the child environment.
 */
export function agentDetectionEnv(options?: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const platform = options?.platform ?? process.platform;
  const baseEnv = options?.env ?? process.env;
  const pathValue = agentDetectionPath({
    platform,
    env: baseEnv,
    envPath: environmentValue(baseEnv, "PATH")
  });
  const nextEnv: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of Object.keys(nextEnv)) {
    if (key.toLowerCase() === "path") {
      delete nextEnv[key];
    }
  }
  if (platform === "win32") {
    nextEnv.Path = pathValue;
  } else {
    nextEnv.PATH = pathValue;
  }
  return nextEnv;
}

function execFileText(
  command: string,
  args: string[],
  options: ExecFileOptions
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function executableAvailable(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  if (platform === "win32") {
    return resolveWindowsProcessInvocation({ command, env }) !== null;
  }
  const candidates = isAbsolute(command)
    ? [command]
    : agentDetectionPath({ env, platform })
        .split(pathDelimiterFor(platform))
        .map((entry) => join(entry, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function runAgentProbe(
  command: string,
  args: string[],
  options: ExecFileOptions,
  platform: NodeJS.Platform = process.platform
): Promise<{ stdout: string; stderr: string }> {
  if (platform !== "win32") {
    return execFileText(command, args, options);
  }
  const invocation = resolveWindowsProcessInvocation({
    command,
    args,
    env: options.env as NodeJS.ProcessEnv | undefined
  });
  if (!invocation) {
    throw Object.assign(new Error(`Command '${command}' was not found on PATH.`), {
      code: "ENOENT"
    });
  }
  return execFileText(invocation.command, invocation.args, {
    ...options,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true
  });
}

function missingExecutableReason(profile: DesktopAgentToolProfile): string {
  const missing = `Command '${profile.command}' was not found on PATH.`;
  if (profile.installCommand) {
    return `${missing} Install the ACP adapter, then click Refresh: ${profile.installCommand}`;
  }
  return missing;
}

async function detectAgent(
  profile: DesktopAgentToolProfile,
  platform: NodeJS.Platform = process.platform
): Promise<DesktopAgentDetection> {
  const env = agentDetectionEnv({ platform });
  try {
    if (profile.versionArgs.length === 0) {
      const installed = await executableAvailable(profile.command, env, platform);
      return {
        ...profile,
        installed,
        version: null,
        unavailableReason: installed ? null : missingExecutableReason(profile)
      };
    }
    const { stdout, stderr } = await runAgentProbe(profile.command, profile.versionArgs, {
      env,
      timeout:
        profile.runnerKind === "acp" ? agentAcpDetectionTimeoutMs : agentVersionDetectionTimeoutMs,
      maxBuffer: 64 * 1024
    }, platform);
    const version = `${stdout}${stderr}`.trim().split(/\r?\n/)[0] ?? "";
    return {
      ...profile,
      installed: true,
      version: profile.reportsVersion === false ? null : version || null,
      unavailableReason: null
    };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    const looksMissing =
      /not found|ENOENT|was not found/i.test(message) || message.includes(profile.command);
    return {
      ...profile,
      installed: false,
      version: null,
      unavailableReason:
        looksMissing && profile.installCommand ? missingExecutableReason(profile) : message
    };
  }
}

export async function detectAgentTools(
  platform: NodeJS.Platform = process.platform
): Promise<DesktopAgentDetection[]> {
  return Promise.all(agentProfiles.map((profile) => detectAgent(profile, platform)));
}
