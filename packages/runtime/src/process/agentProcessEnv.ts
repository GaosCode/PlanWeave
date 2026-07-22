import { homedir } from "node:os";
import { join } from "node:path";

const posixSystemPathEntries = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
let agentProcessEnvironmentOverlay: Readonly<NodeJS.ProcessEnv> | null = null;

function environmentValue(env: NodeJS.ProcessEnv | undefined, name: string): string | undefined {
  if (!env) {
    return undefined;
  }
  return Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function pathDelimiterFor(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function posixUserPathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const homeDirectory = environmentValue(env, "HOME") ?? homedir();
  const entries = [
    join(homeDirectory, ".local", "bin"),
    join(homeDirectory, ".grok", "bin"),
    join(homeDirectory, ".opencode", "bin"),
    join(homeDirectory, ".bun", "bin"),
    join(homeDirectory, ".volta", "bin"),
    join(homeDirectory, ".asdf", "shims"),
    join(homeDirectory, ".local", "share", "mise", "shims"),
    join(homeDirectory, ".proto", "shims"),
    join(homeDirectory, ".cargo", "bin"),
    join(homeDirectory, ".npm-global", "bin")
  ];
  if (platform === "darwin") entries.push(join(homeDirectory, "Library", "pnpm"));
  return entries;
}

function definedEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function mergedAgentProcessEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): NodeJS.ProcessEnv {
  if (!agentProcessEnvironmentOverlay) return baseEnv;
  const overlayPath = environmentValue(agentProcessEnvironmentOverlay, "PATH");
  const basePath = environmentValue(baseEnv, "PATH");
  return {
    ...definedEnvironment(agentProcessEnvironmentOverlay),
    ...definedEnvironment(baseEnv),
    PATH: [overlayPath, basePath].filter(Boolean).join(pathDelimiterFor(platform))
  };
}

/**
 * Configures environment discovered by a desktop host from the user's login shell.
 * The overlay is isolated to agent child processes and never mutates process.env.
 */
export function setAgentProcessEnvironmentOverlay(environment: NodeJS.ProcessEnv | null): void {
  agentProcessEnvironmentOverlay = environment
    ? Object.freeze(definedEnvironment(environment))
    : null;
}

export type AgentProcessPathOptions = {
  envPath?: string | undefined;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};

/**
 * PATH used to resolve agent CLI / ACP binaries.
 * Uses the platform delimiter. POSIX hosts may append common shell install locations;
 * Windows uses only the process environment PATH (no guessed install directories).
 */
export function agentProcessPath(
  envPathOrOptions?: string | AgentProcessPathOptions,
  platformArg: NodeJS.Platform = process.platform
): string {
  const options: AgentProcessPathOptions =
    typeof envPathOrOptions === "string" || envPathOrOptions === undefined
      ? { envPath: envPathOrOptions, platform: platformArg }
      : envPathOrOptions;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathDelimiter = pathDelimiterFor(platform);
  const source =
    options.envPath ?? environmentValue(env, "PATH") ?? environmentValue(process.env, "PATH");
  const existingEntries = source?.split(pathDelimiter).filter(Boolean) ?? [];
  const fallbackEntries =
    platform === "win32" ? [] : [...posixUserPathEntries(env, platform), ...posixSystemPathEntries];
  return [...new Set([...existingEntries, ...fallbackEntries])].join(pathDelimiter);
}

/**
 * Environment for spawning agent / ACP processes.
 * On Windows, collapses Path/PATH to a single correctly cased entry.
 * On POSIX, appends common agent install directories when missing from PATH.
 */
export function agentProcessEnv(options?: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const platform = options?.platform ?? process.platform;
  const baseEnv =
    options?.env === undefined ? mergedAgentProcessEnvironment(process.env, platform) : options.env;
  const pathValue = agentProcessPath({
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

/** String-only env map for ACP spawn helpers that reject undefined values. */
export function agentProcessEnvRecord(options?: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(agentProcessEnv(options)).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );
}
