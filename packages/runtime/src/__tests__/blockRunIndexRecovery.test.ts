import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BlockRunIndexEntry } from "../autoRun/blockRunIndexSchema.js";
import {
  maintainBlockRunIndex,
  readAllBlockRunIndexEntries,
  readBlockRunIndexSnapshot,
  replaceBlockRunIndexWithV5,
  type BlockRunIndexStorageFaultPoint
} from "../autoRun/blockRunIndexStorage.js";

const temporaryRoots: string[] = [];
const faultPoints: readonly BlockRunIndexStorageFaultPoint[] = [
  "page-write",
  "tree-node-write",
  "manifest-write",
  "before-pointer-write",
  "after-pointer-write",
  "generation-gc",
  "object-gc"
];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

function entry(index: number): BlockRunIndexEntry {
  const runId = `RUN-${String(index).padStart(3, "0")}`;
  return {
    runId,
    retryIndex: index,
    orderedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    stableIdentity: `T-001#B-001::${runId}`,
    hasArtifact: false
  };
}

async function temporaryRunRoot(point: BlockRunIndexStorageFaultPoint): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `planweave-index-recovery-${point}-`));
  temporaryRoots.push(root);
  return root;
}

describe("block run index v5 crash recovery", () => {
  it.each(faultPoints)("preserves a readable generation and converges after %s", async (point) => {
    const runRoot = await temporaryRunRoot(point);
    const firstEntries = [entry(1)];
    await replaceBlockRunIndexWithV5(runRoot, null, firstEntries);
    const first = await readBlockRunIndexSnapshot(runRoot);
    if (!first) throw new Error("Expected the first block run index generation.");

    const secondEntries = [...firstEntries, entry(2)];
    await replaceBlockRunIndexWithV5(runRoot, first, secondEntries);
    const second = await readBlockRunIndexSnapshot(runRoot);
    if (!second) throw new Error("Expected the second block run index generation.");

    const reached: BlockRunIndexStorageFaultPoint[] = [];
    await expect(
      replaceBlockRunIndexWithV5(runRoot, second, [...secondEntries, entry(3)], {
        instrumentation: {
          atFaultPoint(candidate) {
            reached.push(candidate);
            if (candidate === point) throw new Error(`injected:${point}`);
          }
        }
      })
    ).rejects.toThrow();
    expect(reached).toContain(point);

    const reopened = await readBlockRunIndexSnapshot(runRoot);
    if (!reopened) throw new Error("Expected a readable block run index after injected failure.");
    const reopenedEntries = await readAllBlockRunIndexEntries(reopened);
    const published = ["after-pointer-write", "generation-gc", "object-gc"].includes(point);
    expect(reopenedEntries.map((candidate) => candidate.runId)).toEqual(
      published ? ["RUN-001", "RUN-002", "RUN-003"] : ["RUN-001", "RUN-002"]
    );

    await maintainBlockRunIndex(runRoot);
    await maintainBlockRunIndex(runRoot);
    const converged = await readBlockRunIndexSnapshot(runRoot);
    if (!converged || converged.version !== 5) {
      throw new Error("Expected maintenance to preserve a v5 block run index.");
    }
    const indexRoot = join(runRoot, ".planweave-task-workspace-run-index");
    expect(await readdir(join(indexRoot, "generations"))).toHaveLength(2);
    for (const generation of [
      converged.pointer.currentGeneration,
      converged.pointer.previousGeneration
    ]) {
      if (generation === null) continue;
      const manifest = JSON.parse(
        await readFile(join(indexRoot, "generations", generation, "manifest.json"), "utf8")
      ) as { rootNodeId: string | null };
      for (const objectId of manifest.rootNodeId ? [manifest.rootNodeId] : []) {
        await expect(access(join(indexRoot, "nodes", `${objectId}.json`))).resolves.toBeUndefined();
      }
    }
  });
});
