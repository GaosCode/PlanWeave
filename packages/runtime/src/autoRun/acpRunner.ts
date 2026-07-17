import type { AcpAgentRunner } from "./agentRunner.js";
import { dirname } from "node:path";
import { z } from "zod";
import { runnerProfileMismatch } from "./agentRunner.js";
import {
  acpSessionConfigurationSchema,
  executorAgentInfoSchema,
  invalidExecutorAgentInfoMessage,
  type ExecutorPreflightFailureCode
} from "./executorPreflightTypes.js";
import {
  negotiatedCapabilitiesSchema,
  runnerAuthenticationActionRequiredSchema,
  runnerAuthenticationAuthenticatedSchema,
  runnerAuthenticationNotAdvertisedSchema,
  runnerCapabilitySchema
} from "./runnerContractSchemas.js";
import { redactRunnerEventText, safeRunnerEventTextSchema } from "./runnerEventRedaction.js";
import { AcpSessionController } from "./acpSessionController.js";
import { prepareAcpBlockRun, prepareAcpFeedbackRun } from "./acpRunPreparation.js";
import {
  AcpPreflightCleanupError,
  AcpPreflightPhaseError,
  probeInstalledAcpAgent,
  type AcpPreflightPhase
} from "./acpPreflightProbe.js";
import { assertAcpLaunchTrusted } from "./acpLaunch.js";
import { executorRuntimeLimits } from "./executorShared.js";
import { selectedDesktopAcpSessionDefaults } from "./desktopAgentSettings.js";
import { optionalStat } from "../fs/optionalFile.js";
import { recordBlockRunInIndex } from "./blockRunIndex.js";

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
      agentInfo: executorAgentInfoSchema.nullable(),
      authentication: z.union([
        runnerAuthenticationNotAdvertisedSchema,
        runnerAuthenticationAuthenticatedSchema
      ]),
      capabilities: uniqueCapabilitiesSchema,
      sessionConfig: acpSessionConfigurationSchema.optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("auth_required"),
      message: acpProbeMessageSchema,
      agentInfo: executorAgentInfoSchema.nullable(),
      authentication: runnerAuthenticationActionRequiredSchema,
      capabilities: uniqueCapabilitiesSchema
    })
    .strict(),
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
  check:
    | "acp_initialized"
    | "acp_authenticated"
    | "acp_session"
    | "acp_capabilities"
    | "interaction_policy",
  failureCode: ExecutorPreflightFailureCode,
  message: string
) {
  return { check, status: "failed" as const, failureCode, message };
}

function preflightCheckForPhase(
  phase: AcpPreflightPhase
): "acp_initialized" | "acp_authenticated" | "acp_session" {
  if (phase === "authentication") return "acp_authenticated";
  if (phase === "session") return "acp_session";
  return "acp_initialized";
}

function preflightPhaseFromError(error: unknown): AcpPreflightPhase {
  if (error instanceof AcpPreflightPhaseError) return error.phase;
  if (error instanceof AcpPreflightCleanupError && error.phase !== null) return error.phase;
  return "initialize";
}

