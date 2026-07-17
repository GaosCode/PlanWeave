import {
  BLOCK_RUN_INDEX_PAGE_SIZE,
  blockRunIndexPageObjectId,
  compareBlockRunChronology,
  type BlockRunIndexEntry,
  type BlockRunIndexV4PageDescriptor,
  type BlockRunIndexV5Manifest,
  type BlockRunIndexV5Retirement
} from "./blockRunIndexSchema.js";
import {
  buildBlockRunIndexV5Tree,
  locateBlockRunIndexV5Descriptor,
  readBlockRunIndexV5DescriptorAt,
  updateBlockRunIndexV5Tree,
  type BlockRunIndexV5TreeBuild
} from "./blockRunIndexV5Tree.js";

export type BlockRunIndexMutation =
  | {
      kind: "upsert";
      entry: Omit<BlockRunIndexEntry, "retryIndex">;
    }
  | {
      kind: "markArtifact";
      cursor: Pick<BlockRunIndexEntry, "orderedAt" | "stableIdentity">;
      runId: string;
    }
  | {
      kind: "remove";
      cursor: Pick<BlockRunIndexEntry, "orderedAt" | "stableIdentity">;
      runId: string;
    };

export interface BlockRunIndexV5MutationDraft {
  manifest: {
    total: number;
    pageCount: number;
    maxRetryIndex: number;
    head: BlockRunIndexEntry | null;
    latestArtifact: BlockRunIndexEntry | null;
  };
  newPages: Map<string, readonly BlockRunIndexEntry[]>;
  tree: BlockRunIndexV5TreeBuild;
  retirement: BlockRunIndexV5Retirement;
}

export type BlockRunIndexV5MutationPlan =
  | { kind: "unchanged" }
  | { kind: "publish"; draft: BlockRunIndexV5MutationDraft };

export interface BlockRunIndexV5MutationContext {
  indexRoot: string;
  manifest: BlockRunIndexV5Manifest;
  readPage(descriptor: BlockRunIndexV4PageDescriptor): Promise<BlockRunIndexEntry[]>;
}

function pageDescriptor(entries: readonly BlockRunIndexEntry[]): BlockRunIndexV4PageDescriptor {
  const first = entries[0];
  const last = entries.at(-1);
  if (!(first && last)) throw new Error("Cannot describe an empty block run index page.");
  return {
    objectId: blockRunIndexPageObjectId(entries),
    count: entries.length,
    first: { orderedAt: first.orderedAt, stableIdentity: first.stableIdentity },
    last: { orderedAt: last.orderedAt, stableIdentity: last.stableIdentity }
  };
}

function recordPage(
  entries: readonly BlockRunIndexEntry[],
  newPages: Map<string, readonly BlockRunIndexEntry[]>
): BlockRunIndexV4PageDescriptor {
  const descriptor = pageDescriptor(entries);
  newPages.set(descriptor.objectId, entries);
  return descriptor;
}

async function descriptorAfterReplacement(
  context: BlockRunIndexV5MutationContext,
  targetPageIndex: number,
  replacement: readonly BlockRunIndexV4PageDescriptor[],
  pageIndex: number
): Promise<BlockRunIndexV4PageDescriptor> {
  const replacementIndex = pageIndex - targetPageIndex;
  if (replacementIndex >= 0 && replacementIndex < replacement.length) {
    const descriptor = replacement[replacementIndex];
    if (descriptor) return descriptor;
  }
  const pageCountDelta = replacement.length - 1;
  const previousPageIndex = pageIndex < targetPageIndex ? pageIndex : pageIndex - pageCountDelta;
  const rootNodeId = context.manifest.rootNodeId;
  if (!rootNodeId) throw new Error("Block run index v5 manifest root is missing.");
  return readBlockRunIndexV5DescriptorAt(context.indexRoot, rootNodeId, previousPageIndex);
}

