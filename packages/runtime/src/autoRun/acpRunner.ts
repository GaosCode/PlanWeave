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
  runnerAuthenticationActionRequiredSchema,
  runnerAuthenticationAuthenticatedSchema,
  runnerAuthenticationNotAdvertisedSchema,
  runnerCapabilitySchema
} from "./runnerContractSchemas.js";
import { AcpRequiredCapabilityError, acpCapabilitySnapshotSchema } from "./acpCapabilityGate.js";
import { redactRunnerEventText, safeRunnerEventTextSchema } from "./runnerEventRedaction.js";
import { AcpSessionController } from "./acpSessionController.js";
import { prepareAcpBlockRun, prepareAcpFeedbackRun } from "./acpRunPreparation.js";
import {
  AcpPreflightCleanupError,
  AcpPreflightPhaseError,
  probeInstalledAcpAgent,
  type AcpPreflightPhase
} from "./acpPreflightProbe.js";
import { executorRuntimeLimits } from "./executorShared.js";
import { selectedDesktopAcpSessionDefaults } from "./desktopAgentSettings.js";
import { optionalStat } from "../fs/optionalFile.js";
import { recordBlockRunInIndex } from "./blockRunIndex.js";
import { acpRunRecoveryExecutionSchema, renderAcpRunRecoveryPrompt } from "./acpRunRecovery.js";
import {
  executorProfileExecutionHost,
  isAgentAcpExecutorProfile,
  type ExecutionHost
} from "../types.js";
import {
  createRuntimeAcpProfileResolver,
  resolveAcpExecutionProfile,
  type ResolvedAcpExecutionProfile
} from "../acpProfile/runtimeResolver.js";
import {
  AcpProfileResolutionError,
  type AcpProfileResolver,
  type ResolvedAcpProfile
} from "../acpProfile/resolver.js";
import type { ResolvedAgentEnvironment } from "../process/agentProcessEnv.js";
import type { AcpAuthenticationHints } from "./acpAuthentication.js";

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
      capabilitySnapshot: acpCapabilitySnapshotSchema,
      sessionConfig: acpSessionConfigurationSchema.optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("auth_required"),
      message: acpProbeMessageSchema,
      agentInfo: executorAgentInfoSchema.nullable(),
      authentication: runnerAuthenticationActionRequiredSchema,
      capabilities: uniqueCapabilitiesSchema,
      capabilitySnapshot: acpCapabilitySnapshotSchema
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
  profile: ResolvedAcpProfile;
  environment: ResolvedAgentEnvironment;
  authenticationHints?: AcpAuthenticationHints;
  cwd: string;
  host: ExecutionHost;
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
): "acp_initialized" | "acp_capabilities" | "acp_authenticated" | "acp_session" {
  if (phase === "capability") return "acp_capabilities";
  if (phase === "authentication") return "acp_authenticated";
  if (phase === "session") return "acp_session";
  return "acp_initialized";
}

