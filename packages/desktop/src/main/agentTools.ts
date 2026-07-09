import { execFile, type ExecFileOptions } from "node:child_process";
import type { DesktopAgentCliProfile, DesktopAgentDetection } from "@planweave-ai/runtime";

const agentPathEntries = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

const agentProfiles: DesktopAgentCliProfile[] = [
  {
    kind: "codex",
    name: "Codex",
    command: "codex",
    versionArgs: ["--version"],
    execArgs: ["exec", "-"],
    fullAccessArgs: ["exec", "--sandbox", "danger-full-access", "-"]
  },
  {
    kind: "claude-code",
    name: "Claude Code",
    command: "claude",
    versionArgs: ["--version"],
    execArgs: ["-p"],
    fullAccessArgs: ["--dangerously-skip-permissions", "-p"]
  },
  {
    kind: "opencode",
    name: "OpenCode",
    command: "opencode",
    versionArgs: ["--version"],
    execArgs: ["run", "-"],
    fullAccessArgs: ["run", "--auto", "-"]
  },
  {
    kind: "pi",
    name: "Pi",
    command: "pi",
    versionArgs: ["--version"],
    execArgs: ["-p"],
    fullAccessArgs: ["-p"]
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

async function detectAgent(profile: DesktopAgentCliProfile): Promise<DesktopAgentDetection> {
  try {
    const { stdout, stderr } = await execFileText(profile.command, profile.versionArgs, {
      env: { ...process.env, PATH: agentDetectionPath() },
      timeout: 2_000,
      maxBuffer: 64 * 1024
    });
    const version = `${stdout}${stderr}`.trim().split(/\r?\n/)[0] ?? "";
    return {
      ...profile,
      installed: true,
      version: version || null,
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
