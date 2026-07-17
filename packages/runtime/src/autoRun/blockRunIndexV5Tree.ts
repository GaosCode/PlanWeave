import { join } from "node:path";
import { optionalReadFile } from "../fs/optionalFile.js";
import {
  BLOCK_RUN_INDEX_MAX_PAGES,
  BLOCK_RUN_INDEX_TREE_DEPTH,
  BLOCK_RUN_INDEX_TREE_FANOUT,
  blockRunIndexTreeNodeChecksum,
  blockRunIndexTreeNodeObjectId,
  compareBlockRunChronology,
  blockRunIndexV5InternalSchema,
  blockRunIndexV5LeafSchema,
  blockRunIndexV5RootSchema,
  type BlockRunIndexV4PageDescriptor,
  type BlockRunIndexV5Internal,
  type BlockRunIndexV5Leaf,
  type BlockRunIndexV5RetiredObject,
  type BlockRunIndexV5Root,
  type BlockRunIndexV5TreeChild
} from "./blockRunIndexSchema.js";

export type BlockRunIndexV5TreeNode =
  | BlockRunIndexV5Root
  | BlockRunIndexV5Internal
  | BlockRunIndexV5Leaf;

export interface BlockRunIndexV5TreeBuild {
  rootNodeId: string | null;
  nodes: ReadonlyMap<string, BlockRunIndexV5TreeNode>;
  retiredObjects?: readonly BlockRunIndexV5RetiredObject[];
}

export interface BlockRunIndexV5DescriptorLocation {
  pageIndex: number;
  descriptor: BlockRunIndexV4PageDescriptor;
}

export function assertBlockRunIndexV5PageCapacity(pageCount: number): void {
  if (!Number.isInteger(pageCount) || pageCount < 0 || pageCount > BLOCK_RUN_INDEX_MAX_PAGES) {
    throw new Error(
      `Block run index v5 supports at most ${String(BLOCK_RUN_INDEX_MAX_PAGES)} pages; received ${String(pageCount)}.`
    );
  }
}

function nodePath(indexRoot: string, objectId: string): string {
  return join(indexRoot, "nodes", `${objectId}.json`);
}

function chunks<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += BLOCK_RUN_INDEX_TREE_FANOUT) {
    result.push(values.slice(start, start + BLOCK_RUN_INDEX_TREE_FANOUT));
  }
  return result;
}

function splitOverflow<T>(values: readonly T[]): T[][] {
  if (values.length <= BLOCK_RUN_INDEX_TREE_FANOUT) return values.length === 0 ? [] : [[...values]];
  return [values.slice(0, BLOCK_RUN_INDEX_TREE_FANOUT), values.slice(BLOCK_RUN_INDEX_TREE_FANOUT)];
}

function cursorRef(
  objectId: string,
  pageCount: number,
  first: BlockRunIndexV4PageDescriptor["first"],
  last: BlockRunIndexV4PageDescriptor["last"]
): BlockRunIndexV5TreeChild {
  return { objectId, pageCount, first, last };
}

function nodeIdentity(payload: unknown): { objectId: string; checksum: string } {
  return {
    objectId: blockRunIndexTreeNodeObjectId(payload),
    checksum: blockRunIndexTreeNodeChecksum(payload)
  };
}

function leafNode(descriptors: BlockRunIndexV4PageDescriptor[]): BlockRunIndexV5Leaf {
  const payload = { version: 5 as const, kind: "leaf" as const, descriptors };
  return { ...payload, ...nodeIdentity(payload) };
}

function internalNode(
  level: number,
  children: BlockRunIndexV5TreeChild[]
): BlockRunIndexV5Internal {
  const payload = { version: 5 as const, kind: "internal" as const, level, children };
  return blockRunIndexV5InternalSchema.parse({ ...payload, ...nodeIdentity(payload) });
}

