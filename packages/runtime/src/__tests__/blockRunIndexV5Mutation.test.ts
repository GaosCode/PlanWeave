import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BLOCK_RUN_INDEX_PAGE_SIZE,
  BLOCK_RUN_INDEX_TREE_DEPTH,
  BLOCK_RUN_INDEX_TREE_FANOUT,
  blockRunIndexPageObjectId,
  type BlockRunIndexEntry,
  type BlockRunIndexV4PageDescriptor,
  type BlockRunIndexV5Manifest
} from "../autoRun/blockRunIndexSchema.js";
import { planBlockRunIndexV5Mutation } from "../autoRun/blockRunIndexV5Mutation.js";
import {
  mutateBlockRunIndex,
  readBlockRunIndexSnapshot,
  replaceBlockRunIndexWithV5
} from "../autoRun/blockRunIndexStorage.js";
import { buildBlockRunIndexV5Tree } from "../autoRun/blockRunIndexV5Tree.js";
import * as optionalFile from "../fs/optionalFile.js";
import { writeJsonFile } from "../json.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

function entryFor(index: number, hasArtifact = false): BlockRunIndexEntry {
  const runId = `RUN-${String(index).padStart(6, "0")}`;
  return {
    runId,
    retryIndex: index,
    orderedAt: new Date(index * 1_000).toISOString(),
    stableIdentity: `T-001#B-001::${runId}`,
    hasArtifact
  };
}

function mutationEntryFor(index: number): Omit<BlockRunIndexEntry, "retryIndex"> {
  const entry = entryFor(index);
  return {
    runId: entry.runId,
    orderedAt: entry.orderedAt,
    stableIdentity: entry.stableIdentity,
    hasArtifact: entry.hasArtifact
  };
}

function descriptorFor(entries: readonly BlockRunIndexEntry[]): BlockRunIndexV4PageDescriptor {
  const first = entries[0];
  const last = entries.at(-1);
  if (!(first && last)) throw new Error("Expected a populated test page.");
  return {
    objectId: blockRunIndexPageObjectId(entries),
    count: entries.length,
    first: { orderedAt: first.orderedAt, stableIdentity: first.stableIdentity },
    last: { orderedAt: last.orderedAt, stableIdentity: last.stableIdentity }
  };
}

async function fixture(runCount: number, artifactIndexes: ReadonlySet<number> = new Set()) {
  const indexRoot = await mkdtemp(join(tmpdir(), "planweave-index-v5-mutation-"));
  temporaryRoots.push(indexRoot);
  const entries = Array.from({ length: runCount }, (_, index) =>
    entryFor(index + 1, artifactIndexes.has(index + 1))
  );
  const pages = new Map<string, BlockRunIndexEntry[]>();
  const descriptors: BlockRunIndexV4PageDescriptor[] = [];
  for (let start = 0; start < entries.length; start += BLOCK_RUN_INDEX_PAGE_SIZE) {
    const pageEntries = entries.slice(start, start + BLOCK_RUN_INDEX_PAGE_SIZE);
    const descriptor = descriptorFor(pageEntries);
    pages.set(descriptor.objectId, pageEntries);
    descriptors.push(descriptor);
  }
  const tree = buildBlockRunIndexV5Tree(descriptors);
  await mkdir(join(indexRoot, "nodes"), { recursive: true });
  await Promise.all(
    [...tree.nodes].map(([objectId, node]) =>
      writeJsonFile(join(indexRoot, "nodes", `${objectId}.json`), node)
    )
  );
  const latestArtifact = entries.filter((entry) => entry.hasArtifact).at(-1) ?? null;
  const manifest: BlockRunIndexV5Manifest = {
    version: 5,
    generation: "generation-1",
    pageSize: BLOCK_RUN_INDEX_PAGE_SIZE,
    treeFanout: BLOCK_RUN_INDEX_TREE_FANOUT,
    treeDepth: BLOCK_RUN_INDEX_TREE_DEPTH,
    total: entries.length,
    pageCount: descriptors.length,
    maxRetryIndex: entries.length,
    head: entries.at(-1) ?? null,
    latestArtifact,
    rootNodeId: tree.rootNodeId
  };
  let pageReads = 0;
  return {
    entries,
    manifest,
    indexRoot,
    get pageReads() {
      return pageReads;
    },
    async readPage(descriptor: BlockRunIndexV4PageDescriptor) {
      pageReads += 1;
      const page = pages.get(descriptor.objectId);
      if (!page) throw new Error(`Missing test page '${descriptor.objectId}'.`);
      return [...page];
    }
  };
}

function nodeReadCount(spy: ReturnType<typeof vi.spyOn>): number {
  return spy.mock.calls.filter(([path]) => path.includes(`${join("nodes")}/`)).length;
}

function pageReadCount(spy: ReturnType<typeof vi.spyOn>): number {
  return spy.mock.calls.filter(([path]) => path.includes(`${join("objects")}/`)).length;
}

