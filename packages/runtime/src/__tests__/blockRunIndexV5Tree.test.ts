import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeJsonFile } from "../json.js";
import {
  BLOCK_RUN_INDEX_MAX_PAGES,
  BLOCK_RUN_INDEX_PAGE_SIZE,
  BLOCK_RUN_INDEX_TREE_DEPTH,
  BLOCK_RUN_INDEX_TREE_FANOUT,
  blockRunIndexPageObjectId,
  blockRunIndexV5InternalSchema,
  blockRunIndexV5LeafSchema,
  blockRunIndexV5ManifestSchema,
  blockRunIndexV5PointerSchema,
  blockRunIndexV5RootSchema,
  type BlockRunIndexEntry
} from "../autoRun/blockRunIndexSchema.js";
import {
  assertBlockRunIndexV5PageCapacity,
  buildBlockRunIndexV5Tree,
  readAllBlockRunIndexV5Descriptors,
  readBlockRunIndexV5TreeNode,
  updateBlockRunIndexV5Tree
} from "../autoRun/blockRunIndexV5Tree.js";

const entry: BlockRunIndexEntry = {
  runId: "RUN-001",
  retryIndex: 1,
  orderedAt: "2026-07-17T00:00:00.000Z",
  stableIdentity: "T-001#B-001::RUN-001",
  hasArtifact: false
};
const descriptor = {
  objectId: blockRunIndexPageObjectId([entry]),
  count: 1,
  first: { orderedAt: entry.orderedAt, stableIdentity: entry.stableIdentity },
  last: { orderedAt: entry.orderedAt, stableIdentity: entry.stableIdentity }
};

function descriptorFor(index: number) {
  const stableIdentity = `T-001#B-001::PAGE-${String(index).padStart(6, "0")}`;
  const value: BlockRunIndexEntry = {
    runId: `RUN-${String(index).padStart(6, "0")}`,
    retryIndex: index,
    orderedAt: entry.orderedAt,
    stableIdentity,
    hasArtifact: false
  };
  return {
    objectId: blockRunIndexPageObjectId([value]),
    count: 1,
    first: { orderedAt: value.orderedAt, stableIdentity },
    last: { orderedAt: value.orderedAt, stableIdentity }
  };
}

async function persistTree(
  indexRoot: string,
  tree: ReturnType<typeof buildBlockRunIndexV5Tree>
): Promise<void> {
  await mkdir(join(indexRoot, "nodes"), { recursive: true });
  await Promise.all(
    [...tree.nodes].map(([objectId, node]) =>
      writeJsonFile(join(indexRoot, "nodes", `${objectId}.json`), node)
    )
  );
}

describe("block run index v5 tree contract", () => {
  it("builds one strict root, fixed internal depth, and leaf closure", () => {
    const tree = buildBlockRunIndexV5Tree([descriptor]);
    expect(tree.nodes).toHaveLength(BLOCK_RUN_INDEX_TREE_DEPTH);
    const nodes = [...tree.nodes.values()];
    expect(nodes.filter((node) => node.kind === "root")).toHaveLength(1);
    expect(nodes.filter((node) => node.kind === "internal")).toHaveLength(
      BLOCK_RUN_INDEX_TREE_DEPTH - 2
    );
    expect(nodes.filter((node) => node.kind === "leaf")).toHaveLength(1);
    for (const node of nodes) {
      const schema =
        node.kind === "root"
          ? blockRunIndexV5RootSchema
          : node.kind === "internal"
            ? blockRunIndexV5InternalSchema
            : blockRunIndexV5LeafSchema;
      expect(schema.safeParse({ ...node, extra: true }).success).toBe(false);
    }
  });

  it("keeps pointer and manifest fixed-size and rejects growing descriptor arrays", () => {
    expect(
      blockRunIndexV5PointerSchema.safeParse({
        version: 5,
        currentGeneration: "generation-1",
        previousGeneration: null,
        extra: true
      }).success
    ).toBe(false);
    expect(
      blockRunIndexV5ManifestSchema.safeParse({
        version: 5,
        generation: "generation-1",
        pageSize: BLOCK_RUN_INDEX_PAGE_SIZE,
        treeFanout: BLOCK_RUN_INDEX_TREE_FANOUT,
        treeDepth: BLOCK_RUN_INDEX_TREE_DEPTH,
        total: 0,
        pageCount: 0,
        maxRetryIndex: 0,
        head: null,
        latestArtifact: null,
        rootNodeId: null,
        pages: []
      }).success
    ).toBe(false);
  });

  it("fails clearly beyond the fixed-depth capacity", () => {
    expect(() => assertBlockRunIndexV5PageCapacity(BLOCK_RUN_INDEX_MAX_PAGES)).not.toThrow();
    expect(() => assertBlockRunIndexV5PageCapacity(BLOCK_RUN_INDEX_MAX_PAGES + 1)).toThrow(
      `supports at most ${String(BLOCK_RUN_INDEX_MAX_PAGES)} pages`
    );
  });

  it("updates a full leading leaf through a bounded copy-on-write path", async () => {
    const indexRoot = await mkdtemp(join(tmpdir(), "planweave-index-v5-tree-"));
    try {
      const descriptors = Array.from({ length: BLOCK_RUN_INDEX_TREE_FANOUT ** 2 + 1 }, (_, index) =>
        descriptorFor(index + 1)
      );
      const tree = buildBlockRunIndexV5Tree(descriptors);
      await persistTree(indexRoot, tree);
      const rootNodeId = tree.rootNodeId;
      if (!rootNodeId) throw new Error("Expected a non-empty v5 tree.");
      const firstDescriptor = descriptors[0];
      if (!firstDescriptor) throw new Error("Expected a leading v5 descriptor.");

      const inserted = descriptorFor(0);
      const updated = await updateBlockRunIndexV5Tree(indexRoot, rootNodeId, 0, [
        inserted,
        firstDescriptor
      ]);
      expect(updated.nodes.size).toBeLessThanOrEqual(BLOCK_RUN_INDEX_TREE_DEPTH * 2);
      await persistTree(indexRoot, updated);

      const actual = await readAllBlockRunIndexV5Descriptors(indexRoot, updated.rootNodeId);
      expect(actual).toHaveLength(descriptors.length + 1);
      expect(actual.slice(0, 3).map((item) => item.objectId)).toEqual([
        inserted.objectId,
        descriptors[0]?.objectId,
        descriptors[1]?.objectId
      ]);
      const previous = await readAllBlockRunIndexV5Descriptors(indexRoot, rootNodeId);
      expect(previous).toEqual(descriptors);
    } finally {
      await rm(indexRoot, { recursive: true, force: true });
    }
  });

  it("rejects a content-addressed node whose checksum is corrupted", async () => {
    const indexRoot = await mkdtemp(join(tmpdir(), "planweave-index-v5-checksum-"));
    try {
      const tree = buildBlockRunIndexV5Tree([descriptor]);
      await persistTree(indexRoot, tree);
      const rootNodeId = tree.rootNodeId;
      if (!rootNodeId) throw new Error("Expected a non-empty v5 tree.");
      const root = tree.nodes.get(rootNodeId);
      if (!root) throw new Error("Expected the v5 root node.");
      await writeJsonFile(join(indexRoot, "nodes", `${rootNodeId}.json`), {
        ...root,
        checksum: "0".repeat(64)
      });

      await expect(readBlockRunIndexV5TreeNode(indexRoot, rootNodeId)).rejects.toThrow(
        "checksum mismatch"
      );
    } finally {
      await rm(indexRoot, { recursive: true, force: true });
    }
  });
});