function rootNode(children: BlockRunIndexV5TreeChild[]): BlockRunIndexV5Root {
  const payload = { version: 5 as const, kind: "root" as const, children };
  return { ...payload, ...nodeIdentity(payload) };
}

function refForNode(node: BlockRunIndexV5TreeNode): BlockRunIndexV5TreeChild {
  if (node.kind === "leaf") {
    const first = node.descriptors[0];
    const last = node.descriptors.at(-1);
    if (!(first && last)) throw new Error("Block run index v5 leaf cannot be empty.");
    return cursorRef(node.objectId, node.descriptors.length, first.first, last.last);
  }
  const first = node.children[0];
  const last = node.children.at(-1);
  if (!(first && last)) throw new Error("Block run index v5 tree node cannot be empty.");
  return cursorRef(
    node.objectId,
    node.children.reduce((total, child) => total + child.pageCount, 0),
    first.first,
    last.last
  );
}

function retiredObjectForNode(node: BlockRunIndexV5TreeNode): BlockRunIndexV5RetiredObject {
  const reference = refForNode(node);
  const level =
    node.kind === "root"
      ? BLOCK_RUN_INDEX_TREE_DEPTH - 1
      : node.kind === "internal"
        ? node.level
        : 0;
  return {
    objectId: node.objectId,
    level,
    first: reference.first,
    last: reference.last
  };
}

function assertDescriptorOrder(descriptors: readonly BlockRunIndexV4PageDescriptor[]): void {
  for (let index = 0; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor) throw new Error("Block run index v5 descriptor is missing.");
    if (compareBlockRunChronology(descriptor.first, descriptor.last) > 0) {
      throw new Error("Block run index v5 descriptor cursor range is invalid.");
    }
    const previous = descriptors[index - 1];
    if (previous && compareBlockRunChronology(previous.last, descriptor.first) > 0) {
      throw new Error("Block run index v5 descriptors are not ordered.");
    }
  }
}

function assertChildClosure(
  child: BlockRunIndexV5TreeChild,
  descriptors: readonly BlockRunIndexV4PageDescriptor[]
): void {
  const first = descriptors[0];
  const last = descriptors.at(-1);
  if (
    !first ||
    !last ||
    child.pageCount !== descriptors.length ||
    compareBlockRunChronology(child.first, first.first) !== 0 ||
    compareBlockRunChronology(child.last, last.last) !== 0
  ) {
    throw new Error(`Block run index v5 child '${child.objectId}' closure is invalid.`);
  }
}

export function buildBlockRunIndexV5Tree(
  descriptors: readonly BlockRunIndexV4PageDescriptor[]
): BlockRunIndexV5TreeBuild {
  if (descriptors.length === 0) return { rootNodeId: null, nodes: new Map() };
  assertBlockRunIndexV5PageCapacity(descriptors.length);
  const nodes = new Map<string, BlockRunIndexV5TreeNode>();
  let refs = chunks(descriptors).map((group) => {
    const node = leafNode(group);
    nodes.set(node.objectId, node);
    return refForNode(node);
  });
  for (let level = 1; level <= BLOCK_RUN_INDEX_TREE_DEPTH - 2; level += 1) {
    refs = chunks(refs).map((group) => {
      const node = internalNode(level, group);
      nodes.set(node.objectId, node);
      return refForNode(node);
    });
  }
  if (refs.length > BLOCK_RUN_INDEX_TREE_FANOUT) {
    throw new Error(
      `Block run index exceeds v5 tree capacity of ${String(BLOCK_RUN_INDEX_MAX_PAGES)} pages.`
    );
  }
  const root = rootNode(refs);
  nodes.set(root.objectId, root);
  return { rootNodeId: root.objectId, nodes };
}

