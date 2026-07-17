import { z } from "zod";

export const runnerInteractionAvailabilityReasonSchema = z.enum([
  "answered",
  "expired",
  "owner_unavailable",
  "owner_replaced",
  "run_terminal",
  "legacy_history",
  "contract_invalid"
]);
export type RunnerInteractionAvailabilityReason = z.infer<
  typeof runnerInteractionAvailabilityReasonSchema
>;

export const runnerInteractionContractDiagnosticIssueSchema = z
  .object({
    source: z.enum(["mailbox", "metadata", "heartbeat"]),
    message: z.string().min(1).max(512)
  })
  .strict();

export const runnerInteractionContractDiagnosticSchema = z
  .object({
    code: z.literal("contract_invalid"),
    message: z.string().min(1).max(512),
    issues: z.array(runnerInteractionContractDiagnosticIssueSchema).min(1)
  })
  .strict();
export type RunnerInteractionContractDiagnostic = z.infer<
  typeof runnerInteractionContractDiagnosticSchema
>;
