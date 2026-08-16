import {
  registeredAgentDefinitions,
  type AcpCapabilityPolicy,
  type AgentDefinition,
  type AcpLaunchMetadata
} from "@planweave-ai/runtime";
import type { AgentFamily } from "@planweave-ai/runtime";

/**
 * Host-local ACP profiles supported by the opt-in real ACP smoke.
 * Profile ids match PlanWeave builtin executor names (`*-acp`).
 *
 * Version policy: the Agent must speak the ACP protocol version advertised by
 * `@agentclientprotocol/sdk` (ACP_SDK_AUTHORITY.protocolVersion). Launch
 * metadata `source.version` records the last PlanWeave-verified agent adapter
 * version; newer patch versions are accepted when protocol negotiation succeeds.
 * Incompatible major protocol versions fail closed with no CLI fallback.
 */
export type SupportedHostAcpProfile = {
  profileId: string;
  agentId: AgentFamily;
  displayName: string;
  /** Preferred absolute-or-PATH command from agent definition launch metadata. */
  command: string;
  args: readonly string[];
  /** Optional env vars the Host profile may require (names only; never values). */
  environment: readonly { name: string; required: boolean }[];
  capabilities: AcpCapabilityPolicy;
  /** Last verified adapter version (informational policy pin). */
  verifiedAdapterVersion: string;
  registryId: string;
  limitations: readonly string[];
};

function profileIdFor(agent: AgentFamily): string {
  switch (agent) {
    case "claude-code":
      return "claude-code-acp";
    case "codex":
      return "codex-acp";
    case "opencode":
      return "opencode-acp";
    case "pi":
      return "pi-acp";
    case "grok":
      return "grok-acp";
    default: {
      const exhaustive: never = agent;
      return exhaustive;
    }
  }
}

function displayNameFor(agent: AgentFamily): string {
  switch (agent) {
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    case "pi":
      return "Pi";
    case "grok":
      return "Grok";
    default: {
      const exhaustive: never = agent;
      return exhaustive;
    }
  }
}

export function isSupportedHostAgentFamily(agentId: string): agentId is AgentFamily {
  return (
    agentId === "claude-code" ||
    agentId === "codex" ||
    agentId === "opencode" ||
    agentId === "pi" ||
    agentId === "grok"
  );
}

function environmentFor(
  definition: AgentDefinition
): readonly { name: string; required: boolean }[] {
  const preferred = definition.acp.authentication?.preferredMethodIds ?? [];
  if (
    definition.agent === "grok" ||
    preferred.some((id) => id.includes("api_key") || id.includes("xai"))
  ) {
    return [{ name: "XAI_API_KEY", required: false }];
  }
  return [];
}

function fromDefinition(definition: AgentDefinition): SupportedHostAcpProfile | null {
  if (!isSupportedHostAgentFamily(definition.agent)) return null;
  const launch = definition.acp.launch;
  if (!launch) return null;
  return {
    profileId: profileIdFor(definition.agent),
    agentId: definition.agent,
    displayName: displayNameFor(definition.agent),
    command: launch.command,
    args: launch.args,
    environment: environmentFor(definition),
    capabilities: {
      required: definition.acp.capabilities,
      optional: definition.acp.optionalCapabilities
    },
    verifiedAdapterVersion: launch.source.version,
    registryId: launch.source.registryId,
    limitations: definition.acp.limitations
  };
}

export function listSupportedHostAcpProfiles(): readonly SupportedHostAcpProfile[] {
  return registeredAgentDefinitions()
    .map(fromDefinition)
    .filter((profile): profile is SupportedHostAcpProfile => profile !== null);
}

export function findSupportedHostAcpProfile(
  profileId: string
): SupportedHostAcpProfile | undefined {
  return listSupportedHostAcpProfiles().find((profile) => profile.profileId === profileId);
}

export function launchMetadataForProfile(profile: SupportedHostAcpProfile): AcpLaunchMetadata {
  return {
    command: profile.command,
    args: profile.args,
    source: {
      registryId: profile.registryId,
      version: profile.verifiedAdapterVersion,
      url: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
      descriptor: `${profile.registryId}@${profile.verifiedAdapterVersion}`
    }
  };
}
