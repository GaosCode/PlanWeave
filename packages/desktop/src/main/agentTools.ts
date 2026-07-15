import { execFile, type ExecFileOptions } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import type { DesktopAgentDetection, DesktopAgentToolProfile } from "@planweave-ai/runtime";

const agentPathEntries = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
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
    fullAccessArgs: ["exec", "--sandbox", "danger-full-access", "-"]
  },
  {
    kind: "claude-code",
    runnerKind: "cli",
    name: "Claude Code",
    command: "claude",
    versionArgs: ["--version"],
    execArgs: ["-p"],
    fullAccessArgs: ["--dangerously-skip-permissions", "-p"]
  },
  {
    kind: "opencode",
    runnerKind: "cli",
    name: "OpenCode",
    command: "opencode",
    versionArgs: ["--version"],
    execArgs: ["run", "-"],
    fullAccessArgs: ["run", "--auto", "-"]
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
    kind: "codex",
    runnerKind: "acp",
    name: "Codex",
    command: "codex-acp",
    versionArgs: [],
    execArgs: [],
    fullAccessArgs: []
  },
  {
    kind: "claude-code",
    runnerKind: "acp",
    name: "Claude Code",
    command: "claude-agent-acp",
    versionArgs: [],
    execArgs: [],
    fullAccessArgs: []
  },
  {
    kind: "opencode",
    runnerKind: "acp",
    name: "OpenCode",
    command: "opencode",
    versionArgs: ["acp", "--help"],
    reportsVersion: false,
    execArgs: ["acp"],
    fullAccessArgs: []
  },
  {
    kind: "pi",
    runnerKind: "acp",
    name: "Pi",
    command: "pi-acp",
    versionArgs: [],
    execArgs: [],
    fullAccessArgs: []
  },
  {
    kind: "grok",
    runnerKind: "acp",
    name: "Grok",
    command: "grok",
    versionArgs: ["--no-auto-update", "agent", "stdio", "--help"],
    reportsVersion: false,
    execArgs: ["--no-auto-update", "agent", "stdio"],
    fullAccessArgs: []
  }
];

export function agentDetectionPath(envPath = process.env.PATH): string {
  const existingEntries = envPath?.split(":").filter(Boolean) ?? [];
  return [...new Set([...existingEntries, ...agentPathEntries])].join(":");
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

async function executableAvailable(command: string): Promise<boolean> {
  const candidates = isAbsolute(command)
    ? [command]
    : agentDetectionPath()
        .split(delimiter)
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

async function detectAgent(profile: DesktopAgentToolProfile): Promise<DesktopAgentDetection> {
  try {
    if (profile.versionArgs.length === 0) {
      const installed = await executableAvailable(profile.command);
      return {
        ...profile,
        installed,
        version: null,
        unavailableReason: installed ? null : `Executable '${profile.command}' was not found.`
      };
    }
    const { stdout, stderr } = await execFileText(profile.command, profile.versionArgs, {
      env: { ...process.env, PATH: agentDetectionPath() },
      timeout:
        profile.runnerKind === "acp" ? agentAcpDetectionTimeoutMs : agentVersionDetectionTimeoutMs,
      maxBuffer: 64 * 1024
    });
    const version = `${stdout}${stderr}`.trim().split(/\r?\n/)[0] ?? "";
    return {
      ...profile,
      installed: true,
      version: profile.reportsVersion === false ? null : version || null,
      unavailableReason: null
    };
  } catch (caught) {
    return {
      ...profile,
      installed: false,
      version: null,
      unavailableReason: caught instanceof Error ? caught.message : String(caught)
    };
  }
}

export async function detectAgentTools(): Promise<DesktopAgentDetection[]> {
  return Promise.all(agentProfiles.map(detectAgent));
}