async function entriesAfterReplacement(
  context: BlockRunIndexV5MutationContext,
  targetPageIndex: number,
  replacement: readonly BlockRunIndexV4PageDescriptor[],
  newPages: ReadonlyMap<string, readonly BlockRunIndexEntry[]>,
  pageIndex: number
): Promise<BlockRunIndexEntry[]> {
  const descriptor = await descriptorAfterReplacement(
    context,
    targetPageIndex,
    replacement,
    pageIndex
  );
  const entries = newPages.get(descriptor.objectId);
  if (entries) return [...entries];
  return context.readPage(descriptor);
}

async function findLatestArtifact(
  context: BlockRunIndexV5MutationContext,
  targetPageIndex: number,
  replacement: readonly BlockRunIndexV4PageDescriptor[],
  newPages: ReadonlyMap<string, readonly BlockRunIndexEntry[]>,
  pageCount: number
): Promise<BlockRunIndexEntry | null> {
  for (let pageIndex = pageCount - 1; pageIndex >= 0; pageIndex -= 1) {
    const entries = await entriesAfterReplacement(
      context,
      targetPageIndex,
      replacement,
      newPages,
      pageIndex
    );
    for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
      const entry = entries[entryIndex];
      if (entry?.hasArtifact) return entry;
    }
  }
  return null;
}

async function readHeadAfterReplacement(
  context: BlockRunIndexV5MutationContext,
  targetPageIndex: number,
  replacement: readonly BlockRunIndexV4PageDescriptor[],
  newPages: ReadonlyMap<string, readonly BlockRunIndexEntry[]>,
  pageCount: number
): Promise<BlockRunIndexEntry | null> {
  if (pageCount === 0) return null;
  const entries = await entriesAfterReplacement(
    context,
    targetPageIndex,
    replacement,
    newPages,
    pageCount - 1
  );
  return entries.at(-1) ?? null;
}

