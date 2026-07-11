import type { AgentCliExecutorProfile, AgentExecutorProfile, RunnerTransport } from "../types.js";
import { acpRunner } from "./acpRunner.js";
import type { AcpAgentRunner, AgentRunner, CliAgentRunner } from "./agentRunner.js";
import { cliRunner } from "./cliRunner.js";

const runners = {
  cli: cliRunner,
  acp: acpRunner
} as const satisfies Record<RunnerTransport, AgentRunner>;

type AgentAcpExecutorProfile = Extract<AgentExecutorProfile, { runner: { transport: "acp" } }>;

export function resolveAgentRunner(profile: AgentCliExecutorProfile): CliAgentRunner;
export function resolveAgentRunner(profile: AgentAcpExecutorProfile): AcpAgentRunner;
export function resolveAgentRunner(profile: AgentExecutorProfile): AgentRunner;
export function resolveAgentRunner(profile: AgentExecutorProfile): AgentRunner {
  return runners[profile.runner.transport];
}

export function registeredAgentRunners(): readonly AgentRunner[] {
  return [runners.cli, runners.acp];
}
