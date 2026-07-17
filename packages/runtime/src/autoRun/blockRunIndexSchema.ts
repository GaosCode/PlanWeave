import { createHash } from "node:crypto";
import { z } from "zod";

export const BLOCK_RUN_INDEX_PAGE_SIZE = 64;
export const BLOCK_RUN_INDEX_TREE_FANOUT = 64;
export const BLOCK_RUN_INDEX_TREE_DEPTH = 5;
export const BLOCK_RUN_INDEX_MAX_PAGES = BLOCK_RUN_INDEX_TREE_FANOUT ** BLOCK_RUN_INDEX_TREE_DEPTH;

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

export const blockRunIndexV5PointerSchema = z
  .object({
    version: z.literal(5),
    currentGeneration: z.string().min(1),
    previousGeneration: z.string().min(1).nullable()
  })
  .strict();

export const blockRunIndexV5TreeChildSchema = z
  .object({
    objectId: pageObjectIdSchema,
    pageCount: z.number().int().positive(),
    first: blockRunLogicalCursorSchema,
    last: blockRunLogicalCursorSchema
  })
  .strict();

export const blockRunIndexV5LeafSchema = z
  .object({
    version: z.literal(5),
    kind: z.literal("leaf"),
    objectId: pageObjectIdSchema,
    checksum: checksumSchema,
    descriptors: z
      .array(blockRunIndexV4PageDescriptorSchema)
      .min(1)
      .max(BLOCK_RUN_INDEX_TREE_FANOUT)
  })
  .strict();

export const blockRunIndexV5InternalSchema = z
  .object({
    version: z.literal(5),
    kind: z.literal("internal"),
    level: z
      .number()
      .int()
      .min(1)
      .max(BLOCK_RUN_INDEX_TREE_DEPTH - 2),
    objectId: pageObjectIdSchema,
    checksum: checksumSchema,
    children: z.array(blockRunIndexV5TreeChildSchema).min(1).max(BLOCK_RUN_INDEX_TREE_FANOUT)
  })
  .strict();

export const blockRunIndexV5RootSchema = z
  .object({
    version: z.literal(5),
    kind: z.literal("root"),
    objectId: pageObjectIdSchema,
    checksum: checksumSchema,
    children: z.array(blockRunIndexV5TreeChildSchema).min(1).max(BLOCK_RUN_INDEX_TREE_FANOUT)
  })
  .strict();

export const blockRunIndexV5ManifestSchema = z
  .object({
    version: z.literal(5),
    generation: z.string().min(1),
    pageSize: z.literal(BLOCK_RUN_INDEX_PAGE_SIZE),
    treeFanout: z.literal(BLOCK_RUN_INDEX_TREE_FANOUT),
    treeDepth: z.literal(BLOCK_RUN_INDEX_TREE_DEPTH),
    total: z.number().int().nonnegative(),
    pageCount: z.number().int().nonnegative().max(BLOCK_RUN_INDEX_MAX_PAGES),
    maxRetryIndex: z.number().int().nonnegative(),
    head: blockRunIndexEntrySchema.nullable(),
    latestArtifact: blockRunIndexEntrySchema.nullable(),
    rootNodeId: pageObjectIdSchema.nullable()
  })
  .strict()
  .superRefine((manifest, context) => {
    const emptyFieldsAgree =
      manifest.pageCount === 0 &&
      manifest.rootNodeId === null &&
      manifest.head === null &&
      manifest.latestArtifact === null;
    if (manifest.total === 0) {
      if (!emptyFieldsAgree) {
        context.addIssue({
          code: "custom",
          message:
            "An empty block run index must have zero pages and null root, head, and latest artifact."
        });
      }
      return;
    }
    if (manifest.pageCount === 0 || manifest.rootNodeId === null || manifest.head === null) {
      context.addIssue({
        code: "custom",
        message: "A non-empty block run index must have pages, a root node, and a head entry."
      });
    }
    const minimumPageCount = Math.ceil(manifest.total / BLOCK_RUN_INDEX_PAGE_SIZE);
    if (manifest.pageCount < minimumPageCount || manifest.pageCount > manifest.total) {
      context.addIssue({
        code: "custom",
        message: `Block run index pageCount must be between ${String(minimumPageCount)} and total ${String(manifest.total)}.`
      });
    }
  });

export const blockRunIndexV5RetiredObjectSchema = z
  .object({
    objectId: pageObjectIdSchema,
    level: z
      .number()
      .int()
      .min(-1)
      .max(BLOCK_RUN_INDEX_TREE_DEPTH - 1),
    first: blockRunLogicalCursorSchema,
    last: blockRunLogicalCursorSchema
  })
  .strict();

export const blockRunIndexV5RetirementSchema = z
  .object({
    version: z.literal(1),
    objects: z.array(blockRunIndexV5RetiredObjectSchema).max(BLOCK_RUN_INDEX_TREE_DEPTH + 1)
  })
  .strict();

export type BlockRunIndexEntry = z.infer<typeof blockRunIndexEntrySchema>;
export type BlockRunLogicalCursor = z.infer<typeof blockRunLogicalCursorSchema>;
export type BlockRunIndexV3Manifest = z.infer<typeof blockRunIndexV3ManifestSchema>;
export type BlockRunIndexV4Pointer = z.infer<typeof blockRunIndexV4PointerSchema>;
export type BlockRunIndexV4PageDescriptor = z.infer<typeof blockRunIndexV4PageDescriptorSchema>;
export type BlockRunIndexV4Manifest = z.infer<typeof blockRunIndexV4ManifestSchema>;
export type BlockRunIndexV5Pointer = z.infer<typeof blockRunIndexV5PointerSchema>;
export type BlockRunIndexV5TreeChild = z.infer<typeof blockRunIndexV5TreeChildSchema>;
export type BlockRunIndexV5Leaf = z.infer<typeof blockRunIndexV5LeafSchema>;
export type BlockRunIndexV5Internal = z.infer<typeof blockRunIndexV5InternalSchema>;
export type BlockRunIndexV5Root = z.infer<typeof blockRunIndexV5RootSchema>;
export type BlockRunIndexV5Manifest = z.infer<typeof blockRunIndexV5ManifestSchema>;
export type BlockRunIndexV5RetiredObject = z.infer<typeof blockRunIndexV5RetiredObjectSchema>;
export type BlockRunIndexV5Retirement = z.infer<typeof blockRunIndexV5RetirementSchema>;

export function compareBlockRunChronology(
  left: BlockRunLogicalCursor,
  right: BlockRunLogicalCursor
): number {
  const byTime = Date.parse(left.orderedAt) - Date.parse(right.orderedAt);
  return byTime === 0 ? left.stableIdentity.localeCompare(right.stableIdentity) : byTime;
}

export function blockRunIndexPageChecksum(entries: readonly BlockRunIndexEntry[]): string {
  const canonicalEntries = entries.map((entry) => ({
    runId: entry.runId,
    retryIndex: entry.retryIndex,
    orderedAt: entry.orderedAt,
    stableIdentity: entry.stableIdentity,
    hasArtifact: entry.hasArtifact
  }));
  return createHash("sha256").update(JSON.stringify(canonicalEntries)).digest("hex");
}

export function blockRunIndexPageObjectId(entries: readonly BlockRunIndexEntry[]): string {
  return `sha256-${blockRunIndexPageChecksum(entries)}`;
}

export function blockRunIndexTreeNodeChecksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function blockRunIndexTreeNodeObjectId(value: unknown): string {
  return `sha256-${blockRunIndexTreeNodeChecksum(value)}`;
}
