import type { AcpAgentRunner } from "./agentRunner.js";
import { z } from "zod";
import { runnerProfileMismatch } from "./agentRunner.js";
import type { ExecutorPreflightFailureCode } from "./executorPreflightTypes.js";
import { negotiatedCapabilitiesSchema, runnerCapabilitySchema } from "./runnerContractSchemas.js";
import { redactRunnerEventText, safeRunnerEventTextSchema } from "./runnerEventRedaction.js";
import { AcpSessionController } from "./acpSessionController.js";
import { prepareAcpBlockRun, prepareAcpFeedbackRun } from "./acpRunPreparation.js";
import { probeInstalledAcpAgent } from "./acpPreflightProbe.js";
import { assertAcpLaunchTrusted } from "./acpLaunch.js";

function unavailableMessage(agent: string): string {
  return `ACP runner for agent '${agent}' is not implemented; PlanWeave will not fall back to CLI.`;
}

const uniqueCapabilitiesSchema = runnerCapabilitySchema
  .array()
  .max(32)
  .superRefine((capabilities, context) => {
    if (new Set(capabilities).size !== capabilities.length) {
      context.addIssue({ code: "custom", message: "ACP capabilities must be unique." });
    }
  });
const acpProbeMessageSchema = safeRunnerEventTextSchema(64 * 1_024, "ACP probe message");

export const acpProbeResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ready"),
      authenticated: z.literal(true),
      capabilities: uniqueCapabilitiesSchema
    })
    .strict(),
  z.object({ kind: z.literal("auth_required"), message: acpProbeMessageSchema }).strict(),
  z
    .object({
      kind: z.literal("interaction_required"),
      interaction: z.enum(["permission", "auth", "elicitation"])
    })
    .strict(),
  z.object({ kind: z.literal("failed"), message: acpProbeMessageSchema }).strict()
]);
export type AcpPreflightProbeResult = z.infer<typeof acpProbeResultSchema>;

export type AcpPreflightProbe = (options: {
  definition: Parameters<AcpAgentRunner["availability"]>[0];
  cwd: string;
  signal: AbortSignal;
}) => Promise<AcpPreflightProbeResult>;

function safeDiagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactRunnerEventText(raw).text;
}

function failedCheck(
  check: "acp_initialized" | "acp_authenticated" | "acp_capabilities" | "interaction_policy",
  failureCode: ExecutorPreflightFailureCode,
  message: string
) {
  return { check, status: "failed" as const, failureCode, message };
}

