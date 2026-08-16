import { homedir } from "node:os";
import { join, win32 as windowsPath } from "node:path";
import {
  agentEnvironmentContractSchema,
  type AgentEnvironmentContract
} from "../acpProfile/schema.js";

const posixSystemPathEntries = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
let agentProcessEnvironmentOverlay: Readonly<NodeJS.ProcessEnv> | null = null;

function environmentValue(env: NodeJS.ProcessEnv | undefined, name: string): string | undefined {
  if (!env) {
    return undefined;
  }
  return Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function contractEnvironmentValue(
  env: Readonly<NodeJS.ProcessEnv> | undefined,
  name: string,
  platform: NodeJS.Platform
): string | undefined {
  if (!env) return undefined;
  if (platform !== "win32") return env[name];
  return environmentValue(env, name);
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

function windowsHomeDirectory(env: NodeJS.ProcessEnv): string {
  const profile = environmentValue(env, "USERPROFILE");
  if (profile) return profile;
  const homeDrive = environmentValue(env, "HOMEDRIVE");
  const homePath = environmentValue(env, "HOMEPATH");
  if (homeDrive && homePath) return windowsPath.join(homeDrive, homePath);
  return homedir();
}

/**
 * Packaged Electron / Task Scheduler hosts often inherit a short PATH that omits the
 * user npm/pnpm shim directories where ACP adapters like `pi-acp.cmd` are installed.
 */
function windowsUserPathEntries(env: NodeJS.ProcessEnv): string[] {
  const homeDirectory = windowsHomeDirectory(env);
  const appData =
    environmentValue(env, "APPDATA") ?? windowsPath.join(homeDirectory, "AppData", "Roaming");
  const localAppData =
    environmentValue(env, "LOCALAPPDATA") ?? windowsPath.join(homeDirectory, "AppData", "Local");
  return [
    windowsPath.join(appData, "npm"),
    windowsPath.join(localAppData, "pnpm"),
    windowsPath.join(homeDirectory, ".local", "bin"),
    windowsPath.join(homeDirectory, ".grok", "bin"),
    windowsPath.join(homeDirectory, ".opencode", "bin"),
    windowsPath.join(homeDirectory, ".bun", "bin"),
    windowsPath.join(homeDirectory, ".volta", "bin"),
    windowsPath.join(homeDirectory, ".cargo", "bin")
  ];
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

export type ResolvedAgentEnvironment = {
  readonly env: Readonly<Record<string, string>>;
  readonly availableNames: readonly string[];
};

export class AgentEnvironmentMissingError extends Error {
  readonly code = "agent_environment_missing";

  constructor(readonly missingNames: readonly string[]) {
    super(`Required agent environment variables are missing: ${missingNames.join(", ")}.`);
    this.name = "AgentEnvironmentMissingError";
  }
}

const windowsBaseEnvironmentNames = [
  "PATHEXT",
  "SYSTEMROOT",
  "COMSPEC",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TMP",
  "TEMP",
  "USERNAME"
] as const;
const posixBaseEnvironmentNames = ["HOME", "TMP", "TEMP"] as const;

/**
 * Materializes the minimal environment contract shared by local Runtime ACP profiles and Agent
 * Host profiles. Values remain process-local; callers may report names but must not persist values.
 */
export function resolveAgentProcessEnvironment(input: {
  platform: NodeJS.Platform;
  ambient: Readonly<NodeJS.ProcessEnv>;
  shellOverlay?: Readonly<NodeJS.ProcessEnv>;
  contract: AgentEnvironmentContract;
}): ResolvedAgentEnvironment {
  const contract = agentEnvironmentContractSchema.parse(input.contract);
  const env: Record<string, string> = {};
  const baseNames =
    input.platform === "win32" ? windowsBaseEnvironmentNames : posixBaseEnvironmentNames;
  for (const name of baseNames) {
    const value = contractEnvironmentValue(input.ambient, name, input.platform);
    if (value !== undefined) env[name] = value;
  }

  const ambientPath = contractEnvironmentValue(input.ambient, "PATH", input.platform);
  const overlayPath = contractEnvironmentValue(input.shellOverlay, "PATH", input.platform);
  const pathSource = [overlayPath, ambientPath]
    .filter((value): value is string => value !== undefined)
    .join(pathDelimiterFor(input.platform));
  const pathValue = agentProcessPath({
    platform: input.platform,
    env: { ...input.ambient },
    envPath: pathSource
  });
  env[input.platform === "win32" ? "Path" : "PATH"] = pathValue;

  const missingNames: string[] = [];
  for (const requirement of contract.variables) {
    const ambientValue = contractEnvironmentValue(input.ambient, requirement.name, input.platform);
    const value =
      ambientValue !== undefined
        ? ambientValue
        : contractEnvironmentValue(input.shellOverlay, requirement.name, input.platform);
    if (value === undefined) {
      if (requirement.required) missingNames.push(requirement.name);
      continue;
    }
    env[requirement.name] = value;
  }
  if (missingNames.length > 0) throw new AgentEnvironmentMissingError(missingNames);

  return Object.freeze({
    env: Object.freeze({ ...env }),
    availableNames: Object.freeze(Object.keys(env))
  });
}

/**
 * PATH used to resolve agent CLI / ACP binaries.
 * Uses the platform delimiter. POSIX and Windows hosts append common user install
 * locations (Homebrew/npm/pnpm shims) when missing from the process PATH.
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
    platform === "win32"
      ? windowsUserPathEntries(env)
      : [...posixUserPathEntries(env, platform), ...posixSystemPathEntries];
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
