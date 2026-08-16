import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { promisify } from "node:util";
import {
  ACP_SDK_AUTHORITY,
  DEFAULT_ACP_SHUTDOWN_POLICY,
  probeInstalledAcpAgent,
  resolveAgentDefinition,
  resolveWindowsProcessInvocation,
  type AcpPreflightProbeResult
} from "@planweave-ai/runtime";
import type { ResolvedAcpProfile } from "@planweave-ai/runtime";
import type { RealAcpGate, RealAcpPrecondition } from "./gate.js";
import { precondition } from "./gate.js";
import { resolveRealAcpHostProfile, type ResolvedRealAcpHostProfile } from "./resolveProfile.js";

const execFileAsync = promisify(execFile);

/**
 * Durable smoke evidence never stores absolute Host executable paths.
 * Use basename-only command labels (or "unresolved") so evidence JSON is portable and non-leaking.
 */
export function evidenceCommandLabel(commandPath: string): string {
  if (!commandPath || commandPath === "unresolved") return "unresolved";
  const leaf = basename(commandPath.replace(/\\/g, "/"));
  return leaf.length > 0 ? leaf : "unresolved";
}

export type RealAcpPreflightEvidence = {
  profileId: string;
  agentId: string;
  /**
   * Basename-only command label for evidence (never an absolute Host path).
   * Runtime resolution still uses the full local path internally.
   */
  commandPath: string;
  /** Non-secret version string from --version or agentInfo; never credentials. */
  agentVersion: string | null;
  verifiedAdapterVersion: string;
  protocolVersion: typeof ACP_SDK_AUTHORITY.protocolVersion;
  sdkPackageVersion: typeof ACP_SDK_AUTHORITY.packageVersion;
  capabilities: readonly string[];
  authenticationStatus: string;
  agentInfoName: string | null;
};

export type RealAcpPreflightOutcome =
  | { status: "ready"; profile: ResolvedRealAcpHostProfile; evidence: RealAcpPreflightEvidence }
  | {
      status: "precondition";
      precondition: RealAcpPrecondition;
      evidence?: RealAcpPreflightEvidence;
    };

type VersionProbeRunner = (
  command: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    shell: false;
    windowsVerbatimArguments: boolean;
    cwd: string | undefined;
    env: NodeJS.ProcessEnv;
  }
) => Promise<{ stdout: string; stderr: string }>;

const runVersionProbe: VersionProbeRunner = async (command, args, options) => {
  const result = await execFileAsync(command, args, options);
  return { stdout: result.stdout, stderr: result.stderr };
};

export async function probeAgentVersion(options: {
  commandPath: string;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  run?: VersionProbeRunner;
  resolveWindowsInvocation?: typeof resolveWindowsProcessInvocation;
}): Promise<string | null> {
  try {
    const platform = options.platform ?? process.platform;
    const env = { ...(options.env ?? process.env) };
    const invocation =
      platform === "win32"
        ? (options.resolveWindowsInvocation ?? resolveWindowsProcessInvocation)({
            command: options.commandPath,
            args: ["--version"],
            cwd: options.cwd,
            env
          })
        : {
            command: options.commandPath,
            args: ["--version"],
            windowsVerbatimArguments: false
          };
    if (!invocation) return null;
    const result = await (options.run ?? runVersionProbe)(invocation.command, invocation.args, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      cwd: options.cwd,
      env
    });
    const text = `${result.stdout}${result.stderr}`.trim();
    return text.length > 0 ? text.split(/\r?\n/, 1)[0]!.slice(0, 256) : null;
  } catch {
    return null;
  }
}

function authenticationStatus(probe: AcpPreflightProbeResult): string {
  if (probe.kind === "ready") return probe.authentication.status;
  if (probe.kind === "auth_required") return `action_required:${probe.authentication.reason}`;
  if (probe.kind === "interaction_required") return `interaction_required:${probe.interaction}`;
  return "failed";
}

function redactProbeMessage(message: string): string {
  // Never surface env values or absolute home paths in actionable messages.
  return message
    .replace(/\/Users\/[^/\s]+/g, "/Users/<redacted>")
    .replace(/\/home\/[^/\s]+/g, "/home/<redacted>")
    .replace(/[A-Za-z0-9_-]{20,}/g, (token) =>
      /^(PLANWEAVE_|ACP_|error_|agent_)/.test(token) ? token : "<redacted>"
    )
    .slice(0, 512);
}