export function createAcpRunner(options?: {
  probe?: AcpPreflightProbe;
  sessionController?: AcpSessionController;
}): AcpAgentRunner {
  const probe = options?.probe ?? probeInstalledAcpAgent;
  const sessionController = options?.sessionController ?? new AcpSessionController();
  return {
    transport: "acp",
    availability(definition) {
      return {
        supported: definition.acp.launch !== null,
        integration: null,
        message:
          definition.acp.launch !== null
            ? `ACP session integration for agent '${definition.agent}' is available.`
            : unavailableMessage(definition.agent)
      };
    },
    async preflight({ profile, definition, cwd, timeoutMs, signal }) {
      if (profile.runner.transport !== "acp") {
        return {
          executionIntegration: null,
          negotiatedCapabilities: null,
          checks: [
            failedCheck(
              "acp_initialized",
              "invalid_profile",
              "ACP runner received a non-ACP profile."
            )
          ]
        };
      }
      if (!definition.acp.launch) {
        return {
          executionIntegration: null,
          negotiatedCapabilities: null,
          checks: [
            failedCheck(
              "acp_initialized",
              "initialization_failed",
              unavailableMessage(definition.agent)
            )
          ]
        };
      }
      const controller = new AbortController();
      const relayAbort = (): void => controller.abort(signal?.reason);
      signal?.addEventListener("abort", relayAbort, { once: true });
      let rejectTimeout: ((error: Error) => void) | null = null;
      const timeout = new Promise<never>((_resolve, reject) => {
        rejectTimeout = reject;
      });
      const timer = setTimeout(() => {
        controller.abort(new Error("ACP initialize timed out."));
        rejectTimeout?.(new Error("ACP initialize timed out."));
      }, timeoutMs);
      let rawResult: unknown;
      try {
        rawResult = await Promise.race([
          probe({ definition, cwd, signal: controller.signal }),
          timeout
        ]);
      } catch (error) {
        const timedOut = controller.signal.aborted && signal?.aborted !== true;
        return {
          executionIntegration: null,
          negotiatedCapabilities: null,
          checks: [
            failedCheck(
              "acp_initialized",
              timedOut ? "timeout" : "initialization_failed",
              timedOut
                ? `ACP initialize timed out after ${timeoutMs}ms.`
                : `ACP initialize failed: ${safeDiagnostic(error)}`
            )
          ]
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", relayAbort);
      }
      const parsedResult = acpProbeResultSchema.safeParse(rawResult);
      if (!parsedResult.success) {
        return {
          executionIntegration: null,
          negotiatedCapabilities: null,
          checks: [
            failedCheck(
              "acp_initialized",
              "initialization_failed",
              "ACP initialize returned an invalid or unauthenticated probe result."
            )
          ]
        };
      }
      const result = parsedResult.data;
      if (result.kind === "failed") {
        return {
          executionIntegration: null,
          negotiatedCapabilities: null,
          checks: [failedCheck("acp_initialized", "initialization_failed", result.message)]
        };
      }
      const initialized = {
        check: "acp_initialized" as const,
        status: "passed" as const,
        message: "ACP initialize completed."
      };
      if (result.kind === "auth_required") {
        return {
          executionIntegration: null,
          negotiatedCapabilities: null,
          checks: [initialized, failedCheck("acp_authenticated", "auth_required", result.message)]
        };
      }
      if (result.kind === "interaction_required") {
        return {
          executionIntegration: null,
          negotiatedCapabilities: null,
          checks: [
            initialized,
            failedCheck(
              "interaction_policy",
              "unsafe_interaction",
              `Headless ACP preflight denied ${result.interaction}; PlanWeave never auto-approves permission, auth, or elicitation requests.`
            )
          ]
        };
      }
      const available = result.capabilities;
      const negotiated = negotiatedCapabilitiesSchema.safeParse({
        version: "planweave.runner/v1",
        required: definition.acp.capabilities,
        available,
        negotiated: definition.acp.capabilities.filter((capability) =>
          available.includes(capability)
        )
      });
      if (!negotiated.success) {
        const missing = definition.acp.capabilities.filter(
          (capability) => !available.includes(capability)
        );
        return {
          executionIntegration: null,
          negotiatedCapabilities: null,
          checks: [
            initialized,
            {
              check: "acp_authenticated",
              status: "passed",
              message: "ACP authentication is available."
            },
            failedCheck(
              "acp_capabilities",
              "unsupported_capability",
              missing.length > 0
                ? `ACP agent '${definition.agent}' does not support required capabilities: ${missing.join(", ")}.`
                : `ACP agent '${definition.agent}' returned invalid negotiated capabilities.`
            )
          ]
        };
      }
      return {
        executionIntegration: null,
        negotiatedCapabilities: negotiated.data,
        checks: [
          initialized,
          {
            check: "acp_authenticated",
            status: "passed",
            message: "ACP authentication is available."
          },
          {
            check: "acp_capabilities",
            status: "passed",
            message: "ACP required capabilities are available."
          },
          {
            check: "interaction_policy",
            status: "passed",
            message: "Headless policy denies permission and elicitation requests by default."
          }
        ]
      };
    },
    async runBlock(input, definition) {
      if (input.profile.runner.transport !== "acp" || input.profile.agent !== definition.agent) {
        throw runnerProfileMismatch("acp", input.profile);
      }
      const launch = await assertAcpLaunchTrusted({
        projectRoot: input.projectRoot,
        executorName: input.executorName,
        definition
      });
      const prepared = await prepareAcpBlockRun({
        projectRoot: input.projectRoot,
        ref: input.claim.ref,
        prompt: input.prompt
      });
      return sessionController.execute({
        kind: input.claim.blockType === "review" ? "review" : "implementation",
        identity: {
          scope: prepared.runDir,
          executorRunId: prepared.runId,
          claimRef: input.claim.ref,
          desktopRunId: input.runtime?.desktopRunId,
          runSessionId: input.runtime?.runSessionId
        },
        runDir: prepared.runDir,
        metadataPath: prepared.metadataPath,
        prompt: input.prompt,
        cwd: prepared.cwd,
        launch,
        executorName: input.executorName,
        agentId: definition.agent,
        taskId: input.claim.taskId,
        metadataIdentity: { blockId: input.claim.blockId },
        projectId: prepared.projectId,
        canvasId: prepared.canvasId
      }, {
        signal: input.runtime?.signal,
        timeoutMs: input.runtime?.timeoutMs,
        interactionBroker: input.runtime?.interactionBroker
      });
    },
    async runFeedback(input, definition) {
      if (input.profile.runner.transport !== "acp" || input.profile.agent !== definition.agent) {
        throw runnerProfileMismatch("acp", input.profile);
      }
      const launch = await assertAcpLaunchTrusted({
        projectRoot: input.workspace,
        executorName: input.executorName,
        definition
      });
      const prepared = await prepareAcpFeedbackRun({
        workspace: input.workspace,
        prompt: input.claim.content
      });
      return sessionController.execute({
        kind: "feedback",
        identity: {
          scope: prepared.runDir,
          executorRunId: prepared.runId,
          claimRef: input.claim.sourceReviewBlockRef,
          desktopRunId: input.runtime?.desktopRunId,
          runSessionId: input.runtime?.runSessionId
        },
        runDir: prepared.runDir,
        metadataPath: prepared.metadataPath,
        prompt: input.claim.content,
        cwd: prepared.cwd,
        launch,
        executorName: input.executorName,
        agentId: definition.agent,
        taskId: input.claim.taskId,
        metadataIdentity: {
          feedbackId: input.claim.feedbackId,
          sourceReviewBlockRef: input.claim.sourceReviewBlockRef
        },
        projectId: prepared.projectId,
        canvasId: prepared.canvasId
      }, {
        signal: input.runtime?.signal,
        timeoutMs: input.runtime?.timeoutMs,
        interactionBroker: input.runtime?.interactionBroker
      });
    }
  };
}

export const acpRunner = createAcpRunner();
