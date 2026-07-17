import { createHash } from "node:crypto";
import { z } from "zod";

export const BLOCK_RUN_INDEX_PAGE_SIZE = 64;

export const blockRunIndexEntrySchema = z
  .object({
    runId: z.string().min(1),
    retryIndex: z.number().int().positive(),
    orderedAt: z.string().datetime({ offset: true }),
    stableIdentity: z.string().min(1),
    hasArtifact: z.boolean()
  })
  .strict();

export const blockRunLogicalCursorSchema = blockRunIndexEntrySchema.pick({
  orderedAt: true,
  stableIdentity: true
});

export const blockRunIndexV3PointerSchema = z
  .object({ version: z.literal(3), generation: z.string().min(1) })
  .strict();

export const blockRunIndexV3ManifestSchema = z
  .object({
    version: z.literal(3),
    generation: z.string().min(1),
    pageSize: z.literal(BLOCK_RUN_INDEX_PAGE_SIZE),
    total: z.number().int().nonnegative(),
    headPage: z.number().int().nonnegative(),
    head: blockRunIndexEntrySchema.nullable(),
    latestArtifact: blockRunIndexEntrySchema.nullable()
  })
  .strict();

export const blockRunIndexV3PageSchema = z
  .object({
    version: z.literal(3),
    generation: z.string().min(1),
    page: z.number().int().positive(),
    entries: z.array(blockRunIndexEntrySchema).max(BLOCK_RUN_INDEX_PAGE_SIZE)
  })
  .strict();

const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/);
const pageObjectIdSchema = z.string().regex(/^sha256-[a-f0-9]{64}$/);

export const blockRunIndexV4PointerSchema = z
  .object({
    version: z.literal(4),
    currentGeneration: z.string().min(1),
    previousGeneration: z.string().min(1).nullable()
  })
  .strict();

export const blockRunIndexV4PageDescriptorSchema = z
  .object({
    objectId: pageObjectIdSchema,
    count: z.number().int().positive().max(BLOCK_RUN_INDEX_PAGE_SIZE),
    first: blockRunLogicalCursorSchema,
    last: blockRunLogicalCursorSchema
  })
  .strict();

export const blockRunIndexV4ManifestSchema = z
  .object({
    version: z.literal(4),
    generation: z.string().min(1),
    pageSize: z.literal(BLOCK_RUN_INDEX_PAGE_SIZE),
    total: z.number().int().nonnegative(),
    maxRetryIndex: z.number().int().nonnegative(),
    head: blockRunIndexEntrySchema.nullable(),
    latestArtifact: blockRunIndexEntrySchema.nullable(),
    pages: z.array(blockRunIndexV4PageDescriptorSchema)
  })
  .strict();

export const blockRunIndexV4PageSchema = z
  .object({
    version: z.literal(4),
    objectId: pageObjectIdSchema,
    checksum: checksumSchema,
    entries: z.array(blockRunIndexEntrySchema).min(1).max(BLOCK_RUN_INDEX_PAGE_SIZE)
  })
  .strict();

export type BlockRunIndexEntry = z.infer<typeof blockRunIndexEntrySchema>;
export type BlockRunLogicalCursor = z.infer<typeof blockRunLogicalCursorSchema>;
export type BlockRunIndexV3Manifest = z.infer<typeof blockRunIndexV3ManifestSchema>;
export type BlockRunIndexV4Manifest = z.infer<typeof blockRunIndexV4ManifestSchema>;

export function blockRunIndexPageChecksum(entries: readonly BlockRunIndexEntry[]): string {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function blockRunIndexPageObjectId(entries: readonly BlockRunIndexEntry[]): string {
  return `sha256-${blockRunIndexPageChecksum(entries)}`;
}
