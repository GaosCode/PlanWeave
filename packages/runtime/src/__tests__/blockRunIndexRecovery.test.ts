import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BlockRunIndexEntry } from "../autoRun/blockRunIndexSchema.js";
import {
  maintainBlockRunIndex,
  mutateBlockRunIndex,
  readAllBlockRunIndexEntries,
  readBlockRunIndexSnapshot,
  replaceBlockRunIndexWithV5,
  type BlockRunIndexStorageFaultPoint
} from "../autoRun/blockRunIndexStorage.js";

const temporaryRoots: string[] = [];
const faultPoints: readonly BlockRunIndexStorageFaultPoint[] = [
  "page-write",
  "tree-node-write",
  "retirement-write",
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
  it("converges pending retirement through later mutations without explicit maintenance", async () => {
    const runRoot = await temporaryRunRoot("object-gc");
    await replaceBlockRunIndexWithV5(runRoot, null, [entry(1)]);
    const generation0 = await readBlockRunIndexSnapshot(runRoot);
    if (generation0?.version !== 5 || !generation0.manifest.rootNodeId) {
      throw new Error("Expected the initial v5 generation.");
    }
    const indexRoot = join(runRoot, ".planweave-task-workspace-run-index");
    const retiredRootNode = generation0.manifest.rootNodeId;
    const [retiredPageObject] = await readdir(join(indexRoot, "objects"));
    if (!retiredPageObject) throw new Error("Expected the initial page object.");

    await mutateBlockRunIndex(runRoot, generation0, {
      kind: "markArtifact",
      cursor: {
        orderedAt: entry(1).orderedAt,
        stableIdentity: entry(1).stableIdentity
      },
      runId: entry(1).runId
    });
    const generation1 = await readBlockRunIndexSnapshot(runRoot);
    if (generation1?.version !== 5) throw new Error("Expected the second v5 generation.");

    await expect(
      mutateBlockRunIndex(
        runRoot,
        generation1,
        {
          kind: "upsert",
          entry: {
            runId: entry(2).runId,
            orderedAt: entry(2).orderedAt,
            stableIdentity: entry(2).stableIdentity,
            hasArtifact: false
          }
        },
        {
          instrumentation: {
            atFaultPoint(point) {
              if (point === "object-gc") throw new Error("injected:object-gc");
            }
          }
        }
      )
    ).rejects.toMatchObject({ code: "BLOCK_RUN_INDEX_PARTIAL_MAINTENANCE" });
    await expect(
      access(join(indexRoot, "nodes", `${retiredRootNode}.json`))
    ).resolves.toBeUndefined();
    await expect(access(join(indexRoot, "objects", retiredPageObject))).resolves.toBeUndefined();

    const generation2 = await readBlockRunIndexSnapshot(runRoot);
    if (generation2?.version !== 5) throw new Error("Expected the committed third generation.");
    await expect(
      mutateBlockRunIndex(runRoot, generation2, {
        kind: "upsert",
        entry: {
          runId: entry(2).runId,
          orderedAt: entry(2).orderedAt,
          stableIdentity: entry(2).stableIdentity,
          hasArtifact: false
        }
      })
    ).resolves.toBe(false);

    const retried = await readBlockRunIndexSnapshot(runRoot);
    if (retried?.version !== 5) throw new Error("Expected the retried v5 generation.");
    await mutateBlockRunIndex(runRoot, retried, {
      kind: "upsert",
      entry: {
        runId: entry(3).runId,
        orderedAt: entry(3).orderedAt,
        stableIdentity: entry(3).stableIdentity,
        hasArtifact: false
      }
    });

    await expect(access(join(indexRoot, "nodes", `${retiredRootNode}.json`))).rejects.toThrow();
    await expect(access(join(indexRoot, "objects", retiredPageObject))).rejects.toThrow();
    expect(await readdir(join(indexRoot, "generations"))).toHaveLength(2);
  });

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
      mutateBlockRunIndex(
        runRoot,
        second,
        {
          kind: "upsert",
          entry: {
            runId: entry(3).runId,
            orderedAt: entry(3).orderedAt,
            stableIdentity: entry(3).stableIdentity,
            hasArtifact: false
          }
        },
        {
          instrumentation: {
            atFaultPoint(candidate) {
              reached.push(candidate);
              if (candidate === point) throw new Error(`injected:${point}`);
            }
          }
        }
      )
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
