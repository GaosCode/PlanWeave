import type {
  AgentExecutorProfile,
  AgentFamily,
  ExecutorIntegrationName,
  ExecutorProfile
} from "../types.js";
import type { AgentDefinition } from "./agentRunner.js";
import { claudeCodeAgentDefinition } from "./claudeCodeIntegration.js";
import { codexAgentDefinition } from "./codexIntegration.js";
import { opencodeAgentDefinition } from "./opencodeIntegration.js";
import { piAgentDefinition } from "./piIntegration.js";

const definitions = {
  codex: codexAgentDefinition,
  opencode: opencodeAgentDefinition,
  "claude-code": claudeCodeAgentDefinition,
  pi: piAgentDefinition
} as const satisfies Record<AgentFamily, AgentDefinition>;

export function resolveAgentDefinition(agent: AgentFamily): AgentDefinition {
  return definitions[agent];
}

export function registeredAgentDefinitions(): readonly AgentDefinition[] {
  return [definitions.codex, definitions.opencode, definitions["claude-code"], definitions.pi];
}

export function builtinAgentProfiles(): Record<string, AgentExecutorProfile> {
  const profiles: Record<string, AgentExecutorProfile> = {};
  for (const definition of registeredAgentDefinitions()) {
    for (const [name, profile] of Object.entries(definition.builtinProfiles)) {
      profiles[name] = profile;
    }
  }
  return profiles;
}

export function executorIntegrationForProfile(
  profile: ExecutorProfile
): ExecutorIntegrationName | null {
  if (profile.adapter !== "agent") {
    return profile.adapter;
  }
  if (profile.runner.transport === "acp") {
    return null;
  }
  return resolveAgentDefinition(profile.agent).cli?.integration ?? null;
}

export function requireExecutorIntegration(profile: ExecutorProfile): ExecutorIntegrationName {
  const integration = executorIntegrationForProfile(profile);
  if (integration) {
    return integration;
  }
  if (profile.adapter === "agent") {
    throw new Error(
      `ACP runner for agent '${profile.agent}' is not implemented; PlanWeave will not fall back to CLI.`
    );
  }
  throw new Error(`Executor profile adapter '${profile.adapter}' has no execution integration.`);
}