describe("block run index v5 mutation planning", () => {
  it("keeps 5k and 10k tail append reads fixed by tree depth", async () => {
    const measurements: Array<{ nodes: number; pages: number }> = [];
    for (const runCount of [5_000, 10_000]) {
      const context = await fixture(runCount);
      const readSpy = vi.spyOn(optionalFile, "optionalReadFile");
      const plan = await planBlockRunIndexV5Mutation(context, {
        kind: "upsert",
        entry: mutationEntryFor(runCount + 1)
      });
      expect(plan.kind).toBe("publish");
      measurements.push({ nodes: nodeReadCount(readSpy), pages: context.pageReads });
      readSpy.mockRestore();
    }
    expect(measurements).toEqual([
      { nodes: BLOCK_RUN_INDEX_TREE_DEPTH * 2, pages: 1 },
      { nodes: BLOCK_RUN_INDEX_TREE_DEPTH * 2, pages: 1 }
    ]);
  });

  it("bounds end-to-end 5k and 10k tail append reads by fixed depth", async () => {
    const measurements: Array<{ nodes: number; pages: number }> = [];
    for (const runCount of [5_000, 10_000]) {
      const runRoot = await mkdtemp(join(tmpdir(), "planweave-index-v5-append-"));
      temporaryRoots.push(runRoot);
      const entries = Array.from({ length: runCount }, (_, index) => entryFor(index + 1));
      await replaceBlockRunIndexWithV5(runRoot, null, entries);
      const snapshot = await readBlockRunIndexSnapshot(runRoot);
      if (snapshot?.version !== 5) throw new Error("Expected a populated v5 index.");
      await mutateBlockRunIndex(runRoot, snapshot, {
        kind: "upsert",
        entry: mutationEntryFor(runCount + 1)
      });
      const nextSnapshot = await readBlockRunIndexSnapshot(runRoot);
      if (nextSnapshot?.version !== 5) throw new Error("Expected a next v5 index generation.");
      const readSpy = vi.spyOn(optionalFile, "optionalReadFile");
      await mutateBlockRunIndex(runRoot, nextSnapshot, {
        kind: "upsert",
        entry: mutationEntryFor(runCount + 2)
      });
      measurements.push({ nodes: nodeReadCount(readSpy), pages: pageReadCount(readSpy) });
      readSpy.mockRestore();
    }
    expect(measurements[0]).toEqual(measurements[1]);
    expect(measurements[0]?.pages).toBe(2);
    expect(measurements[0]?.nodes).toBeLessThanOrEqual(BLOCK_RUN_INDEX_TREE_DEPTH * 6);
  });

  it("locates out-of-order insert and existing upsert without a descriptor scan", async () => {
    const context = await fixture(320);
    const readSpy = vi.spyOn(optionalFile, "optionalReadFile");
    const inserted = entryFor(129);
    const insertPlan = await planBlockRunIndexV5Mutation(context, {
      kind: "upsert",
      entry: {
        runId: "RUN-129-SECONDARY",
        orderedAt: inserted.orderedAt,
        stableIdentity: `${inserted.stableIdentity}-secondary`,
        hasArtifact: false
      }
    });
    expect(insertPlan.kind).toBe("publish");
    expect(context.pageReads).toBe(1);
    expect(nodeReadCount(readSpy)).toBe(BLOCK_RUN_INDEX_TREE_DEPTH * 2);

    readSpy.mockClear();
    const pageReadsBeforeUpsert = context.pageReads;
    const existing = context.entries[128];
    if (!existing) throw new Error("Expected an existing test entry.");
    const upsertPlan = await planBlockRunIndexV5Mutation(context, {
      kind: "upsert",
      entry: {
        runId: existing.runId,
        orderedAt: existing.orderedAt,
        stableIdentity: existing.stableIdentity,
        hasArtifact: true
      }
    });
    expect(upsertPlan.kind).toBe("publish");
    expect(context.pageReads - pageReadsBeforeUpsert).toBe(1);
    expect(nodeReadCount(readSpy)).toBe(BLOCK_RUN_INDEX_TREE_DEPTH * 2);
  });

  it("walks backward only as needed when removing the latest artifact", async () => {
    const context = await fixture(320, new Set([65, 320]));
    const readSpy = vi.spyOn(optionalFile, "optionalReadFile");
    const removed = context.entries.at(-1);
    if (!removed) throw new Error("Expected a removable test entry.");
    const plan = await planBlockRunIndexV5Mutation(context, {
      kind: "remove",
      runId: removed.runId,
      cursor: removed
    });
    if (plan.kind !== "publish") throw new Error("Expected a published removal plan.");
    expect(plan.draft.manifest.latestArtifact?.runId).toBe(entryFor(65).runId);
    expect(context.pageReads).toBeLessThanOrEqual(context.manifest.pageCount);
    expect(nodeReadCount(readSpy)).toBeLessThanOrEqual(
      (context.pageReads + 2) * BLOCK_RUN_INDEX_TREE_DEPTH
    );
  });
});