export async function readBlockRunIndexV5TreeNode(
  indexRoot: string,
  objectId: string
): Promise<BlockRunIndexV5TreeNode> {
  const text = await optionalReadFile(nodePath(indexRoot, objectId), "utf8");
  if (text === null) throw new Error(`Block run index v5 tree node '${objectId}' is missing.`);
  const raw = JSON.parse(text) as unknown;
  const kind = raw && typeof raw === "object" && "kind" in raw ? raw.kind : null;
  const node =
    kind === "root"
      ? blockRunIndexV5RootSchema.parse(raw)
      : kind === "internal"
        ? blockRunIndexV5InternalSchema.parse(raw)
        : blockRunIndexV5LeafSchema.parse(raw);
  const { objectId: storedId, checksum, ...payload } = node;
  if (
    storedId !== objectId ||
    checksum !== blockRunIndexTreeNodeChecksum(payload) ||
    objectId !== blockRunIndexTreeNodeObjectId(payload)
  ) {
    throw new Error(`Block run index v5 tree node '${objectId}' checksum mismatch.`);
  }
  return node;
}

async function collectDescriptors(
  indexRoot: string,
  objectId: string,
  expected: "root" | number | "leaf",
  liveNodes?: Set<string>
): Promise<BlockRunIndexV4PageDescriptor[]> {
  const node = await readBlockRunIndexV5TreeNode(indexRoot, objectId);
  liveNodes?.add(objectId);
  if (expected === "leaf") {
    if (node.kind !== "leaf") throw new Error("Block run index v5 tree depth is invalid.");
    assertDescriptorOrder(node.descriptors);
    return node.descriptors;
  }
  if (expected === "root") {
    if (node.kind !== "root") throw new Error("Block run index v5 root node is invalid.");
    const nested = await Promise.all(
      node.children.map(async (child) => {
        const descriptors = await collectDescriptors(
          indexRoot,
          child.objectId,
          BLOCK_RUN_INDEX_TREE_DEPTH - 2,
          liveNodes
        );
        assertChildClosure(child, descriptors);
        return descriptors;
      })
    );
    const descriptors = nested.flat();
    assertDescriptorOrder(descriptors);
    return descriptors;
  }
  if (node.kind !== "internal" || node.level !== expected) {
    throw new Error("Block run index v5 internal tree level is invalid.");
  }
  const next = expected === 1 ? "leaf" : expected - 1;
  const nested = await Promise.all(
    node.children.map(async (child) => {
      const descriptors = await collectDescriptors(indexRoot, child.objectId, next, liveNodes);
      assertChildClosure(child, descriptors);
      return descriptors;
    })
  );
  const descriptors = nested.flat();
  assertDescriptorOrder(descriptors);
  return descriptors;
}

export async function readAllBlockRunIndexV5Descriptors(
  indexRoot: string,
  rootNodeId: string | null,
  liveNodes?: Set<string>
): Promise<BlockRunIndexV4PageDescriptor[]> {
  if (rootNodeId === null) return [];
  return collectDescriptors(indexRoot, rootNodeId, "root", liveNodes);
}

export async function readBlockRunIndexV5DescriptorAt(
  indexRoot: string,
  rootNodeId: string,
  pageIndex: number
): Promise<BlockRunIndexV4PageDescriptor> {
  let remaining = pageIndex;
  const root = await readBlockRunIndexV5TreeNode(indexRoot, rootNodeId);
  if (root.kind !== "root") throw new Error("Block run index v5 root node is invalid.");
  const selectChild = (children: readonly BlockRunIndexV5TreeChild[]) => {
    const child = children.find((candidate) => {
      if (remaining < candidate.pageCount) return true;
      remaining -= candidate.pageCount;
      return false;
    });
    if (!child)
      throw new Error(`Block run index page index ${String(pageIndex)} is out of bounds.`);
    return child;
  };
  let child = selectChild(root.children);
  let node = await readBlockRunIndexV5TreeNode(indexRoot, child.objectId);
  for (let level = BLOCK_RUN_INDEX_TREE_DEPTH - 2; level >= 1; level -= 1) {
    if (node.kind !== "internal" || node.level !== level) {
      throw new Error("Block run index v5 internal tree level is invalid.");
    }
    child = selectChild(node.children);
    node = await readBlockRunIndexV5TreeNode(indexRoot, child.objectId);
  }
  const leaf = node;
  if (leaf.kind !== "leaf") throw new Error("Block run index v5 leaf level is invalid.");
  const descriptor = leaf.descriptors[remaining];
  if (!descriptor)
    throw new Error(`Block run index page index ${String(pageIndex)} is out of bounds.`);
  return descriptor;
}

