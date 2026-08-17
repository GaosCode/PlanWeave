import type { ResolvedAgentHostAcpProfile } from "../execution/remoteAcpPorts.js";
import { DEFAULT_ACP_SHUTDOWN_POLICY } from "@planweave-ai/runtime";
import { resolveHostExecutable } from "../platform/resolveHostExecutable.js";
import type { RealAcpGate, RealAcpPrecondition } from "./gate.js";
import { precondition } from "./gate.js";
import {
  findSupportedHostAcpProfile,
  listSupportedHostAcpProfiles,
  type SupportedHostAcpProfile
} from "./supportedProfiles.js";

export type ResolvedRealAcpHostProfile = {
  supported: SupportedHostAcpProfile;
  hostProfile: ResolvedAgentHostAcpProfile;
  commandPath: string;
  versionOutput: string | null;
};

export type ResolveRealAcpOutcome =
  | { status: "resolved"; profile: ResolvedRealAcpHostProfile }
  | { status: "precondition"; precondition: RealAcpPrecondition };

function withPathOverride(
  env: Readonly<Record<string, string | undefined>>,
  pathEnv: string | undefined
): Readonly<Record<string, string | undefined>> {
  if (pathEnv === undefined) return env;
  return {
    ...Object.fromEntries(Object.entries(env).filter(([name]) => name.toLowerCase() !== "path")),
    PATH: pathEnv
  };
}

function collectEnvironment(
  profile: SupportedHostAcpProfile,
  env: Readonly<Record<string, string | undefined>>
): { env: Record<string, string>; missingRequired: string[] } {
  const resolved: Record<string, string> = {};
  const missingRequired: string[] = [];
  for (const entry of profile.environment) {
    const value = env[entry.name];
    if (value === undefined || value.length === 0) {
      if (entry.required) missingRequired.push(entry.name);
      continue;
    }
    resolved[entry.name] = value;
  }
  return { env: resolved, missingRequired };
}

export async function resolveRealAcpHostProfile(options: {
  gate: RealAcpGate;
  env?: Readonly<Record<string, string | undefined>>;
  pathEnv?: string;
  platform?: NodeJS.Platform;
}): Promise<ResolveRealAcpOutcome> {
  const env = withPathOverride(options.env ?? process.env, options.pathEnv);
  const gate = options.gate;

  if (!gate.enabled) {
    return {
      status: "precondition",
      precondition: precondition(
        gate.mode,
        "gate_disabled",
        "Real ACP gate is disabled. Set PLANWEAVE_REAL_ACP=1 (soft) or PLANWEAVE_REAL_ACP_REQUIRE=1 (hard)."
      )
    };
  }

  const catalog = listSupportedHostAcpProfiles();
  let selected: SupportedHostAcpProfile | undefined;
  if (gate.preferredProfileId) {
    selected = findSupportedHostAcpProfile(gate.preferredProfileId);
    if (!selected) {
      return {
        status: "precondition",
        precondition: precondition(
          gate.mode,
          "profile_unsupported",
          `Unsupported Host-local ACP profile '${gate.preferredProfileId}'. Supported: ${catalog
            .map((profile) => profile.profileId)
            .join(", ")}.`,
          gate.preferredProfileId
        )
      };
    }
  } else {
    for (const candidate of catalog) {
      const commandPath = await resolveHostExecutable({
        command: candidate.command,
        env,
        platform: options.platform
      });
      if (commandPath) {
        selected = candidate;
        break;
      }
    }
    if (!selected) {
      return {
        status: "precondition",
        precondition: precondition(
          gate.mode,
          "binary_missing",
          `No supported real ACP agent binary found on PATH. Tried: ${catalog
            .map((profile) => profile.command)
            .join(", ")}. Install one supported agent and complete its login outside PlanWeave.`
        )
      };
    }
  }

  const commandPath = await resolveHostExecutable({
    command: selected.command,
    env,
    platform: options.platform
  });
  if (!commandPath) {
    return {
      status: "precondition",
      precondition: precondition(
        gate.mode,
        "binary_missing",
        `ACP executable '${selected.command}' for profile '${selected.profileId}' was not found or is not executable.`,
        selected.profileId
      )
    };
  }

  const { env: profileEnv, missingRequired } = collectEnvironment(selected, env);
  if (missingRequired.length > 0) {
    return {
      status: "precondition",
      precondition: precondition(
        gate.mode,
        "credential_missing",
        `Required environment variable(s) missing for '${selected.profileId}': ${missingRequired.join(
          ", "
        )}. Values are never logged.`,
        selected.profileId
      )
    };
  }

  return {
    status: "resolved",
    profile: {
      supported: selected,
      commandPath,
      versionOutput: null,
      hostProfile: {
        agentId: selected.agentId,
        capabilityPolicy: selected.capabilities,
        launch: { command: commandPath, args: [...selected.args] },
        env: profileEnv,
        shutdown: DEFAULT_ACP_SHUTDOWN_POLICY,
        connection: { mode: "dedicated" },
        host: { kind: "native" },
        fingerprint: selected.profileId
      }
    }
  };
}
