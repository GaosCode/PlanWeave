import { homedir } from "node:os";
import { z } from "zod";
import { createAcpRunner } from "../autoRun/acpRunner.js";
import { producedExecutorPreflightResultSchema } from "../autoRun/executorPreflightTypes.js";
import { resolveAgentDefinition } from "../autoRun/agentRegistry.js";
import { selectedDesktopAgentHost } from "../autoRun/desktopAgentSettings.js";
import { workspaceExecutionCwd } from "../autoRun/executorShared.js";
import { locateProjectWorkspace } from "../project.js";
import {
  agentFamilySchema,
  executionHostSchema,
  isAgentAcpExecutorProfile,
  type ExecutionHost
} from "../types.js";
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
    acpCapabilitySnapshot: true,
    sessionConfig: true,
    checks: true
  })
  .extend({ agentKind: desktopAgentKindSchema, executionHost: executionHostSchema })
  .strict();
const desktopAgentCapabilityProbeInputSchema = z
  .object({
    agentKind: desktopAgentKindSchema,
    projectRoot: z.string().trim().min(1).nullable().optional()
  })
  .strict();

const capabilityProbeTimeoutMs = 30_000;

export async function probeDesktopAgentCapabilities(
  input: DesktopAgentCapabilityProbeInput,
  options?: { executionHost: ExecutionHost }
): Promise<DesktopAgentCapabilityProbeResult> {
  const parsed = desktopAgentCapabilityProbeInputSchema.parse(input);
  const executionHost = executionHostSchema.parse(
    options?.executionHost ?? selectedDesktopAgentHost()
  );
  const definition = resolveAgentDefinition(parsed.agentKind);
  const profile = Object.values(definition.builtinProfiles).find(isAgentAcpExecutorProfile);
  if (!profile) throw new Error(`Agent '${parsed.agentKind}' has no built-in ACP executor.`);
  const workspace = parsed.projectRoot ? await locateProjectWorkspace(parsed.projectRoot) : null;
  const cwd = workspace ? workspaceExecutionCwd(workspace) : homedir();
  const preflight = await createAcpRunner().preflight({
    profile: { ...profile, host: executionHost },
    profileSource: "builtin",
    definition,
    cwd,
    projectRoot: workspace ?? cwd,
    timeoutMs: capabilityProbeTimeoutMs
  });
  const failedCheck = preflight.checks.find((check) => check.status === "failed") ?? null;
  const ok = failedCheck === null && preflight.negotiatedCapabilities !== null;
  return desktopAgentCapabilityProbeResultSchema.parse({
    agentKind: parsed.agentKind,
    executionHost,
    ok,
    message: ok
      ? `ACP capability probe passed for agent '${parsed.agentKind}'.`
      : (failedCheck?.message ?? `ACP capability probe failed for agent '${parsed.agentKind}'.`),
    failureCode: failedCheck?.failureCode ?? null,
    agentInfo: preflight.agentInfo ?? null,
    authentication: preflight.authentication ?? null,
    capabilities:
      preflight.availableCapabilities ?? preflight.negotiatedCapabilities?.available ?? null,
    acpCapabilitySnapshot: preflight.acpCapabilitySnapshot ?? null,
    sessionConfig: preflight.sessionConfig ?? null,
    checks: preflight.checks
  });
}
