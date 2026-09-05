import { z } from "zod";
import type { NormalizedRunnerEvent } from "./normalizedEventContract.js";

export const acpContextUsageSnapshotSchema = z
  .object({
    aggregation: z.literal("snapshot"),
    sequence: z.number().int().positive(),
    observedAt: z.string().datetime(),
    usedTokens: z.number().int().nonnegative(),
    contextWindowTokens: z.number().int().positive(),
    cost: z
      .object({ amount: z.number().nonnegative(), currency: z.string().length(3) })
      .strict()
      .nullable()
  })
  .strict();

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
      usedTokens: event.body.usedTokens,
      contextWindowTokens: event.body.contextWindowTokens,
      cost: event.body.cost
    });
  }
  return latest;
}
