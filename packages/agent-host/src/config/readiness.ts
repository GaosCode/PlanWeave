import type { HostReadinessObservation } from "@planweave-ai/agent-host-protocol";
import { ConfiguredAcpProfileResolver, ConfiguredWorkspaceResolver } from "./resolvers.js";
import type { AgentHostConfig } from "./schema.js";
import { ConfiguredCanvasRuntimeResolver } from "../runtime/canvasRuntimeResolver.js";
import { findSupportedHostAcpProfile } from "../realAcp/supportedProfiles.js";

function observationStatus(error: unknown): "missing" | "invalid" {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    return "missing";
  }
  if (
    error instanceof Error &&
    (error.message === "agent_host_workspace_not_configured" ||
      error.message === "agent_host_profile_not_configured" ||
      error.message === "runtime_project_not_configured" ||
      error.message === "runtime_project_missing")
  ) {
    return "missing";
  }
  return "invalid";
}

/**
 * Resolves target-machine configuration without exposing paths, commands, or
 * environment names through the Host protocol.
 */
export async function observeHostReadiness(
  config: AgentHostConfig,
  environment: Readonly<Record<string, string | undefined>>,
  exposedProfileIds: readonly string[]
): Promise<HostReadinessObservation> {
  const workspaces = new ConfiguredWorkspaceResolver(config);
  const profiles = new ConfiguredAcpProfileResolver(config, environment);
  const runtimeProjects = new ConfiguredCanvasRuntimeResolver(config);
  const workspaceMappings = await Promise.all(
    config.workspaces.map(async (workspace) => {
      try {
        await workspaces.resolve(workspace.id);
        return { workspaceId: workspace.id, status: "ready" as const };
      } catch (error) {
        return { workspaceId: workspace.id, status: observationStatus(error) };
      }
    })
  );
  const acpProfiles = await Promise.all(
    config.agentProfiles
      .filter((profile) => exposedProfileIds.includes(profile.id))
      .map(async (profile) => {
        const displayName = findSupportedHostAcpProfile(profile.id)?.displayName ?? profile.id;
        try {
          await profiles.resolve(profile.id, profile.agentId);
          return {
            profileId: profile.id,
            agentId: profile.agentId,
            displayName,
            status: "ready" as const,
            capabilities: [`acp.${profile.agentId}`]
          };
        } catch (error) {
          return {
            profileId: profile.id,
            agentId: profile.agentId,
            displayName,
            status: observationStatus(error),
            capabilities: [`acp.${profile.agentId}`]
          };
        }
      })
  );
  const runtimeProjectMappings = await Promise.all(
    runtimeProjects.mappings().map(async (mapping) => {
      try {
        await runtimeProjects.resolveProject(mapping.workspaceId, mapping.projectId);
        return {
          workspaceId: mapping.workspaceId,
          projectId: mapping.projectId,
          status: "ready" as const
        };
      } catch (error) {
        return {
          workspaceId: mapping.workspaceId,
          projectId: mapping.projectId,
          status: observationStatus(error)
        };
      }
    })
  );
  return { workspaceMappings, acpProfiles, runtimeProjects: runtimeProjectMappings };
}