export function createAcpRunner(options?: {
  probe?: AcpPreflightProbe;
  sessionController?: AcpSessionController;
  recordBlockRun?: typeof recordBlockRunInIndex;
}): AcpAgentRunner {
  const probe = options?.probe ?? probeInstalledAcpAgent;
  const sessionController = options?.sessionController ?? new AcpSessionController();
  const recordBlockRun = options?.recordBlockRun ?? recordBlockRunInIndex;
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
      if (signal?.aborted) {
        return {
          executionIntegration: null,
          negotiatedCapabilities: null,
          checks: [
            failedCheck(
              "acp_initialized",
              "cancelled",
              `ACP initialize was cancelled before preflight started: ${safeDiagnostic(signal.reason)}`
            )
          ]
        };
      }
      const controller = new AbortController();
      const relayAbort = (): void => controller.abort(signal?.reason);
      signal?.addEventListener("abort", relayAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        if (controller.signal.aborted) return;
        timedOut = true;
        controller.abort(new Error(`ACP preflight timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      let rawResult: unknown;
      try {
        rawResult = await probe({ definition, cwd, signal: controller.signal });
        if (controller.signal.aborted) {
          const cancelled = signal?.aborted === true;
          return {
            executionIntegration: null,
            negotiatedCapabilities: null,
            checks: [
              failedCheck(
                "acp_initialized",
                timedOut ? "timeout" : "cancelled",
                timedOut
                  ? `ACP preflight timed out after ${timeoutMs}ms.`
                  : cancelled
                    ? `ACP initialize was cancelled: ${safeDiagnostic(signal.reason)}`
                    : "ACP initialize was cancelled."
              )
            ]
          };
        }
      } catch (error) {
        const cancelled = signal?.aborted === true;
        const phase = preflightPhaseFromError(error);
        return {
          executionIntegration: null,
          negotiatedCapabilities: null,
          checks: [
            failedCheck(
              preflightCheckForPhase(phase),
              timedOut ? "timeout" : cancelled ? "cancelled" : "initialization_failed",
              timedOut
                ? `ACP preflight timed out after ${timeoutMs}ms.`
                : cancelled
                  ? `ACP ${phase} was cancelled: ${safeDiagnostic(error)}`
                  : safeDiagnostic(error)
            )
          ]
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", relayAbort);
      }
      const parsedResult = acpProbeResultSchema.safeParse(rawResult);
      if (!parsedResult.success) {
        let message = "ACP initialize returned an invalid or unauthenticated probe result.";
        if (parsedResult.error.issues.some((issue) => issue.path[0] === "agentInfo")) {
          message = invalidExecutorAgentInfoMessage;
        }
        return {
          executionIntegration: null,
          negotiatedCapabilities: null,
          checks: [failedCheck("acp_initialized", "initialization_failed", message)]
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
          availableCapabilities: result.capabilities,
          agentInfo: result.agentInfo,
          authentication: result.authentication,
          checks: [initialized, failedCheck("acp_authenticated", "auth_required", result.message)]
        };
      }
      if (result.kind === "interaction_required") {
        return {
          executionIntegration: null,
          negotiatedCapabilities: null,
          authentication: null,
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
          availableCapabilities: available,
          agentInfo: result.agentInfo,
          authentication: result.authentication,
          sessionConfig: result.sessionConfig ?? null,
          checks: [
            initialized,
            {
              check: "acp_authenticated",
              status: "passed",
              message:
                result.authentication.status === "authenticated"
                  ? `ACP authentication completed with method '${result.authentication.methodId}'.`
                  : "ACP agent did not advertise authentication methods."
            },
            {
              check: "acp_session",
              status: "passed",
              message: "ACP temporary session was created successfully."
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
        availableCapabilities: available,
        agentInfo: result.agentInfo,
        authentication: result.authentication,
        sessionConfig: result.sessionConfig ?? null,
        checks: [
          initialized,
          {
            check: "acp_authenticated",
            status: "passed",
            message:
              result.authentication.status === "authenticated"
                ? `ACP authentication completed with method '${result.authentication.methodId}'.`
                : "ACP agent did not advertise authentication methods."
          },
          {
            check: "acp_session",
            status: "passed",
            message: "ACP temporary session was created successfully."
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
        definition,
        profileSource: input.profileSource
      });
      const prepared = await prepareAcpBlockRun({
        projectRoot: input.projectRoot,
        ref: input.claim.ref,
        prompt: input.prompt
      });
      try {
        return await sessionController.execute(
          {
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
            authenticationHints: definition.acp.authentication,
            executorName: input.executorName,
            agentId: definition.agent,
            taskId: input.claim.taskId,
            metadataIdentity: {
              blockId: input.claim.blockId,
              ...(input.executionWaveId ? { executionWaveId: input.executionWaveId } : {})
            },
            projectId: prepared.projectId,
            canvasId: prepared.canvasId
          },
          {
            signal: input.runtime?.signal,
            timeoutMs: input.runtime?.timeoutMs ?? executorRuntimeLimits(input.profile).timeoutMs,
            interactionBroker: input.runtime?.interactionBroker,
            interactionObserver: input.runtime?.interactionObserver,
            onMetadataPersisted: () => recordBlockRun(dirname(prepared.runDir), prepared.runId),
            sessionDefaults: input.runtime?.desktopRunId
              ? selectedDesktopAcpSessionDefaults(definition.agent)
              : undefined
          }
        );
      } finally {
        if (await optionalStat(prepared.metadataPath)) {
          await recordBlockRun(dirname(prepared.runDir), prepared.runId);
        }
      }
    },
    async runFeedback(input, definition) {
      if (input.profile.runner.transport !== "acp" || input.profile.agent !== definition.agent) {
        throw runnerProfileMismatch("acp", input.profile);
      }
      const launch = await assertAcpLaunchTrusted({
        projectRoot: input.workspace,
        executorName: input.executorName,
        definition,
        profileSource: input.profileSource
      });
      const prepared = await prepareAcpFeedbackRun({
        workspace: input.workspace,
        prompt: input.claim.content
      });
      return sessionController.execute(
        {
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
          authenticationHints: definition.acp.authentication,
          executorName: input.executorName,
          agentId: definition.agent,
          taskId: input.claim.taskId,
          metadataIdentity: {
            feedbackId: input.claim.feedbackId,
            sourceReviewBlockRef: input.claim.sourceReviewBlockRef
          },
          projectId: prepared.projectId,
          canvasId: prepared.canvasId
        },
        {
          signal: input.runtime?.signal,
          timeoutMs: input.runtime?.timeoutMs ?? executorRuntimeLimits(input.profile).timeoutMs,
          interactionBroker: input.runtime?.interactionBroker,
          interactionObserver: input.runtime?.interactionObserver,
          sessionDefaults: input.runtime?.desktopRunId
            ? selectedDesktopAcpSessionDefaults(definition.agent)
            : undefined
        }
      );
    }
  };
}

export const acpRunner = createAcpRunner();