export async function planBlockRunIndexV5Mutation(
  context: BlockRunIndexV5MutationContext,
  mutation: BlockRunIndexMutation
): Promise<BlockRunIndexV5MutationPlan> {
  const { manifest } = context;
  if (manifest.pageCount === 0) {
    if (mutation.kind === "markArtifact") {
      throw new Error(`Run '${mutation.runId}' is missing from the block run index.`);
    }
    if (mutation.kind === "remove") return { kind: "unchanged" };
    const entry = { ...mutation.entry, retryIndex: manifest.maxRetryIndex + 1 };
    const descriptor = pageDescriptor([entry]);
    return {
      kind: "publish",
      draft: {
        manifest: {
          total: 1,
          pageCount: 1,
          maxRetryIndex: entry.retryIndex,
          head: entry,
          latestArtifact: entry.hasArtifact ? entry : null
        },
        newPages: new Map([[descriptor.objectId, [entry]]]),
        tree: buildBlockRunIndexV5Tree([descriptor]),
        retirement: { version: 1, objects: [] }
      }
    };
  }

  const rootNodeId = manifest.rootNodeId;
  if (!rootNodeId) throw new Error("Block run index v5 manifest root is missing.");
  const cursor = mutation.kind === "upsert" ? mutation.entry : mutation.cursor;
  const location = await locateBlockRunIndexV5Descriptor(context.indexRoot, rootNodeId, cursor);
  const pageEntries = await context.readPage(location.descriptor);
  const mutationRunId = mutation.kind === "upsert" ? mutation.entry.runId : mutation.runId;
  const existingIndex = pageEntries.findIndex((entry) => entry.runId === mutationRunId);
  if (mutation.kind === "markArtifact" && existingIndex < 0) {
    throw new Error(`Run '${mutation.runId}' is missing from the block run index.`);
  }
  if (mutation.kind === "remove" && existingIndex < 0) return { kind: "unchanged" };

  const newPages = new Map<string, readonly BlockRunIndexEntry[]>();
  let replacement: BlockRunIndexV4PageDescriptor[];
  let total = manifest.total;
  let maxRetryIndex = manifest.maxRetryIndex;
  let head = manifest.head;
  let latestArtifact = manifest.latestArtifact;

  if (mutation.kind === "remove") {
    const removed = pageEntries[existingIndex];
    if (!removed) throw new Error(`Run '${mutation.runId}' is missing from the block run index.`);
    const remaining = pageEntries.filter((entry) => entry.runId !== mutation.runId);
    replacement = remaining.length === 0 ? [] : [recordPage(remaining, newPages)];
    total -= 1;
    const pageCount = manifest.pageCount + replacement.length - 1;
    if (head?.runId === removed.runId) {
      head = await readHeadAfterReplacement(
        context,
        location.pageIndex,
        replacement,
        newPages,
        pageCount
      );
    }
    if (latestArtifact?.runId === removed.runId) {
      latestArtifact = await findLatestArtifact(
        context,
        location.pageIndex,
        replacement,
        newPages,
        pageCount
      );
    }
  } else if (existingIndex >= 0) {
    const existing = pageEntries[existingIndex];
    if (!existing) throw new Error(`Run '${mutationRunId}' is missing from the block run index.`);
    const hasArtifact =
      existing.hasArtifact || mutation.kind === "markArtifact" || mutation.entry.hasArtifact;
    if (hasArtifact === existing.hasArtifact) return { kind: "unchanged" };
    const updated = { ...existing, hasArtifact };
    const updatedEntries = [...pageEntries];
    updatedEntries[existingIndex] = updated;
    replacement = [recordPage(updatedEntries, newPages)];
    if (head?.runId === updated.runId) head = updated;
    if (!latestArtifact || compareBlockRunChronology(updated, latestArtifact) > 0) {
      latestArtifact = updated;
    }
  } else {
    if (mutation.kind !== "upsert") throw new Error("Unexpected block run index mutation.");
    maxRetryIndex += 1;
    const entry: BlockRunIndexEntry = { ...mutation.entry, retryIndex: maxRetryIndex };
    const pageLast = pageEntries.at(-1);
    const isSequentialFullAppend =
      location.pageIndex === manifest.pageCount - 1 &&
      pageEntries.length === BLOCK_RUN_INDEX_PAGE_SIZE &&
      Boolean(pageLast && compareBlockRunChronology(entry, pageLast) > 0);
    if (isSequentialFullAppend) {
      replacement = [location.descriptor, recordPage([entry], newPages)];
    } else {
      const updatedEntries = [...pageEntries, entry].sort(compareBlockRunChronology);
      if (updatedEntries.length <= BLOCK_RUN_INDEX_PAGE_SIZE) {
        replacement = [recordPage(updatedEntries, newPages)];
      } else {
        const splitAt = Math.ceil(updatedEntries.length / 2);
        replacement = [
          recordPage(updatedEntries.slice(0, splitAt), newPages),
          recordPage(updatedEntries.slice(splitAt), newPages)
        ];
      }
    }
    total += 1;
    if (!head || compareBlockRunChronology(entry, head) > 0) head = entry;
    if (
      entry.hasArtifact &&
      (!latestArtifact || compareBlockRunChronology(entry, latestArtifact) > 0)
    ) {
      latestArtifact = entry;
    }
  }

  const pageCount = manifest.pageCount + replacement.length - 1;
  const tree = await updateBlockRunIndexV5Tree(
    context.indexRoot,
    rootNodeId,
    location.pageIndex,
    replacement
  );
  const retiredTreeObjects = tree.retiredObjects;
  if (!retiredTreeObjects) {
    throw new Error("Block run index v5 COW update did not report its retired tree path.");
  }
  const retiredPage = replacement.some(
    (descriptor) => descriptor.objectId === location.descriptor.objectId
  )
    ? []
    : [
        {
          objectId: location.descriptor.objectId,
          level: -1,
          first: location.descriptor.first,
          last: location.descriptor.last
        }
      ];
  return {
    kind: "publish",
    draft: {
      manifest: { total, pageCount, maxRetryIndex, head, latestArtifact },
      newPages,
      tree,
      retirement: { version: 1, objects: [...retiredTreeObjects, ...retiredPage] }
    }
  };
}