export async function preflightRealAcp(options: {
  gate: RealAcpGate;
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  pathEnv?: string;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
}): Promise<RealAcpPreflightOutcome> {
  const resolved = await resolveRealAcpHostProfile({
    gate: options.gate,
    env: options.env,
    pathEnv: options.pathEnv,
    platform: options.platform
  });
  if (resolved.status === "precondition") {
    return { status: "precondition", precondition: resolved.precondition };
  }

  const { profile } = resolved;
  const versionOutput = await probeAgentVersion({
    commandPath: profile.commandPath,
    cwd: options.cwd,
    env: options.env,
    platform: options.platform
  });
  profile.versionOutput = versionOutput;

  const definition = resolveAgentDefinition(profile.supported.agentId);
  const resolvedProfile: ResolvedAcpProfile = {
    profileId: profile.supported.profileId,
    agentId: profile.supported.agentId,
    displayName: profile.supported.displayName,
    host: { kind: "native" },
    launch: { command: profile.commandPath, args: profile.hostProfile.launch.args },
    environment: profile.supported.environment,
    shutdown: DEFAULT_ACP_SHUTDOWN_POLICY,
    capabilities: {
      required: definition.acp.capabilities,
      optional: definition.acp.optionalCapabilities
    },
    connection: { mode: "dedicated" },
    source: "builtin",
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          profileId: profile.supported.profileId,
          agentId: profile.supported.agentId,
          command: profile.commandPath,
          args: profile.hostProfile.launch.args
        })
      )
      .digest("hex")
  };
  const environment = {
    env: profile.hostProfile.env,
    availableNames: Object.keys(profile.hostProfile.env).sort()
  };

  const signal = options.signal ?? AbortSignal.timeout(60_000);
  let probe: AcpPreflightProbeResult;
  try {
    probe = await probeInstalledAcpAgent({
      profile: resolvedProfile,
      environment,
      authenticationHints: definition.acp.authentication,
      cwd: options.cwd,
      host: { kind: "native" },
      signal
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown_error";
    return {
      status: "precondition",
      precondition: precondition(
        options.gate.mode,
        "preflight_failed",
        `ACP preflight failed for '${profile.supported.profileId}': ${redactProbeMessage(detail)}. No CLI fallback is attempted.`,
        profile.supported.profileId
      ),
      evidence: {
        profileId: profile.supported.profileId,
        agentId: profile.supported.agentId,
        commandPath: evidenceCommandLabel(profile.commandPath),
        agentVersion: versionOutput,
        verifiedAdapterVersion: profile.supported.verifiedAdapterVersion,
        protocolVersion: ACP_SDK_AUTHORITY.protocolVersion,
        sdkPackageVersion: ACP_SDK_AUTHORITY.packageVersion,
        capabilities: [],
        authenticationStatus: "preflight_error",
        agentInfoName: null
      }
    };
  }

  const agentInfo =
    probe.kind === "ready" || probe.kind === "auth_required" ? probe.agentInfo : null;
  const capabilities =
    probe.kind === "ready" || probe.kind === "auth_required" ? probe.capabilities : [];
  const agentVersion =
    agentInfo && typeof agentInfo.version === "string" && agentInfo.version.trim().length > 0
      ? agentInfo.version.trim()
      : versionOutput;
  const evidence: RealAcpPreflightEvidence = {
    profileId: profile.supported.profileId,
    agentId: profile.supported.agentId,
    commandPath: evidenceCommandLabel(profile.commandPath),
    agentVersion,
    verifiedAdapterVersion: profile.supported.verifiedAdapterVersion,
    protocolVersion: ACP_SDK_AUTHORITY.protocolVersion,
    sdkPackageVersion: ACP_SDK_AUTHORITY.packageVersion,
    capabilities: [...capabilities],
    authenticationStatus: authenticationStatus(probe),
    agentInfoName: agentInfo?.name ?? null
  };

  if (probe.kind === "auth_required") {
    return {
      status: "precondition",
      precondition: precondition(
        options.gate.mode,
        "auth_required",
        `ACP authentication required for '${profile.supported.profileId}' (${probe.authentication.reason}). Complete agent login outside PlanWeave; credentials are Host-local and never printed. No CLI fallback.`,
        profile.supported.profileId
      ),
      evidence
    };
  }

  if (probe.kind === "failed") {
    const message = probe.message.toLowerCase();
    const kind =
      message.includes("protocol version") || message.includes("not supported")
        ? "protocol_unsupported"
        : "preflight_failed";
    return {
      status: "precondition",
      precondition: precondition(
        options.gate.mode,
        kind,
        `ACP preflight failed for '${profile.supported.profileId}': ${redactProbeMessage(probe.message)}. No CLI fallback is attempted.`,
        profile.supported.profileId
      ),
      evidence
    };
  }

  if (probe.kind === "interaction_required") {
    return {
      status: "precondition",
      precondition: precondition(
        options.gate.mode,
        "auth_required",
        `ACP preflight requires interactive ${probe.interaction} for '${profile.supported.profileId}'. Complete agent setup outside PlanWeave.`,
        profile.supported.profileId
      ),
      evidence
    };
  }

  return { status: "ready", profile, evidence };
}
