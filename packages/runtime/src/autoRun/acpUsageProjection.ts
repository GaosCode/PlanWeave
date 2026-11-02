import { z } from "zod";
import type { NormalizedRunnerEvent } from "./normalizedEventContract.js";

export const acpContextUsageSnapshotSchema = z
  .object({
    aggregation: z.literal("snapshot"),
    sequence: z.number().int().positive(),
    observedAt: z.string().datetime(),
    usedTokens: z.number().int().nonnegative(),
    /**
     * Zero means "the agent did not report a context window", which is a legal
     * state: not every ACP agent exposes its window size. Requiring a positive
     * value made such agents abort the run while persisting the run record.
     */
    contextWindowTokens: z.number().int().nonnegative(),
    cost: z
      .object({ amount: z.number().nonnegative(), currency: z.string().length(3) })
      .strict()
      .nullable()
  })
  .strict();

const currencyPattern = /^[A-Za-z]{3}$/;

/**
 * Agents may emit a `usage_update` with a partial payload: no window size, or a
 * cost object whose currency is missing or malformed. Normalise instead of
 * throwing, so a cosmetic telemetry gap cannot fail an otherwise healthy run.
 */
function normalizeUsage(body: {
  usedTokens: number;
  contextWindowTokens: number;
  cost: { amount: number; currency: string } | null;
}): {
  usedTokens: number;
  contextWindowTokens: number;
  cost: { amount: number; currency: string } | null;
} {
  const usedTokens = Number.isFinite(body.usedTokens)
    ? Math.max(0, Math.trunc(body.usedTokens))
    : 0;
  const contextWindowTokens = Number.isFinite(body.contextWindowTokens)
    ? Math.max(0, Math.trunc(body.contextWindowTokens))
    : 0;
  const cost =
    body.cost && Number.isFinite(body.cost.amount) && currencyPattern.test(body.cost.currency ?? "")
      ? { amount: Math.max(0, body.cost.amount), currency: body.cost.currency }
      : null;
  return { usedTokens, contextWindowTokens, cost };
}

/**
 * Normalise a raw ACP `usage_update` payload into the runner event shape.
 *
 * Agents may emit a partial payload: no window size (`size: 0`), or a cost
 * object whose currency is missing or malformed. Normalise instead of throwing,
 * so a cosmetic telemetry gap cannot fail an otherwise healthy run. The same
 * sanitiser feeds the persisted event stream, which validates against the
 * agent-host wire contract.
 */
export function normalizeAcpUsageUpdate(update: {
  used: number;
  size: number;
  cost: { amount: number; currency: string } | null;
}): {
  usedTokens: number;
  contextWindowTokens: number;
  cost: { amount: number; currency: string } | null;
} {
  return normalizeUsage({
    usedTokens: update.used,
    contextWindowTokens: update.size,
    cost: update.cost
  });
}

export function projectAcpContextUsage(
  events: readonly Pick<NormalizedRunnerEvent, "sequence" | "timestamp" | "body">[]
): z.infer<typeof acpContextUsageSnapshotSchema> | null {
  let latest: z.infer<typeof acpContextUsageSnapshotSchema> | null = null;
  for (const event of events) {
    if (
      event.body.kind !== "usage_update" ||
      (latest !== null && latest.sequence >= event.sequence)
    )
      continue;
    latest = acpContextUsageSnapshotSchema.parse({
      aggregation: "snapshot",
      sequence: event.sequence,
      observedAt: event.timestamp,
      ...normalizeUsage({
        usedTokens: event.body.usedTokens,
        contextWindowTokens: event.body.contextWindowTokens,
        cost: event.body.cost
      })
    });
  }
  return latest;
}
