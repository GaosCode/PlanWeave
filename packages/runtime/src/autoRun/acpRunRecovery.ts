import { z } from "zod";
import { agentFamilySchema } from "../types/executor.js";
import {
  acpSessionIdSchema,
  claimRefSchema,
  executorRunIdSchema
} from "./runnerContractSchemas.js";
import { runnerInteractionClientLabelSchema } from "./runnerInteractionContract.js";
import { safeRunnerEventTextSchema } from "./runnerEventRedaction.js";

export const acpRunRecoveryLineageSchema = z
  .object({
    version: z.literal("planweave.acp-recovery/v1"),
    kind: z.literal("session_load"),
    sourceRecordId: z.string().min(1).max(2048),
    sourceRunId: executorRunIdSchema,
    sourceSessionId: acpSessionIdSchema,
    sourceTerminalEventSequence: z.number().int().positive(),
    requestedAt: z.string().datetime(),
    requestedBy: runnerInteractionClientLabelSchema
  })
  .strict();
export type AcpRunRecoveryLineage = z.infer<typeof acpRunRecoveryLineageSchema>;

export const acpLaunchIdentitySchema = z
  .object({
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(16_384)).max(256)
  })
  .strict();
export type AcpLaunchIdentity = z.infer<typeof acpLaunchIdentitySchema>;

export const acpSessionStartSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new") }).strict(),
  z
    .object({
      kind: z.literal("load"),
      sessionId: acpSessionIdSchema,
      recovery: acpRunRecoveryLineageSchema
    })
    .strict()
]);
export type AcpSessionStart = z.infer<typeof acpSessionStartSchema>;

export const acpRecoveryInterruptionReasonSchema = z.enum([
  "owner_lost",
  "transport_lost",
  "timed_out",
  "recoverable_cancel"
]);
export type AcpRecoveryInterruptionReason = z.infer<typeof acpRecoveryInterruptionReasonSchema>;

export const acpRunRecoveryExecutionSchema = z
  .object({
    lineage: acpRunRecoveryLineageSchema,
    claimRef: claimRefSchema,
    agentId: agentFamilySchema,
    executorProfile: z.string().min(1).max(256),
    launch: acpLaunchIdentitySchema,
    interruptionReason: acpRecoveryInterruptionReasonSchema,
    lastToolStateSummary: safeRunnerEventTextSchema(4096, "Recovery tool state summary").nullable()
  })
  .strict();
export type AcpRunRecoveryExecution = z.infer<typeof acpRunRecoveryExecutionSchema>;

export const acpRunRecoveryUnavailableReasonSchema = z.enum([
  "not_latest_main_run",
  "runner_not_acp",
  "source_not_terminal",
  "terminal_reason_not_recoverable",
  "source_identity_invalid",
  "session_unavailable",
  "agent_mismatch",
  "executor_profile_mismatch",
  "launch_mismatch",
  "load_session_unavailable",
  "block_not_blocked",
  "dependencies_incomplete",
  "active_run_exists",
  "newer_recovery_exists",
  "interactions_pending"
]);
export type AcpRunRecoveryUnavailableReason = z.infer<typeof acpRunRecoveryUnavailableReasonSchema>;

export type AcpRunRecoveryEligibility =
  | { available: true; reason: null }
  | { available: false; reason: AcpRunRecoveryUnavailableReason };

export type AcpRunRecoveryEligibilityInput = {
  latestMainRun: boolean;
  runnerKind: "acp" | "cli" | null;
  terminal: boolean;
  interruptionReason: AcpRecoveryInterruptionReason | null;
  sourceIdentityValid: boolean;
  sessionId: string | null;
  sourceAgentId: string | null;
  resolvedAgentId: string | null;
  sourceExecutorProfile: string | null;
  resolvedExecutorProfile: string | null;
  sourceLaunch: AcpLaunchIdentity | null;
  resolvedLaunch: AcpLaunchIdentity | null;
  loadSessionAvailable: boolean;
  blockStatus: string;
  dependenciesCompleted: boolean;
  activeOrResumableRun: boolean;
  newerRecoveryChild: boolean;
  interactionsSettled: boolean;
};

function sameLaunch(left: AcpLaunchIdentity, right: AcpLaunchIdentity): boolean {
  return (
    left.command === right.command &&
    left.args.length === right.args.length &&
    left.args.every((argument, index) => argument === right.args[index])
  );
}

export function evaluateAcpRunRecovery(
  input: AcpRunRecoveryEligibilityInput
): AcpRunRecoveryEligibility {
  if (!input.latestMainRun) return { available: false, reason: "not_latest_main_run" };
  if (input.runnerKind !== "acp") return { available: false, reason: "runner_not_acp" };
  if (!input.terminal) return { available: false, reason: "source_not_terminal" };
  if (input.interruptionReason === null) {
    return { available: false, reason: "terminal_reason_not_recoverable" };
  }
  if (!input.sourceIdentityValid) return { available: false, reason: "source_identity_invalid" };
  if (input.sessionId === null) return { available: false, reason: "session_unavailable" };
  if (input.sourceAgentId === null || input.sourceAgentId !== input.resolvedAgentId) {
    return { available: false, reason: "agent_mismatch" };
  }
  if (
    input.sourceExecutorProfile === null ||
    input.sourceExecutorProfile !== input.resolvedExecutorProfile
  ) {
    return { available: false, reason: "executor_profile_mismatch" };
  }
  if (
    input.sourceLaunch === null ||
    input.resolvedLaunch === null ||
    !sameLaunch(input.sourceLaunch, input.resolvedLaunch)
  ) {
    return { available: false, reason: "launch_mismatch" };
  }
  if (!input.loadSessionAvailable) {
    return { available: false, reason: "load_session_unavailable" };
  }
  if (input.blockStatus !== "blocked") return { available: false, reason: "block_not_blocked" };
  if (!input.dependenciesCompleted) {
    return { available: false, reason: "dependencies_incomplete" };
  }
  if (input.activeOrResumableRun) return { available: false, reason: "active_run_exists" };
  if (input.newerRecoveryChild) return { available: false, reason: "newer_recovery_exists" };
  if (!input.interactionsSettled) return { available: false, reason: "interactions_pending" };
  return { available: true, reason: null };
}

export function renderAcpRunRecoveryPrompt(options: {
  renderedPrompt: string;
  lineage: AcpRunRecoveryLineage;
  interruptionReason: AcpRecoveryInterruptionReason;
  lastToolStateSummary: string | null;
}): string {
  const lineage = acpRunRecoveryLineageSchema.parse(options.lineage);
  const renderedPrompt = options.renderedPrompt.trim();
  if (!renderedPrompt) throw new Error("ACP recovery requires the current rendered Block prompt.");
  const toolState = options.lastToolStateSummary?.trim() || "No persisted tool state is available.";
  return [
    renderedPrompt,
    "",
    "## ACP interruption recovery",
    "",
    `This is a new execution attempt recovering source record \`${lineage.sourceRecordId}\` (run \`${lineage.sourceRunId}\`, session \`${lineage.sourceSessionId}\`).`,
    `The source attempt ended because of \`${options.interruptionReason}\`; do not assume its in-flight operation completed.`,
    `Last persisted tool state (redacted): ${toolState}`,
    "Before changing files, inspect the current workspace, `git diff`, and relevant artifacts to determine what partial work already exists.",
    "All pending permissions from the source attempt are invalid. Never replay or approve an old pending command; request a new permission in this attempt if needed.",
    "Complete only the remaining work and produce the final artifact required by this new attempt's artifact contract."
  ].join("\n");
}
