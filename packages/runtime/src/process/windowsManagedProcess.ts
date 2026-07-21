import { spawn, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ProcessTreePlatformAdapter,
  SpawnManagedProcessOptions
} from "./managedProcessTree.js";

export type WindowsJobOwnership = {
  name: string;
  markerPath: string;
  helperPath: string;
};

export type TaskKillSpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ReturnType<typeof spawn>;

export type WindowsProcessTreeAdapterOptions = {
  spawnTaskKill?: TaskKillSpawnFn;
  isAlive?: (pid: number) => boolean;
  job?: WindowsJobOwnership;
  terminateJob?: (job: WindowsJobOwnership) => void | Promise<void>;
};

export type ResolvedWindowsCommand = {
  executable: string;
  launchMode: "native" | "batch";
};

export type WindowsJobLaunchStrategy = "suspended-target-assignment" | "launcher-job-inheritance";

export const DEFAULT_WINDOWS_JOB_LAUNCH_STRATEGY: WindowsJobLaunchStrategy =
  "suspended-target-assignment";

function errnoCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function assertSafeManagedPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid managed process pid: ${String(pid)}`);
  }
  if (pid === process.pid) {
    throw new Error("Refusing to terminate the current PlanWeave process.");
  }
}

function windowsRootIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

export function windowsTaskKillArgs(pid: number, force: boolean): string[] {
  assertSafeManagedPid(pid);
  return force ? ["/pid", String(pid), "/t", "/f"] : ["/pid", String(pid), "/t"];
}

function runTaskKill(
  pid: number,
  force: boolean,
  options: { spawnTaskKill: TaskKillSpawnFn; isAlive: (pid: number) => boolean }
): Promise<void> {
  assertSafeManagedPid(pid);
  return new Promise((resolvePromise, reject) => {
    const child = options.spawnTaskKill("taskkill", windowsTaskKillArgs(pid, force), {
      stdio: "ignore",
      windowsHide: true,
      shell: false
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      let stillAlive: boolean;
      try {
        stillAlive = options.isAlive(pid);
      } catch (error) {
        reject(error);
        return;
      }
      reject(
        Object.assign(
          new Error(
            `taskkill ${force ? "force" : "graceful"} failed for pid=${String(pid)} (exit ${String(code)}).`
          ),
          { code: stillAlive ? "EPERM" : "ECHILD" }
        )
      );
    });
  });
}

export function createWindowsProcessTreeAdapter(
  options: WindowsProcessTreeAdapterOptions = {}
): ProcessTreePlatformAdapter {
  const spawnTaskKill = options.spawnTaskKill ?? spawn;
  const isAlive = options.isAlive ?? windowsRootIsAlive;
  const terminateJob = options.terminateJob ?? terminateWindowsJob;
  return {
    name: "windows",
    configureSpawn(spawnOptions) {
      return { ...spawnOptions, detached: false, shell: false, windowsHide: true };
    },
    signalGraceful(pid) {
      return runTaskKill(pid, false, { spawnTaskKill, isAlive });
    },
    async signalForce(pid) {
      if (!options.job) {
        throw new Error("Windows managed process is missing named Job ownership.");
      }
      const failures: unknown[] = [];
      try {
        await terminateJob(options.job);
      } catch (error) {
        failures.push(error);
      }
      try {
        if (isAlive(pid)) {
          await runTaskKill(pid, true, { spawnTaskKill, isAlive });
        }
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          `Windows managed Job and launcher force termination failed for pid=${String(pid)}.`
        );
      }
    },
    isAlive
  };
}

function windowsJobHelperPath(): string {
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
  if (electronProcess.resourcesPath) {
    const packaged = resolve(electronProcess.resourcesPath, "planweave-windows-job-process.ps1");
    if (existsSync(packaged)) return packaged;
  }
  const modulePath = resolve(dirname(fileURLToPath(import.meta.url)), "windowsJobProcess.ps1");
  if (existsSync(modulePath)) return modulePath;
  throw new Error(
    `PlanWeave Windows Job helper is missing (checked ${modulePath}). Rebuild or reinstall @planweave-ai/runtime.`
  );
}

export function windowsPowerShellPath(): string {
  const systemRoot = Object.entries(process.env).find(
    ([name]) => name.toLowerCase() === "systemroot"
  )?.[1];
  if (systemRoot) {
    const candidate = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Windows PowerShell executable is missing from SystemRoot.");
}

function windowsCommandPromptPath(): string {
  const comSpec = environmentValue(process.env, "ComSpec");
  if (comSpec && existsSync(comSpec)) return resolve(comSpec);
  const systemRoot = environmentValue(process.env, "SystemRoot");
  if (systemRoot) {
    const candidate = join(systemRoot, "System32", "cmd.exe");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Windows command processor is missing from ComSpec/SystemRoot.");
}

export function createWindowsJobOwnership(): WindowsJobOwnership {
  const identity = randomUUID();
  return {
    name: `Local\\PlanWeave-${identity}`,
    markerPath: join(tmpdir(), `planweave-job-${identity}.owner`),
    helperPath: windowsJobHelperPath()
  };
}

function environmentValue(env: NodeJS.ProcessEnv | undefined, name: string): string | undefined {
  const configured = env
    ? Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
    : undefined;
  return (
    configured ??
    Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
  );
}

function executableExtensions(env: NodeJS.ProcessEnv | undefined): string[] {
  const configured = environmentValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD";
  return configured
    .split(";")
    .map((value) => value.trim().toLowerCase())
    .filter(
      (value) => value === ".com" || value === ".exe" || value === ".bat" || value === ".cmd"
    );
}

function commandCandidate(path: string): ResolvedWindowsCommand | null {
  if (!existsSync(path)) return null;
  const extension = extname(path).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    return { executable: resolve(path), launchMode: "batch" };
  }
  if (extension === ".com" || extension === ".exe") {
    return { executable: resolve(path), launchMode: "native" };
  }
  return null;
}

function resolveInDirectory(
  directory: string,
  command: string,
  extensions: readonly string[]
): ResolvedWindowsCommand | null {
  const base = isAbsolute(command) ? command : resolve(directory, command);
  const explicit = extname(command) ? commandCandidate(base) : null;
  if (explicit) return explicit;
  if (extname(command)) return null;
  for (const extension of extensions) {
    const candidate = commandCandidate(`${base}${extension}`);
    if (candidate) return candidate;
  }
  return null;
}

export function resolveWindowsCommand(
  options: Pick<SpawnManagedProcessOptions, "command" | "cwd" | "env">
): ResolvedWindowsCommand | null {
  const cwd = options.cwd ?? process.cwd();
  const extensions = executableExtensions(options.env);
  const hasDirectory = /[\\/:]/u.test(options.command);
  if (hasDirectory) return resolveInDirectory(cwd, options.command, extensions);

  if (!environmentValue(options.env, "NoDefaultCurrentDirectoryInExePath")) {
    const current = resolveInDirectory(cwd, options.command, extensions);
    if (current) return current;
  }
  for (const rawDirectory of (environmentValue(options.env, "PATH") ?? "").split(";")) {
    if (!rawDirectory) continue;
    const directory = rawDirectory.replace(/^(["'])(.*)\1$/u, "$2");
    const candidate = resolveInDirectory(cwd, join(directory, options.command), extensions);
    if (candidate) return candidate;
  }
  return null;
}

/**
 * Quote one Windows cmd.exe argument for `/d /s /c` short probes.
 * Spaces and cmd metacharacters are wrapped; embedded quotes are doubled.
 */
export function quoteWindowsCmdArgument(value: string): string {
  if (value.length === 0) {
    return '""';
  }
  if (!/[\t\n\v\f\r "&<>|^]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

export function windowsBatchCommandLine(executable: string, args: readonly string[]): string {
  return [quoteWindowsCmdArgument(executable), ...args.map(quoteWindowsCmdArgument)].join(" ");
}

export type WindowsProcessInvocation = {
  command: string;
  args: string[];
  target: ResolvedWindowsCommand;
  /** Required when args include a pre-quoted `/c` payload. */
  windowsVerbatimArguments: boolean;
};

/**
 * Resolve a short-lived Windows process invocation without Job ownership.
 * Native PE binaries run directly; `.cmd`/`.bat` run through `cmd.exe /d /s /c`.
 */
export function resolveWindowsProcessInvocation(options: {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): WindowsProcessInvocation | null {
  const target = resolveWindowsCommand({
    command: options.command,
    cwd: options.cwd,
    env: options.env
  });
  if (!target) {
    return null;
  }
  const args = options.args ? [...options.args] : [];
  if (target.launchMode === "native") {
    return {
      command: target.executable,
      args,
      target,
      windowsVerbatimArguments: false
    };
  }
  return {
    command: windowsCommandPromptPath(),
    args: ["/d", "/s", "/c", `"${windowsBatchCommandLine(target.executable, args)}"`],
    target,
    windowsVerbatimArguments: true
  };
}

export function windowsLauncherArgs(
  job: WindowsJobOwnership,
  target: ResolvedWindowsCommand,
  args: readonly string[],
  strategy: WindowsJobLaunchStrategy = DEFAULT_WINDOWS_JOB_LAUNCH_STRATEGY
): string[] {
  const payload = Buffer.from(
    JSON.stringify({
      command: target.executable,
      launchMode: target.launchMode,
      commandInterpreter: target.launchMode === "batch" ? windowsCommandPromptPath() : undefined,
      jobLaunchStrategy: strategy,
      args: [...args]
    }),
    "utf8"
  ).toString("base64");
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    job.helperPath,
    "-Mode",
    "launch",
    "-JobName",
    job.name,
    "-MarkerPath",
    job.markerPath,
    "-Payload",
    payload,
    "-ParentPid",
    String(process.pid)
  ];
}

function terminateWindowsJob(job: WindowsJobOwnership): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      windowsPowerShellPath(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        job.helperPath,
        "-Mode",
        "terminate",
        "-JobName",
        job.name,
        "-MarkerPath",
        job.markerPath
      ],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, shell: false }
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 16_384) stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        Object.assign(
          new Error(
            `Windows Job terminate failed for ${job.name} (exit ${String(code)}): ${stderr.trim() || "no diagnostic"}`
          ),
          { code: code === 2 ? "EPERM" : "ECHILD" }
        )
      );
    });
  });
}
