import { z } from "zod";
import { runnerUsageCostSchema } from "@planweave-ai/agent-host-protocol/browser";
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
    cost: runnerUsageCostSchema
  })
  .strict();

export type AcpUsageCost = NonNullable<z.infer<typeof runnerUsageCostSchema>>;

const currencyPattern = /^[A-Za-z]{3}$/;

/**
 * Classify a reported cost into money, credits, or an unusable value.
 *
 * The previous implementation required a three-letter currency and dropped the
 * whole object otherwise, which silently discarded every CodeBuddy credit
 * (`{amount: 0.66, currency: ""}`). Classifying instead of dropping keeps the
 * amount, and the `unit` field tells the UI whether it can format it.
 */
function normalizeCost(
  cost:
    | { amount: number; currency: string | null; unit?: "currency" | "credits" | "unknown" }
    | null
    | undefined,
  agentId: string | null
): AcpUsageCost | null {
  if (!cost || !Number.isFinite(cost.amount)) return null;
  const amount = Math.max(0, cost.amount);
  const currency = typeof cost.currency === "string" ? cost.currency : "";
  if (currencyPattern.test(currency)) return { amount, currency, unit: "currency" };
  /**
   * This function also runs over already-normalised events (`projectAcpContextUsage`
   * re-normalises the persisted body). A cost classified as "unknown" has its
   * currency nulled, so re-deriving the unit from the empty string would
   * silently relabel it "credits". Trust the earlier verdict instead.
   */
  if (cost.unit === "credits" || cost.unit === "unknown") {
    return { amount, currency: null, unit: cost.unit };
  }
  if (currency === "" && agentId === "codebuddy")
    return { amount, currency: null, unit: "credits" };
  return { amount, currency: null, unit: "unknown" };
}

/**
 * Agents may emit a `usage_update` with a partial payload: no window size, or a
 * cost object whose currency is missing or malformed. Normalise instead of
 * throwing, so a cosmetic telemetry gap cannot fail an otherwise healthy run.
 */
function normalizeUsage(
  body: {
    usedTokens: number;
    contextWindowTokens: number;
    cost: {
      amount: number;
      currency: string | null;
      unit?: "currency" | "credits" | "unknown";
    } | null;
  },
  agentId: string | null = null
): {
  usedTokens: number;
  contextWindowTokens: number;
  cost: AcpUsageCost | null;
} {
  const usedTokens = Number.isFinite(body.usedTokens)
    ? Math.max(0, Math.trunc(body.usedTokens))
    : 0;
  const contextWindowTokens = Number.isFinite(body.contextWindowTokens)
    ? Math.max(0, Math.trunc(body.contextWindowTokens))
    : 0;
  return { usedTokens, contextWindowTokens, cost: normalizeCost(body.cost, agentId) };
}

/**
 * Normalise a raw ACP `usage_update` payload into the runner event shape.
 *
 * The same sanitiser feeds the persisted event stream, which validates against
 * the agent-host wire contract.
 */
export function normalizeAcpUsageUpdate(
  update: {
    used: number;
    size: number;
    cost: { amount: number; currency: string } | null;
  },
  agentId: string | null = null
): {
  usedTokens: number;
  contextWindowTokens: number;
  cost: AcpUsageCost | null;
} {
  return normalizeUsage(
    {
      usedTokens: update.used,
      contextWindowTokens: update.size,
      cost: update.cost
    },
    agentId
  );
}

/**
 * Fold the usage stream into one snapshot with *sticky* fields.
 *
 * Agents commonly close a session with a terminal `usage_update` of
 * `{used: 0, size: 0}` — CodeBuddy does exactly that. Taking the last event
 * verbatim therefore erased the context window and the used-token count that
 * had already been observed, and the UI rendered `0 / 0 Token` (or `NaN%`).
 *
 * Each field is carried forward from the newest event that actually reported
 * it. A genuine reset (`{used: 0, size: <window>}`) still yields `used: 0`
 * because the window is non-zero, so only the fully-empty payload is treated
 * as "no information".
 */
export function projectAcpContextUsage(
  events: readonly Pick<NormalizedRunnerEvent, "sequence" | "timestamp" | "body">[]
): z.infer<typeof acpContextUsageSnapshotSchema> | null {
  let latest: { sequence: number; timestamp: string } | null = null;
  let used: { sequence: number; tokens: number } | null = null;
  let window: { sequence: number; tokens: number } | null = null;
  let cost: { sequence: number; value: AcpUsageCost } | null = null;

  for (const event of events) {
    if (event.body.kind !== "usage_update") continue;
    const normalized = normalizeUsage({
      usedTokens: event.body.usedTokens,
      contextWindowTokens: event.body.contextWindowTokens,
      cost: event.body.cost
    });
    if (latest === null || event.sequence > latest.sequence) {
      latest = { sequence: event.sequence, timestamp: event.timestamp };
    }
    if (
      (normalized.usedTokens > 0 || normalized.contextWindowTokens > 0) &&
      (used === null || event.sequence > used.sequence)
    ) {
      used = { sequence: event.sequence, tokens: normalized.usedTokens };
    }
    if (
      normalized.contextWindowTokens > 0 &&
      (window === null || event.sequence > window.sequence)
    ) {
      window = { sequence: event.sequence, tokens: normalized.contextWindowTokens };
    }
    if (normalized.cost !== null && (cost === null || event.sequence > cost.sequence)) {
      cost = { sequence: event.sequence, value: normalized.cost };
    }
  }

  if (latest === null) return null;

  return acpContextUsageSnapshotSchema.parse({
    aggregation: "snapshot",
    sequence: latest.sequence,
    observedAt: latest.timestamp,
    usedTokens: used?.tokens ?? 0,
    contextWindowTokens: window?.tokens ?? 0,
    cost: cost?.value ?? null
  });
}
