import { execFile, spawn, type ExecFileOptions } from "node:child_process";
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

function execFileText(command: string, args: string[], options: ExecFileOptions): Promise<{ stdout: string; stderr: string }> {
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

export async function runAgentPrompt(input: { kind: DesktopAgentCliProfile["kind"]; cwd: string; prompt: string; fullAccess?: boolean; timeoutMs?: number }): Promise<{ output: string; version: string | null }> {
  const profile = agentProfiles.find((candidate) => candidate.kind === input.kind);
  if (!profile) throw new Error(`Unsupported Agent kind: ${input.kind}`);
  const detection = await detectAgent(profile);
  if (!detection.installed) throw new Error(`${profile.name} is not installed: ${detection.unavailableReason ?? "command unavailable"}`);
  const args = input.fullAccess ? profile.fullAccessArgs : profile.execArgs;
  return new Promise((resolve, reject) => {
    const child = spawn(profile.command, args, { cwd: input.cwd, env: { ...process.env, PATH: agentDetectionPath() }, stdio: ["pipe", "pipe", "pipe"], shell: false });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => { if (settled) return; settled = true; reject(error); };
    const maxBytes = 2 * 1024 * 1024;
    const append = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        child.kill("SIGTERM");
        fail(new Error(`${profile.name} output exceeded 2 MiB`));
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => { child.kill("SIGTERM"); fail(new Error(`${profile.name} validation timed out`)); }, input.timeoutMs ?? 10 * 60_000);
    child.once("error", (error) => { clearTimeout(timer); fail(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString("utf8").trim();
      if (settled) return;
      if (code !== 0) fail(new Error(`${profile.name} exited with code ${code}: ${output.slice(-4000)}`));
      else { settled = true; resolve({ output, version: detection.version }); }
    });
    child.stdin.end(input.prompt);
  });
}
