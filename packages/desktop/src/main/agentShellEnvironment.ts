import { execFile, type ExecFileException } from "node:child_process";
import { isAbsolute } from "node:path";
import { setAgentProcessEnvironmentOverlay } from "@planweave-ai/runtime";

const shellEnvironmentMarker = "PLANWEAVE_AGENT_SHELL_ENV_V1";
const defaultShellEnvironmentTimeoutMs = 5_000;
const maxShellEnvironmentBytes = 1024 * 1024;

type ShellEnvironmentRunnerOptions = {
  timeout: number;
  maxBuffer: number;
};

export type ShellEnvironmentRunner = (
  shell: string,
  args: readonly string[],
  options: ShellEnvironmentRunnerOptions
) => Promise<Buffer>;

export type PosixShellEnvironmentResult =
  | {
      kind: "loaded";
      shell: string;
      environment: Record<string, string>;
    }
  | {
      kind: "unavailable";
      shell: string;
      reason: string;
    };

const runShellEnvironmentCommand: ShellEnvironmentRunner = (shell, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      shell,
      [...args],
      {
        encoding: null,
        timeout: options.timeout,
        killSignal: "SIGKILL",
        maxBuffer: options.maxBuffer
      },
      (error, stdout) => {
        if (error) {
          reject(new Error(shellCommandDiagnostic(error, options.timeout)));
          return;
        }
        resolve(stdout);
      }
    );
  });

function shellCommandDiagnostic(error: ExecFileException, timeoutMs: number): string {
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return "Login shell output exceeded the size limit.";
  }
  if (error.killed) return `Login shell timed out after ${timeoutMs} ms.`;
  if (error.signal) return `Login shell was terminated by ${error.signal}.`;
  if (typeof error.code === "number") return `Login shell exited with code ${error.code}.`;
  return error.code
    ? `Login shell failed to start (${error.code}).`
    : "Login shell failed to start.";
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseShellEnvironment(stdout: Buffer): Record<string, string> {
  const marker = Buffer.from(`\0${shellEnvironmentMarker}\0`);
  const markerIndex = stdout.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error("Login shell output did not contain the environment marker.");
  }
  const payload = stdout.subarray(markerIndex + marker.length).toString("utf8");
  const environment: Record<string, string> = {};
  for (const entry of payload.split("\0")) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0) continue;
    const name = entry.slice(0, separatorIndex);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    environment[name] = entry.slice(separatorIndex + 1);
  }
  if (Object.keys(environment).length === 0) {
    throw new Error("Login shell returned an empty environment.");
  }
  return environment;
}

export async function readPosixShellEnvironment(options?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runner?: ShellEnvironmentRunner;
  timeoutMs?: number;
}): Promise<PosixShellEnvironmentResult> {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const shell = env.SHELL ?? (platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  if (!isAbsolute(shell)) {
    return {
      kind: "unavailable",
      shell,
      reason: `Could not read agent environment: login shell path '${shell}' is not absolute.`
    };
  }
  const command = `printf '\\0${shellEnvironmentMarker}\\0'; /usr/bin/env -0`;
  try {
    const stdout = await (options?.runner ?? runShellEnvironmentCommand)(
      shell,
      ["-l", "-i", "-c", command],
      {
        timeout: options?.timeoutMs ?? defaultShellEnvironmentTimeoutMs,
        maxBuffer: maxShellEnvironmentBytes
      }
    );
    return {
      kind: "loaded",
      shell,
      environment: parseShellEnvironment(stdout)
    };
  } catch (error) {
    return {
      kind: "unavailable",
      shell,
      reason: `Could not read agent environment from login shell '${shell}': ${diagnostic(error)}`
    };
  }
}

export async function configureDesktopAgentShellEnvironment(): Promise<PosixShellEnvironmentResult> {
  const result = await readPosixShellEnvironment();
  if (result.kind === "loaded") {
    setAgentProcessEnvironmentOverlay(result.environment);
  }
  return result;
}