export async function locateBlockRunIndexV5Descriptor(
  indexRoot: string,
  rootNodeId: string,
  cursor: BlockRunIndexV4PageDescriptor["first"]
): Promise<BlockRunIndexV5DescriptorLocation> {
  let pageIndex = 0;
  const selectChild = (children: readonly BlockRunIndexV5TreeChild[]) => {
    const childIndex = children.findIndex(
      (candidate) => compareBlockRunChronology(candidate.last, cursor) >= 0
    );
    const selectedIndex = childIndex < 0 ? children.length - 1 : childIndex;
    const child = children[selectedIndex];
    if (!child) throw new Error("Block run index v5 tree node has no selectable child.");
    for (let index = 0; index < selectedIndex; index += 1) {
      const preceding = children[index];
      if (!preceding) throw new Error("Block run index v5 tree child is missing.");
      pageIndex += preceding.pageCount;
    }
    return child;
  };

  const root = await readBlockRunIndexV5TreeNode(indexRoot, rootNodeId);
  if (root.kind !== "root") throw new Error("Block run index v5 root node is invalid.");
  let child = selectChild(root.children);
  let node = await readBlockRunIndexV5TreeNode(indexRoot, child.objectId);
  for (let level = BLOCK_RUN_INDEX_TREE_DEPTH - 2; level >= 1; level -= 1) {
    if (node.kind !== "internal" || node.level !== level) {
      throw new Error("Block run index v5 internal tree level is invalid.");
    }
    child = selectChild(node.children);
    node = await readBlockRunIndexV5TreeNode(indexRoot, child.objectId);
  }
  if (node.kind !== "leaf") throw new Error("Block run index v5 leaf level is invalid.");
  const descriptorIndex = node.descriptors.findIndex(
    (candidate) => compareBlockRunChronology(candidate.last, cursor) >= 0
  );
  const selectedIndex = descriptorIndex < 0 ? node.descriptors.length - 1 : descriptorIndex;
  const descriptor = node.descriptors[selectedIndex];
  if (!descriptor) throw new Error("Block run index v5 leaf has no selectable descriptor.");
  return { pageIndex: pageIndex + selectedIndex, descriptor };
}

function rangeContains(
  container: Pick<BlockRunIndexV5TreeChild, "first" | "last">,
  candidate: Pick<BlockRunIndexV5RetiredObject, "first" | "last">
): boolean {
  return (
    compareBlockRunChronology(container.first, candidate.first) <= 0 &&
    compareBlockRunChronology(container.last, candidate.last) >= 0
  );
}

export async function blockRunIndexV5TreeReferencesObject(
  indexRoot: string,
  rootNodeId: string | null,
  candidate: BlockRunIndexV5RetiredObject,
  cache: Map<string, BlockRunIndexV5TreeNode> = new Map()
): Promise<boolean> {
  if (rootNodeId === null) return false;
  if (candidate.level === BLOCK_RUN_INDEX_TREE_DEPTH - 1) {
    return rootNodeId === candidate.objectId;
  }
  const readNode = async (objectId: string): Promise<BlockRunIndexV5TreeNode> => {
    const cached = cache.get(objectId);
    if (cached) return cached;
    const node = await readBlockRunIndexV5TreeNode(indexRoot, objectId);
    cache.set(objectId, node);
    return node;
  };
  const visit = async (objectId: string): Promise<boolean> => {
    const node = await readNode(objectId);
    if (node.kind === "leaf") {
      if (candidate.level !== -1) return false;
      return node.descriptors.some((descriptor) => descriptor.objectId === candidate.objectId);
    }
    const childLevel = node.kind === "root" ? BLOCK_RUN_INDEX_TREE_DEPTH - 2 : node.level - 1;
    if (candidate.level === childLevel) {
      return node.children.some((child) => child.objectId === candidate.objectId);
    }
    if (candidate.level > childLevel) return false;
    for (const child of node.children) {
      if (!rangeContains(child, candidate)) continue;
      if (await visit(child.objectId)) return true;
    }
    return false;
  };
  return visit(rootNodeId);
}

