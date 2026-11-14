import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { agentProcessEnv, resolveWindowsProcessInvocation } from "@planweave-ai/runtime";
import type { CliInstallation, CommandInstallation } from "../shared/cliInstallation.js";
import { readPosixShellEnvironment } from "./agentShellEnvironment.js";

async function resolvePosixCommand(
  command: string,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  for (const directory of (env.PATH ?? "").split(":")) {
    if (!isAbsolute(directory)) continue;
    const path = join(directory, command);
    try {
      await access(path, constants.X_OK);
      return path;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        !["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))
      )
        throw error;
    }
  }
  return null;
}

async function probeCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  absentStatus: "missing" | "unknown"
): Promise<CommandInstallation> {
  const invocation =
    process.platform === "win32"
      ? resolveWindowsProcessInvocation({ command, args: ["--version"], env })
      : null;
  const path =
    process.platform === "win32"
      ? (invocation?.target.executable ?? null)
      : await resolvePosixCommand(command, env);
  if (!path) return { status: absentStatus };
  return new Promise((resolve) => {
    execFile(
      invocation?.command ?? path,
      invocation?.args ?? ["--version"],
      {
        env,
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        windowsVerbatimArguments: invocation?.windowsVerbatimArguments ?? false
      },
      (error, stdout) => {
        if (error) {
          resolve({ status: "unavailable", path, error: error.message });
          return;
        }
        const version = stdout.trim();
        if (!/^v?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) {
          resolve({
            status: "unavailable",
            path,
            error: "The --version command did not return a valid version."
          });
          return;
        }
        resolve({ status: "available", path, version });
      }
    );
  });
}

export async function detectCliInstallation(): Promise<CliInstallation> {
  let env = agentProcessEnv();
  let shellEnvironmentError: string | null = null;
  if (process.platform !== "win32") {
    const shell = await readPosixShellEnvironment();
    if (shell.kind === "loaded") {
      env = agentProcessEnv({ env: { ...process.env, ...shell.environment } });
    } else {
      shellEnvironmentError = shell.reason;
    }
  }
  const absentStatus = shellEnvironmentError === null ? "missing" : "unknown";
  const [cli, node, npm] = await Promise.all([
    probeCommand("planweave", env, absentStatus),
    probeCommand("node", env, absentStatus),
    probeCommand("npm", env, absentStatus)
  ]);
  const nodeVersion = node.status === "available" ? node.version.replace(/^v/, "").split(".") : [];
  const major = Number(nodeVersion[0]);
  const minor = Number(nodeVersion[1]);
  return {
    cli,
    node,
    npm,
    nodeSupported: major > 22 || (major === 22 && minor >= 13),
    shellEnvironmentError
  };
}
