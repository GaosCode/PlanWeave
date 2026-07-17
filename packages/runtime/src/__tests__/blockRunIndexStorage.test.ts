import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readBlockRunIndexEntry,
  readBlockRunIndexSummary,
  readBlockRunIndexView,
  requireBlockRunIndex
} from "../autoRun/blockRunIndex.js";
import {
  BLOCK_RUN_INDEX_PAGE_SIZE,
  blockRunIndexPageChecksum,
  blockRunIndexPageObjectId,
  blockRunIndexV4ManifestSchema,
  blockRunIndexV4PageSchema,
  blockRunIndexV4PointerSchema,
  type BlockRunIndexEntry
} from "../autoRun/blockRunIndexSchema.js";
import { writeJsonFile } from "../json.js";

const temporaryRoots: string[] = [];
const unsupportedPointerPattern = /unsupported or malformed pointer contract/;
const checksumMismatchPattern = /checksum mismatch/;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function temporaryRunRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `planweave-block-run-index-${label}-`));
  temporaryRoots.push(root);
  return root;
}

const entries: readonly [BlockRunIndexEntry, BlockRunIndexEntry, BlockRunIndexEntry] = [
  {
    runId: "RUN-001",
    retryIndex: 1,
    orderedAt: "2026-07-17T01:00:00.000Z",
    stableIdentity: "T-001#B-001::RUN-001",
    hasArtifact: false
  },
  {
    runId: "RUN-002",
    retryIndex: 2,
    orderedAt: "2026-07-17T02:00:00.000Z",
    stableIdentity: "T-001#B-001::RUN-002",
    hasArtifact: true
  },
  {
    runId: "RUN-003",
    retryIndex: 3,
    orderedAt: "2026-07-17T03:00:00.000Z",
    stableIdentity: "T-001#B-001::RUN-003",
    hasArtifact: false
  }
];

async function writeV3Fixture(runRoot: string): Promise<void> {
  const generation = "v3-fixture";
  const generationRoot = join(
    runRoot,
    ".planweave-task-workspace-run-index",
    "generations",
    generation
  );
  await writeJsonFile(join(generationRoot, "page-000001.json"), {
    version: 3,
    generation,
    page: 1,
    entries
  });
  await writeJsonFile(join(generationRoot, "manifest.json"), {
    version: 3,
    generation,
    pageSize: BLOCK_RUN_INDEX_PAGE_SIZE,
    total: entries.length,
    headPage: 1,
    head: entries.at(-1),
    latestArtifact: entries[1]
  });
  await writeJsonFile(join(runRoot, ".planweave-task-workspace-run-index", "current.json"), {
    version: 3,
    generation
  });
}

async function writeV4Fixture(runRoot: string): Promise<void> {
  const [firstEntry, , lastEntry] = entries;
  const generation = "v4-fixture";
  const objectId = blockRunIndexPageObjectId(entries);
  const indexRoot = join(runRoot, ".planweave-task-workspace-run-index");
  await writeJsonFile(join(indexRoot, "objects", `${objectId}.json`), {
    version: 4,
    objectId,
    checksum: blockRunIndexPageChecksum(entries),
    entries
  });
  await writeJsonFile(join(indexRoot, "generations", generation, "manifest.json"), {
    version: 4,
    generation,
    pageSize: BLOCK_RUN_INDEX_PAGE_SIZE,
    total: entries.length,
    maxRetryIndex: 3,
    head: entries.at(-1),
    latestArtifact: entries[1],
    pages: [
      {
        objectId,
        count: entries.length,
        first: {
          orderedAt: firstEntry.orderedAt,
          stableIdentity: firstEntry.stableIdentity
        },
        last: {
          orderedAt: lastEntry.orderedAt,
          stableIdentity: lastEntry.stableIdentity
        }
      }
    ]
  });
  await writeJsonFile(join(indexRoot, "current.json"), {
    version: 4,
    currentGeneration: generation,
    previousGeneration: null
  });
}

describe("block run index v4 schemas", () => {
  it("strictly validates pointer, manifest, and page objects", () => {
    expect(
      blockRunIndexV4PointerSchema.safeParse({
        version: 4,
        currentGeneration: "generation-1",
        previousGeneration: null,
        extra: true
      }).success
    ).toBe(false);
    expect(
      blockRunIndexV4ManifestSchema.safeParse({
        version: 4,
        generation: "generation-1",
        pageSize: BLOCK_RUN_INDEX_PAGE_SIZE,
        total: 0,
        maxRetryIndex: 0,
        head: null,
        latestArtifact: null,
        pages: [],
        extra: true
      }).success
    ).toBe(false);
    expect(
      blockRunIndexV4PageSchema.safeParse({
        version: 4,
        objectId: blockRunIndexPageObjectId(entries),
        checksum: blockRunIndexPageChecksum(entries),
        entries,
        extra: true
      }).success
    ).toBe(false);
  });
});

describe("block run index version compatibility", () => {
  it("keeps public v3 and v4 query results equivalent", async () => {
    const v3RunRoot = await temporaryRunRoot("v3");
    const v4RunRoot = await temporaryRunRoot("v4");
    await writeV3Fixture(v3RunRoot);
    await writeV4Fixture(v4RunRoot);
    const before = {
      orderedAt: entries[2].orderedAt,
      stableIdentity: entries[2].stableIdentity
    };

    const [v3View, v4View] = await Promise.all([
      readBlockRunIndexView(v3RunRoot, { before, limit: 1 }),
      readBlockRunIndexView(v4RunRoot, { before, limit: 1 })
    ]);
    expect(v4View).toEqual(v3View);
    expect(v4View).toEqual({
      entries: [entries[1]],
      hasMore: true,
      head: entries[2],
      latestArtifact: entries[1]
    });
    await expect(readBlockRunIndexSummary(v4RunRoot)).resolves.toEqual(
      await readBlockRunIndexSummary(v3RunRoot)
    );
    await expect(readBlockRunIndexEntry(v4RunRoot, "RUN-001")).resolves.toEqual(
      await readBlockRunIndexEntry(v3RunRoot, "RUN-001")
    );
  });

  it("fails closed for unknown versions", async () => {
    const runRoot = await temporaryRunRoot("unknown");
    await writeJsonFile(join(runRoot, ".planweave-task-workspace-run-index", "current.json"), {
      version: 5,
      currentGeneration: "future"
    });

    await expect(requireBlockRunIndex(runRoot)).rejects.toThrow(unsupportedPointerPattern);
    await expect(readBlockRunIndexView(runRoot, { limit: 1 })).rejects.toThrow(
      unsupportedPointerPattern
    );
  });
});

describe("block run index v4 integrity", () => {
  it("fails closed when a v4 page checksum does not match its entries", async () => {
    const runRoot = await temporaryRunRoot("checksum");
    await writeV4Fixture(runRoot);
    const objectId = blockRunIndexPageObjectId(entries);
    await writeJsonFile(
      join(runRoot, ".planweave-task-workspace-run-index", "objects", `${objectId}.json`),
      {
        version: 4,
        objectId,
        checksum: "0".repeat(blockRunIndexPageChecksum(entries).length),
        entries
      }
    );

    await expect(readBlockRunIndexView(runRoot, { limit: 1 })).rejects.toThrow(
      checksumMismatchPattern
    );
  });
});
