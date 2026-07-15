import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { createAcpRunner } from "../autoRun/acpRunner.js";
import { producedExecutorPreflightResultSchema } from "../autoRun/executorPreflightTypes.js";
import { resolveAgentDefinition } from "../autoRun/agentRegistry.js";
import { agentFamilySchema, type AgentExecutorProfile } from "../types.js";
import type {
  DesktopAgentCapabilityProbeInput,
  DesktopAgentCapabilityProbeResult
} from "./types/bridgeTypes.js";

const desktopAgentKindSchema = agentFamilySchema;
export const desktopAgentCapabilityProbeResultSchema = producedExecutorPreflightResultSchema
  .pick({
    ok: true,
    message: true,
    failureCode: true,
    agentInfo: true,
    authentication: true,
    capabilities: true,
    sessionConfig: true,
    checks: true
  })
  .extend({ agentKind: desktopAgentKindSchema })
  .strict();
const desktopAgentCapabilityProbeInputSchema = z
  .object({
    agentKind: desktopAgentKindSchema,
    projectRoot: z.string().trim().min(1).nullable().optional()
  })
  .strict();

const capabilityProbeTimeoutMs = 30_000;

export async function probeDesktopAgentCapabilities(
  input: DesktopAgentCapabilityProbeInput
): Promise<DesktopAgentCapabilityProbeResult> {
  const parsed = desktopAgentCapabilityProbeInputSchema.parse(input);
  const definition = resolveAgentDefinition(parsed.agentKind);
  const profile: AgentExecutorProfile = {
    adapter: "agent",
    agent: parsed.agentKind,
    runner: { transport: "acp" }
  };
  const cwd = resolve(parsed.projectRoot ?? homedir());
  const preflight = await createAcpRunner().preflight({
    profile,
    definition,
    cwd,
    timeoutMs: capabilityProbeTimeoutMs
  });
  const failedCheck = preflight.checks.find((check) => check.status === "failed") ?? null;
  const ok = failedCheck === null && preflight.negotiatedCapabilities !== null;
  return desktopAgentCapabilityProbeResultSchema.parse({
    agentKind: parsed.agentKind,
    ok,
    message: ok
      ? `ACP capability probe passed for agent '${parsed.agentKind}'.`
      : (failedCheck?.message ?? `ACP capability probe failed for agent '${parsed.agentKind}'.`),
    failureCode: failedCheck?.failureCode ?? null,
    agentInfo: preflight.agentInfo ?? null,
    authentication: preflight.authentication ?? null,
    capabilities:
      preflight.availableCapabilities ?? preflight.negotiatedCapabilities?.available ?? null,
    sessionConfig: preflight.sessionConfig ?? null,
    checks: preflight.checks
  });
}