export async function updateBlockRunIndexV5Tree(
  indexRoot: string,
  rootNodeId: string,
  pageIndex: number,
  replacement: readonly BlockRunIndexV4PageDescriptor[]
): Promise<BlockRunIndexV5TreeBuild> {
  let remaining = pageIndex;
  const root = await readBlockRunIndexV5TreeNode(indexRoot, rootNodeId);
  if (root.kind !== "root") throw new Error("Block run index v5 root node is invalid.");
  const parents: Array<{
    node: BlockRunIndexV5Root | BlockRunIndexV5Internal;
    childIndex: number;
  }> = [];
  const selectChildIndex = (children: readonly BlockRunIndexV5TreeChild[]): number => {
    const childIndex = children.findIndex((candidate) => {
      if (remaining < candidate.pageCount) return true;
      remaining -= candidate.pageCount;
      return false;
    });
    if (childIndex < 0) {
      throw new Error(`Block run index page index ${String(pageIndex)} is out of bounds.`);
    }
    return childIndex;
  };
  let childIndex = selectChildIndex(root.children);
  parents.push({ node: root, childIndex });
  const rootChild = root.children[childIndex];
  if (!rootChild) throw new Error("Block run index v5 root child is missing.");
  let node = await readBlockRunIndexV5TreeNode(indexRoot, rootChild.objectId);
  for (let level = BLOCK_RUN_INDEX_TREE_DEPTH - 2; level >= 1; level -= 1) {
    if (node.kind !== "internal" || node.level !== level) {
      throw new Error("Block run index v5 internal tree level is invalid.");
    }
    childIndex = selectChildIndex(node.children);
    parents.push({ node, childIndex });
    const child = node.children[childIndex];
    if (!child) throw new Error("Block run index v5 internal child is missing.");
    node = await readBlockRunIndexV5TreeNode(indexRoot, child.objectId);
  }
  if (node.kind !== "leaf") throw new Error("Block run index v5 leaf level is invalid.");
  const retiredObjects = [
    ...parents.map((parent) => retiredObjectForNode(parent.node)),
    retiredObjectForNode(node)
  ];
  const nextDescriptors = [...node.descriptors];
  nextDescriptors.splice(remaining, 1, ...replacement);
  const nodes = new Map<string, BlockRunIndexV5TreeNode>();
  let refs = splitOverflow(nextDescriptors).map((group) => {
    const next = leafNode(group);
    nodes.set(next.objectId, next);
    return refForNode(next);
  });

  for (const parent of parents.reverse()) {
    const children = [...parent.node.children];
    children.splice(parent.childIndex, 1, ...refs);
    const parentNode = parent.node;
    if (parentNode.kind === "root") {
      if (children.length === 0) return { rootNodeId: null, nodes, retiredObjects };
      if (children.length > BLOCK_RUN_INDEX_TREE_FANOUT) {
        throw new Error(
          `Block run index v5 supports at most ${String(BLOCK_RUN_INDEX_MAX_PAGES)} pages.`
        );
      }
      const next = rootNode(children);
      nodes.set(next.objectId, next);
      return { rootNodeId: next.objectId, nodes, retiredObjects };
    }
    refs = splitOverflow(children).map((group) => {
      const next = internalNode(parentNode.level, group);
      nodes.set(next.objectId, next);
      return refForNode(next);
    });
  }
  throw new Error("Block run index v5 tree update did not reach its root.");
}
