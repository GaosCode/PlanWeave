import { z } from "zod";
import type { NormalizedRunnerEvent } from "./normalizedEventContract.js";

/**
 * How an agent reports credits in `usage_update.cost.amount`.
 *
 * `delta` means each sample is the consumption of one turn, so samples add up.
 * `cumulative` means each sample already carries the running total, so only the
 * last one matters. We start from the shape the payloads suggest and keep
 * `verified: false` until a real run has been reconciled against the agent's own
 * accounting — the UI must not present an unverified sum as authoritative.
 */
export type AcpCreditsSemantics = {
  kind: "delta" | "cumulative" | "unknown";
  verified: boolean;
};

const semanticsByAgent: Record<string, AcpCreditsSemantics> = {
  /**
   * Verified against two real runs on 2026-11-03 by reconciling the ACP samples
   * with CodeBuddy's own `[CreditUsageSource] source=modelUsage` log lines:
   *
   *   log (per request):  1.97, 0.59, 0.55, 0.55, 0.66, 1.99, 0.56, 0.55, 0.55, 0.76
   *   run A samples:            0.59, 0.55, 0.55, 0.66
   *   run B samples:                                  1.99, 0.56, 0.55, 0.55, 0.76
   *
   * Each run's samples match its log slice one-for-one and in order, so a sample
   * is one turn's consumption and the stream is not coalesced. The leading 1.97
   * belongs to a run that was cancelled before it flushed a sample — an aborted
   * run can therefore lose its last turn, which is why a total is only ever a
   * floor for interrupted runs.
   */
  codebuddy: { kind: "delta", verified: true }
};

export function acpCreditsSemantics(agentId: string | null): AcpCreditsSemantics {
  if (agentId === null) return { kind: "unknown", verified: false };
  return semanticsByAgent[agentId] ?? { kind: "unknown", verified: false };
}

export const acpCreditsUsageSchema = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("unavailable"),
      reason: z.string().min(1).max(1_024)
    })
    .strict(),
  z
    .object({
      availability: z.literal("reported"),
      /** The newest sample. Always meaningful, whatever the semantics. */
      lastReportedCredits: z.number().nonnegative(),
      sampleCount: z.number().int().nonnegative(),
      /**
       * Sum of the samples, but only when the semantics are verified as deltas.
       * `null` means "we saw consumption but cannot total it honestly".
       */
      totalCredits: z.number().nonnegative().nullable(),
      semantics: z.enum(["delta", "cumulative", "unknown"])
    })
    .strict()
]);

export type AcpCreditsUsage = z.infer<typeof acpCreditsUsageSchema>;

const noSamplesReason = "The agent did not report any credit usage for this run.";

export function projectAcpCreditsUsage(
  events: readonly Pick<NormalizedRunnerEvent, "sequence" | "body">[],
  options: { agentId: string | null }
): AcpCreditsUsage {
  const samples: { sequence: number; amount: number }[] = [];
  for (const event of events) {
    if (event.body.kind !== "usage_update") continue;
    const cost = event.body.cost;
    if (cost === null || cost.unit !== "credits") continue;
    samples.push({ sequence: event.sequence, amount: cost.amount });
  }

  if (samples.length === 0) {
    return { availability: "unavailable", reason: noSamplesReason };
  }

  const semantics = acpCreditsSemantics(options.agentId);
  const latest = samples.reduce((current, sample) =>
    sample.sequence > current.sequence ? sample : current
  );
  const totalCredits =
    semantics.kind === "delta" && semantics.verified
      ? // Credits carry two decimals; summing floats would surface 1.8000000000000003.
        Math.round(samples.reduce((sum, sample) => sum + sample.amount, 0) * 10_000) / 10_000
      : null;

  return {
    availability: "reported",
    lastReportedCredits: latest.amount,
    sampleCount: samples.length,
    totalCredits,
    semantics: semantics.kind
  };
}
