import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readBlockRunIndexEntry,
  readBlockRunIndexSummary,
  readBlockRunIndexView,
  recordBlockRunArtifactInIndex,
  recordBlockRunInIndex,
  removeBlockRunFromIndex,
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

async function writeRunMetadata(runRoot: string, runId: string, startedAt: string): Promise<void> {
  const runDir = join(runRoot, runId);
  await mkdir(runDir, { recursive: true });
  await writeJsonFile(join(runDir, "metadata.json"), {
    runId,
    ref: "T-001#B-001",
    startedAt,
    finishedAt: null
  });
}

async function readCurrentV4Manifest(runRoot: string) {
  const indexRoot = join(runRoot, ".planweave-task-workspace-run-index");
  const pointer = blockRunIndexV4PointerSchema.parse(
    JSON.parse(await readFile(join(indexRoot, "current.json"), "utf8")) as unknown
  );
  const manifest = blockRunIndexV4ManifestSchema.parse(
    JSON.parse(
      await readFile(
        join(indexRoot, "generations", pointer.currentGeneration, "manifest.json"),
        "utf8"
      )
    ) as unknown
  );
  return { indexRoot, pointer, manifest };
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

describe("block run index v4 mutations", () => {
  it("migrates v3 on first mutation and keeps retry indexes monotonic after removal", async () => {
    const runRoot = await temporaryRunRoot("migration-mutation");
    await writeV3Fixture(runRoot);
    await writeRunMetadata(runRoot, "RUN-004", "2026-07-17T04:00:00.000Z");

    await recordBlockRunInIndex(runRoot, "RUN-004");
    let current = await readCurrentV4Manifest(runRoot);
    expect(current.pointer.previousGeneration).toBeNull();
    expect(current.manifest.maxRetryIndex).toBe(4);
    expect(await readdir(join(current.indexRoot, "generations"))).toEqual([
      current.pointer.currentGeneration
    ]);

    await removeBlockRunFromIndex(runRoot, "RUN-004");
    await writeRunMetadata(runRoot, "RUN-005", "2026-07-17T05:00:00.000Z");
    await recordBlockRunInIndex(runRoot, "RUN-005");
    current = await readCurrentV4Manifest(runRoot);
    await expect(readBlockRunIndexEntry(runRoot, "RUN-005")).resolves.toMatchObject({
      retryIndex: 5
    });
    expect(current.manifest.maxRetryIndex).toBe(5);
    expect(await readdir(join(current.indexRoot, "generations"))).toHaveLength(2);
  });

  it("inserts out-of-order runs without changing public chronology", async () => {
    const runRoot = await temporaryRunRoot("out-of-order");
    await writeRunMetadata(runRoot, "RUN-001", "2026-07-17T01:00:00.000Z");
    await recordBlockRunInIndex(runRoot, "RUN-001");
    await writeRunMetadata(runRoot, "RUN-003", "2026-07-17T03:00:00.000Z");
    await recordBlockRunInIndex(runRoot, "RUN-003");
    await writeRunMetadata(runRoot, "RUN-002", "2026-07-17T02:00:00.000Z");
    await recordBlockRunInIndex(runRoot, "RUN-002");

    const view = await readBlockRunIndexView(runRoot, { limit: 3 });
    expect(view.entries.map((entry) => entry.runId)).toEqual(["RUN-003", "RUN-002", "RUN-001"]);
    expect(view.head?.runId).toBe("RUN-003");
  });

  it("COWs one page for a regular append and an old-run artifact update", async () => {
    const runRoot = await temporaryRunRoot("cow");
    for (let index = 1; index <= BLOCK_RUN_INDEX_PAGE_SIZE + 1; index += 1) {
      const runId = `RUN-${String(index).padStart(3, "0")}`;
      await writeRunMetadata(
        runRoot,
        runId,
        new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
      );
      await recordBlockRunInIndex(runRoot, runId);
    }
    const beforeAppend = await readCurrentV4Manifest(runRoot);
    const beforeAppendObjects = new Set(await readdir(join(beforeAppend.indexRoot, "objects")));
    const appendedRunId = `RUN-${String(BLOCK_RUN_INDEX_PAGE_SIZE + 2).padStart(3, "0")}`;
    await writeRunMetadata(runRoot, appendedRunId, "2026-01-01T01:02:00.000Z");
    await recordBlockRunInIndex(runRoot, appendedRunId);
    const afterAppend = await readCurrentV4Manifest(runRoot);
    const afterAppendObjects = new Set(await readdir(join(afterAppend.indexRoot, "objects")));
    expect(
      [...afterAppendObjects].filter((object) => !beforeAppendObjects.has(object))
    ).toHaveLength(1);

    const beforeArtifactObjects = afterAppendObjects;
    await recordBlockRunArtifactInIndex(runRoot, "RUN-001");
    const afterArtifact = await readCurrentV4Manifest(runRoot);
    const afterArtifactObjects = new Set(await readdir(join(afterArtifact.indexRoot, "objects")));
    expect(
      [...afterArtifactObjects].filter((object) => !beforeArtifactObjects.has(object))
    ).toHaveLength(1);
    expect(afterArtifact.manifest.latestArtifact?.runId).toBe("RUN-001");
    expect(await readdir(join(afterArtifact.indexRoot, "generations"))).toHaveLength(2);
  });

  it("updates head and latestArtifact when removing indexed runs", async () => {
    const runRoot = await temporaryRunRoot("remove");
    for (const [runId, startedAt] of [
      ["RUN-001", "2026-07-17T01:00:00.000Z"],
      ["RUN-002", "2026-07-17T02:00:00.000Z"]
    ] as const) {
      await writeRunMetadata(runRoot, runId, startedAt);
      await recordBlockRunInIndex(runRoot, runId);
    }
    await recordBlockRunArtifactInIndex(runRoot, "RUN-002");
    await removeBlockRunFromIndex(runRoot, "RUN-002");
    let summary = await readBlockRunIndexSummary(runRoot);
    expect(summary).toEqual({
      head: expect.objectContaining({ runId: "RUN-001" }),
      latestArtifactRunId: null
    });

    await removeBlockRunFromIndex(runRoot, "RUN-001");
    summary = await readBlockRunIndexSummary(runRoot);
    expect(summary).toEqual({ head: null, latestArtifactRunId: null });
  });

  it("keeps current and previous closures while retrying orphan GC idempotently", async () => {
    const runRoot = await temporaryRunRoot("maintenance");
    await writeRunMetadata(runRoot, "RUN-001", "2026-07-17T01:00:00.000Z");
    await recordBlockRunInIndex(runRoot, "RUN-001");
    await writeRunMetadata(runRoot, "RUN-002", "2026-07-17T02:00:00.000Z");
    await recordBlockRunInIndex(runRoot, "RUN-002");
    const current = await readCurrentV4Manifest(runRoot);
    expect(current.pointer.previousGeneration).not.toBeNull();
    for (const generation of [
      current.pointer.currentGeneration,
      current.pointer.previousGeneration
    ]) {
      if (generation === null) continue;
      const manifest = blockRunIndexV4ManifestSchema.parse(
        JSON.parse(
          await readFile(
            join(current.indexRoot, "generations", generation, "manifest.json"),
            "utf8"
          )
        ) as unknown
      );
      for (const page of manifest.pages) {
        await expect(
          access(join(current.indexRoot, "objects", `${page.objectId}.json`))
        ).resolves.toBeUndefined();
      }
    }

    const orphanGeneration = join(current.indexRoot, "generations", "orphan-generation");
    const orphanObject = join(current.indexRoot, "objects", `sha256-${"0".repeat(64)}.json`);
    await mkdir(orphanGeneration, { recursive: true });
    await writeJsonFile(join(orphanGeneration, "manifest.json"), { orphan: true });
    await writeJsonFile(orphanObject, { orphan: true });

    await recordBlockRunInIndex(runRoot, "RUN-002");
    await expect(access(orphanGeneration)).rejects.toThrow();
    await expect(access(orphanObject)).rejects.toThrow();
    expect(await readdir(join(current.indexRoot, "generations"))).toHaveLength(2);
  });
});
