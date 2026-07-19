import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readBlockRunIndexView } from "../autoRun/blockRunIndex.js";
import {
  BLOCK_RUN_INDEX_PAGE_SIZE,
  BLOCK_RUN_INDEX_TREE_DEPTH
} from "../autoRun/blockRunIndexSchema.js";
import {
  mutateBlockRunIndex,
  readBlockRunIndexSnapshot,
  replaceBlockRunIndexWithV5,
  type BlockRunIndexStorageInstrumentation,
  type BlockRunIndexStorageWriteKind
} from "../autoRun/blockRunIndexStorage.js";
import * as optionalFile from "../fs/optionalFile.js";

const temporaryRoots: string[] = [];
const runCount = 10_000;
const firstHalfRunCount = runCount / 2;
const finalRunIndex = runCount + 1;
const runIdWidth = 5;
const linearPayloadRatioLimit = 2.2;
const maxIndexBytes = 4 * 1_024 * 1_024;
const maxFarCursorPageReads = 12;
const maxPayloadBytesPerRun = 24 * 1_024;
const testTimeoutMs = 300_000;
const liveMetadataFileCount = 5;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function temporaryRunRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "planweave-index-performance-"));
  temporaryRoots.push(root);
  return root;
}

async function directoryMetrics(root: string): Promise<{ files: number; bytes: number }> {
  const metrics = await Promise.all(
    (await readdir(root, { withFileTypes: true })).map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return directoryMetrics(path);
      if (entry.isFile()) return { files: 1, bytes: (await stat(path)).size };
      return { files: 0, bytes: 0 };
    })
  );
  return metrics.reduce(
    (total, current) => ({
      files: total.files + current.files,
      bytes: total.bytes + current.bytes
    }),
    { files: 0, bytes: 0 }
  );
}

describe("block run index v5 storage performance", () => {
  it(
    "keeps 10,000 sequential total payload writes linear and bounds real storage",
    async () => {
      const runRoot = await temporaryRunRoot();
      const writes: Record<BlockRunIndexStorageWriteKind, { count: number; bytes: number }> = {
        page: { count: 0, bytes: 0 },
        "tree-node": { count: 0, bytes: 0 },
        retirement: { count: 0, bytes: 0 },
        manifest: { count: 0, bytes: 0 },
        pointer: { count: 0, bytes: 0 }
      };
      const instrumentation: BlockRunIndexStorageInstrumentation = {
        recordWrite(write) {
          writes[write.kind].count += 1;
          writes[write.kind].bytes += write.payloadBytes;
        }
      };

      await replaceBlockRunIndexWithV5(runRoot, null, [], { instrumentation });
      let firstHalfPageBytes = 0;
      let firstHalfTotalBytes = 0;
      for (let index = 1; index <= runCount; index += 1) {
        const snapshot = await readBlockRunIndexSnapshot(runRoot);
        if (!snapshot) throw new Error("Expected block run index during performance write.");
        const runId = `RUN-${String(index).padStart(runIdWidth, "0")}`;
        await mutateBlockRunIndex(
          runRoot,
          snapshot,
          {
            kind: "upsert",
            entry: {
              runId,
              orderedAt: new Date(index * 1_000).toISOString(),
              stableIdentity: `T-001#B-001::${runId}`,
              hasArtifact: false
            }
          },
          { instrumentation }
        );
        if (index === firstHalfRunCount) {
          firstHalfPageBytes = writes.page.bytes;
          firstHalfTotalBytes = Object.values(writes).reduce(
            (total, write) => total + write.bytes,
            0
          );
        }
      }

      expect(writes.page.count).toBe(runCount);
      expect(writes.page.bytes).toBeGreaterThan(firstHalfPageBytes);
      expect(writes.page.bytes).toBeLessThan(firstHalfPageBytes * linearPayloadRatioLimit);
      expect(writes.manifest.count).toBe(runCount + 1);
      expect(writes.pointer.count).toBe(runCount + 1);
      expect(writes.retirement.count).toBe(runCount);
      const totalPayloadBytes = Object.values(writes).reduce(
        (total, write) => total + write.bytes,
        0
      );
      expect(totalPayloadBytes).toBeLessThan(firstHalfTotalBytes * linearPayloadRatioLimit);
      expect(totalPayloadBytes).toBeLessThan(runCount * maxPayloadBytesPerRun);

      const indexRoot = join(runRoot, ".planweave-task-workspace-run-index");
      const expectedPages = Math.ceil(runCount / BLOCK_RUN_INDEX_PAGE_SIZE);
      expect(await readdir(join(indexRoot, "generations"))).toHaveLength(2);
      expect(await readdir(join(indexRoot, "objects"))).toHaveLength(expectedPages + 1);
      const liveNodeCount = (await readdir(join(indexRoot, "nodes"))).length;
      expect(liveNodeCount).toBeLessThanOrEqual(
        2 * (Math.ceil(expectedPages / BLOCK_RUN_INDEX_PAGE_SIZE) + BLOCK_RUN_INDEX_TREE_DEPTH)
      );
      const metrics = await directoryMetrics(indexRoot);
      expect(metrics.files).toBe(expectedPages + liveNodeCount + liveMetadataFileCount);
      expect(metrics.bytes).toBeLessThan(maxIndexBytes);

      const beforeAppend = {
        page: writes.page.count,
        treeNode: writes["tree-node"].count,
        retirement: writes.retirement.count,
        manifest: writes.manifest.count,
        pointer: writes.pointer.count
      };
      const snapshot = await readBlockRunIndexSnapshot(runRoot);
      if (!snapshot) throw new Error("Expected block run index before final append.");
      await mutateBlockRunIndex(
        runRoot,
        snapshot,
        {
          kind: "upsert",
          entry: {
            runId: `RUN-${finalRunIndex}`,
            orderedAt: new Date(finalRunIndex * 1_000).toISOString(),
            stableIdentity: `T-001#B-001::RUN-${finalRunIndex}`,
            hasArtifact: false
          }
        },
        { instrumentation }
      );
      expect(writes.page.count - beforeAppend.page).toBe(1);
      expect(writes["tree-node"].count - beforeAppend.treeNode).toBe(BLOCK_RUN_INDEX_TREE_DEPTH);
      expect(writes.retirement.count - beforeAppend.retirement).toBe(1);
      expect(writes.manifest.count - beforeAppend.manifest).toBe(1);
      expect(writes.pointer.count - beforeAppend.pointer).toBe(1);

      const readFileSpy = vi.spyOn(optionalFile, "optionalReadFile");
      const before = {
        orderedAt: new Date(129_000).toISOString(),
        stableIdentity: "T-001#B-001::RUN-00129"
      };
      const view = await readBlockRunIndexView(runRoot, { before, limit: 10 });
      expect(view.entries).toHaveLength(10);
      const pageObjectReads = readFileSpy.mock.calls.filter(([path]) =>
        path.includes(`${join(".planweave-task-workspace-run-index", "objects")}`)
      );
      const treeNodeReads = readFileSpy.mock.calls.filter(([path]) =>
        path.includes(`${join(".planweave-task-workspace-run-index", "nodes")}`)
      );
      expect(pageObjectReads.length).toBeLessThanOrEqual(maxFarCursorPageReads);
      expect(treeNodeReads.length).toBeLessThanOrEqual(
        maxFarCursorPageReads * BLOCK_RUN_INDEX_TREE_DEPTH
      );
    },
    testTimeoutMs
  );
});