function requiredCapabilityError(error: unknown): AcpRequiredCapabilityError | null {
  if (error instanceof AcpRequiredCapabilityError) return error;
  if (error instanceof Error && error.cause !== undefined) {
    return requiredCapabilityError(error.cause);
  }
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const found = requiredCapabilityError(nested);
      if (found) return found;
    }
  }
  return null;
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
  profileResolver?: AcpProfileResolver;
}): AcpAgentRunner {
  const probe = options?.probe ?? probeInstalledAcpAgent;
  const sessionController = options?.sessionController ?? new AcpSessionController();
  const recordBlockRun = options?.recordBlockRun ?? recordBlockRunInIndex;
  const profileResolver = options?.profileResolver ?? createRuntimeAcpProfileResolver();
  return {
    transport: "acp",
    availability(definition) {
      return {
        supported: true,
        integration: null,
        message: `ACP profile resolution for agent '${definition.agent}' is available.`
      };
    },
    async preflight({ profile, profileSource, definition, cwd, projectRoot, timeoutMs, signal }) {
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
      if (!isAgentAcpExecutorProfile(profile)) {
        throw new Error("ACP profile narrowing failed.");
      }
      let resolved: ResolvedAcpExecutionProfile;
      try {
        resolved = await resolveAcpExecutionProfile({
          executorProfile: profile,
          projectRoot: projectRoot ?? cwd,
          executorSource: profileSource ?? "package",
          resolver: profileResolver
        });
      } catch (error) {
        return {
          executionIntegration: null,
          negotiatedCapabilities: null,
          checks: [failedCheck("acp_initialized", "initialization_failed", safeDiagnostic(error))]
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
        rawResult = await probe({
          profile: resolved.profile,
          environment: resolved.environment,
          authenticationHints: definition.acp.authentication,
          cwd,
          host: executorProfileExecutionHost(profile),
          signal: controller.signal
        });
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
        const capabilityError = requiredCapabilityError(error);
        return {
          executionIntegration: null,
          negotiatedCapabilities: null,
          acpCapabilitySnapshot: capabilityError?.snapshot ?? null,
          availableCapabilities: capabilityError?.snapshot.available ?? null,
          agentInfo: capabilityError?.snapshot.agentInfo ?? null,
          checks: [
            failedCheck(
              preflightCheckForPhase(phase),
              timedOut
                ? "timeout"
                : cancelled
                  ? "cancelled"
                  : capabilityError
                    ? "unsupported_capability"
                    : "initialization_failed",
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
          acpCapabilitySnapshot: result.capabilitySnapshot,
          availableCapabilities: result.capabilities,
          agentInfo: result.agentInfo,
          authentication: result.authentication,
          checks: [
            initialized,
            {
              check: "acp_capabilities",
              status: "passed",
              message: "ACP required capabilities are available."
            },
            failedCheck("acp_authenticated", "auth_required", result.message)
          ]
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
      const negotiated = {
        version: "planweave.runner/v1",
        required: result.capabilitySnapshot.required,
        available,
        negotiated: result.capabilitySnapshot.negotiated
      } as const;
      return {
        executionIntegration: null,
        negotiatedCapabilities: negotiated,
        acpCapabilitySnapshot: result.capabilitySnapshot,
        availableCapabilities: available,
        agentInfo: result.agentInfo,
        authentication: result.authentication,
        sessionConfig: result.sessionConfig ?? null,
        checks: [
          initialized,
          {
            check: "acp_capabilities",
            status: "passed",
            message: "ACP required capabilities are available."
          },
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
      const resolved = await resolveAcpExecutionProfile({
        executorProfile: input.profile,
        projectRoot: input.projectRoot,
        executorSource: input.profileSource ?? "package",
        resolver: profileResolver
      });
      const launch = resolved.profile.launch;
      const recovery = input.runtime?.acpRecovery
        ? acpRunRecoveryExecutionSchema.parse(input.runtime.acpRecovery)
        : null;
      const executionHost = executorProfileExecutionHost(input.profile);
      if (
        recovery &&
        (recovery.claimRef !== input.claim.ref ||
          recovery.agentId !== resolved.profile.agentId ||
          recovery.profileId !== resolved.profile.profileId ||
          recovery.profileFingerprint !== resolved.profile.fingerprint ||
          recovery.executorProfile !== input.executorName ||
          JSON.stringify(recovery.executionHost ?? { kind: "native" }) !==
            JSON.stringify(executionHost))
      ) {
        throw new AcpProfileResolutionError(
          "profile_changed",
          "ACP recovery execution no longer matches the resolved claim/profile identity."
        );
      }
      const prompt = recovery
        ? renderAcpRunRecoveryPrompt({
            renderedPrompt: input.prompt,
            lineage: recovery.lineage,
            interruptionReason: recovery.interruptionReason,
            lastToolStateSummary: recovery.lastToolStateSummary
          })
        : input.prompt;
      const prepared = await prepareAcpBlockRun({
        projectRoot: input.projectRoot,
        ref: input.claim.ref,
        prompt
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
            prompt,
            cwd: prepared.cwd,
            launch,
            host: resolved.profile.host,
            profileIdentity: {
              profileId: resolved.profile.profileId,
              fingerprint: resolved.profile.fingerprint,
              source: resolved.profile.source,
              environmentNames: resolved.profile.environment.map((entry) => entry.name)
            },
            environment: resolved.environment,
            shutdown: resolved.profile.shutdown,
            capabilityPolicy: resolved.profile.capabilities,
            authenticationHints: definition.acp.authentication,
            executorName: input.executorName,
            agentId: resolved.profile.agentId,
            taskId: input.claim.taskId,
            metadataIdentity: {
              blockId: input.claim.blockId,
              ...(input.executionWaveId ? { executionWaveId: input.executionWaveId } : {})
            },
            projectId: prepared.projectId,
            canvasId: prepared.canvasId,
            projectRoot:
              typeof input.projectRoot === "string"
                ? input.projectRoot
                : input.projectRoot.rootPath,
            connectionMode: resolved.profile.connection.mode,
            sessionStart: recovery
              ? {
                  kind: "load",
                  sessionId: recovery.lineage.sourceSessionId,
                  recovery: recovery.lineage
                }
              : { kind: "new" }
          },
          {
            signal: input.runtime?.signal,
            timeoutMs: input.runtime?.timeoutMs ?? executorRuntimeLimits(input.profile).timeoutMs,
            interactionBroker: input.runtime?.interactionBroker,
            interactionObserver: input.runtime?.interactionObserver,
            onMetadataPersisted: () => recordBlockRun(dirname(prepared.runDir), prepared.runId),
            sessionDefaults:
              resolved.profile.sessionDefaults ??
              (input.runtime?.desktopRunId && definition.acp.launch
                ? selectedDesktopAcpSessionDefaults(definition.agent)
                : undefined)
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
      const resolved = await resolveAcpExecutionProfile({
        executorProfile: input.profile,
        projectRoot: input.workspace,
        executorSource: input.profileSource ?? "package",
        resolver: profileResolver
      });
      const launch = resolved.profile.launch;
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
          host: resolved.profile.host,
          profileIdentity: {
            profileId: resolved.profile.profileId,
            fingerprint: resolved.profile.fingerprint,
            source: resolved.profile.source,
            environmentNames: resolved.profile.environment.map((entry) => entry.name)
          },
          environment: resolved.environment,
          shutdown: resolved.profile.shutdown,
          capabilityPolicy: resolved.profile.capabilities,
          authenticationHints: definition.acp.authentication,
          executorName: input.executorName,
          agentId: resolved.profile.agentId,
          taskId: input.claim.taskId,
          metadataIdentity: {
            feedbackId: input.claim.feedbackId,
            sourceReviewBlockRef: input.claim.sourceReviewBlockRef
          },
          projectId: prepared.projectId,
          canvasId: prepared.canvasId,
          projectRoot:
            typeof input.workspace === "string" ? input.workspace : input.workspace.rootPath,
          connectionMode: resolved.profile.connection.mode
        },
        {
          signal: input.runtime?.signal,
          timeoutMs: input.runtime?.timeoutMs ?? executorRuntimeLimits(input.profile).timeoutMs,
          interactionBroker: input.runtime?.interactionBroker,
          interactionObserver: input.runtime?.interactionObserver,
          sessionDefaults:
            resolved.profile.sessionDefaults ??
            (input.runtime?.desktopRunId && definition.acp.launch
              ? selectedDesktopAcpSessionDefaults(definition.agent)
              : undefined)
        }
      );
    }
  };
}

export const acpRunner = createAcpRunner();
