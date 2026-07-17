import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { optionalReadFile, optionalReaddir, optionalStat } from "../fs/optionalFile.js";
import { writeJsonFile } from "../json.js";
import {
  BLOCK_RUN_INDEX_PAGE_SIZE,
  BLOCK_RUN_INDEX_TREE_DEPTH,
  BLOCK_RUN_INDEX_TREE_FANOUT,
  blockRunIndexPageChecksum,
  blockRunIndexPageObjectId,
  blockRunIndexV3ManifestSchema,
  blockRunIndexV3PageSchema,
  blockRunIndexV3PointerSchema,
  blockRunIndexV4ManifestSchema,
  blockRunIndexV4PageSchema,
  blockRunIndexV4PointerSchema,
  blockRunIndexV5ManifestSchema,
  blockRunIndexV5PointerSchema,
  compareBlockRunChronology,
  type BlockRunIndexEntry,
  type BlockRunIndexV4Manifest,
  type BlockRunIndexV4PageDescriptor,
  type BlockRunIndexV4Pointer,
  type BlockRunIndexV5Manifest,
  type BlockRunIndexV5Pointer
} from "./blockRunIndexSchema.js";
import {
  buildBlockRunIndexV5Tree,
  readAllBlockRunIndexV5Descriptors,
  readBlockRunIndexV5DescriptorAt,
  readBlockRunIndexV5TreeNode,
  updateBlockRunIndexV5Tree,
  type BlockRunIndexV5TreeBuild
} from "./blockRunIndexV5Tree.js";

const indexDirectoryName = ".planweave-task-workspace-run-index";
const supportedPointerSchema = z.union([
  blockRunIndexV3PointerSchema,
  blockRunIndexV4PointerSchema,
  blockRunIndexV5PointerSchema
]);

export type BlockRunIndexPublishStage =
  | "generation-created"
  | "pages-written"
  | "before-publish"
  | "published";

export type BlockRunIndexStorageFaultPoint =
  | "page-write"
  | "tree-node-write"
  | "manifest-write"
  | "before-pointer-write"
  | "after-pointer-write"
  | "generation-gc"
  | "object-gc";

export type BlockRunIndexStorageWriteKind = "page" | "tree-node" | "manifest" | "pointer";

export interface BlockRunIndexStorageInstrumentation {
  atFaultPoint?: (point: BlockRunIndexStorageFaultPoint) => void | Promise<void>;
  recordWrite?(write: { kind: BlockRunIndexStorageWriteKind; payloadBytes: number }): void;
}

export interface BlockRunIndexStorageOptions {
  afterStage?: (stage: BlockRunIndexPublishStage) => void | Promise<void>;
  instrumentation?: BlockRunIndexStorageInstrumentation;
}

interface BlockRunIndexReadSnapshotBase {
  total: number;
  pageCount: number;
  head: BlockRunIndexEntry | null;
  latestArtifact: BlockRunIndexEntry | null;
  readPage(pageIndex: number): Promise<BlockRunIndexEntry[]>;
}

export interface BlockRunIndexV3ReadSnapshot extends BlockRunIndexReadSnapshotBase {
  version: 3;
  generation: string;
}

export interface BlockRunIndexV4ReadSnapshot extends BlockRunIndexReadSnapshotBase {
  version: 4;
  pointer: BlockRunIndexV4Pointer;
  manifest: BlockRunIndexV4Manifest;
}

export interface BlockRunIndexV5ReadSnapshot extends BlockRunIndexReadSnapshotBase {
  version: 5;
  pointer: BlockRunIndexV5Pointer;
  manifest: BlockRunIndexV5Manifest;
}

export type BlockRunIndexReadSnapshot =
  | BlockRunIndexV3ReadSnapshot
  | BlockRunIndexV4ReadSnapshot
  | BlockRunIndexV5ReadSnapshot;

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

export class BlockRunIndexPartialMaintenanceError extends Error {
  readonly code = "BLOCK_RUN_INDEX_PARTIAL_MAINTENANCE";
  readonly mutationCommitted = true;

  constructor(runRoot: string, cause: unknown) {
    super(`Block run index mutation committed at '${runRoot}', but maintenance failed.`, {
      cause
    });
    this.name = "BlockRunIndexPartialMaintenanceError";
  }
}

export class BlockRunIndexSnapshotChangedError extends Error {
  constructor(runRoot: string) {
    super(`Block run index snapshot changed while reading '${runRoot}'.`);
    this.name = "BlockRunIndexSnapshotChangedError";
  }
}

interface GenerationDraft {
  manifest: {
    total: number;
    maxRetryIndex: number;
    head: BlockRunIndexEntry | null;
    latestArtifact: BlockRunIndexEntry | null;
    pages: BlockRunIndexV4PageDescriptor[];
  };
  newPages: Map<string, readonly BlockRunIndexEntry[]>;
  tree?: BlockRunIndexV5TreeBuild;
}

function indexRoot(runRoot: string): string {
  return join(runRoot, indexDirectoryName);
}

function pointerPath(runRoot: string): string {
  return join(indexRoot(runRoot), "current.json");
}

function v4ManifestPath(runRoot: string, generation: string): string {
  return join(indexRoot(runRoot), "generations", generation, "manifest.json");
}

function objectPath(runRoot: string, objectId: string): string {
  return join(indexRoot(runRoot), "objects", `${objectId}.json`);
}

async function readParsed<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  const text = await optionalReadFile(path, "utf8");
  if (text === null) return null;
  return schema.parse(JSON.parse(text) as unknown);
}

function indexContractError(runRoot: string, message: string): Error {
  return new Error(`Invalid block run index at '${runRoot}': ${message}`);
}

function sameCursor(
  entry: BlockRunIndexEntry,
  cursor: Pick<BlockRunIndexEntry, "orderedAt" | "stableIdentity">
): boolean {
  return entry.orderedAt === cursor.orderedAt && entry.stableIdentity === cursor.stableIdentity;
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

async function readV4Manifest(
  runRoot: string,
  generation: string
): Promise<BlockRunIndexV4Manifest> {
  const manifest = await readParsed(
    v4ManifestPath(runRoot, generation),
    blockRunIndexV4ManifestSchema
  );
  if (!manifest || manifest.generation !== generation) {
    throw indexContractError(runRoot, `generation '${generation}' is incomplete`);
  }
  const descriptorTotal = manifest.pages.reduce((total, page) => total + page.count, 0);
  if (descriptorTotal !== manifest.total) {
    throw indexContractError(runRoot, "manifest total does not match its page descriptors");
  }
  if ((manifest.total === 0) !== (manifest.head === null)) {
    throw indexContractError(runRoot, "manifest head does not match its total");
  }
  if (manifest.latestArtifact && !manifest.latestArtifact.hasArtifact) {
    throw indexContractError(runRoot, "manifest latestArtifact is not an artifact entry");
  }
  return manifest;
}

async function readV5Manifest(
  runRoot: string,
  generation: string
): Promise<BlockRunIndexV5Manifest> {
  const manifest = await readParsed(
    v4ManifestPath(runRoot, generation),
    blockRunIndexV5ManifestSchema
  );
  if (!manifest || manifest.generation !== generation) {
    throw indexContractError(runRoot, `generation '${generation}' is incomplete`);
  }
  if ((manifest.total === 0) !== (manifest.rootNodeId === null)) {
    throw indexContractError(runRoot, "v5 manifest root does not match its total");
  }
  if ((manifest.total === 0) !== (manifest.head === null)) {
    throw indexContractError(runRoot, "v5 manifest head does not match its total");
  }
  if (manifest.latestArtifact && !manifest.latestArtifact.hasArtifact) {
    throw indexContractError(runRoot, "v5 manifest latestArtifact is not an artifact entry");
  }
  return manifest;
}

async function readV4PageObject(
  runRoot: string,
  descriptor: BlockRunIndexV4PageDescriptor
): Promise<BlockRunIndexEntry[]> {
  const page = await readParsed(
    objectPath(runRoot, descriptor.objectId),
    blockRunIndexV4PageSchema
  );
  if (!page) {
    throw indexContractError(runRoot, `page object '${descriptor.objectId}' is missing`);
  }
  const checksum = blockRunIndexPageChecksum(page.entries);
  if (
    page.objectId !== descriptor.objectId ||
    page.objectId !== blockRunIndexPageObjectId(page.entries) ||
    page.checksum !== checksum
  ) {
    throw indexContractError(runRoot, `page object '${descriptor.objectId}' checksum mismatch`);
  }
  const first = page.entries[0];
  const last = page.entries.at(-1);
  if (!(first && last)) {
    throw indexContractError(runRoot, `page object '${descriptor.objectId}' is empty`);
  }
  if (
    page.entries.length !== descriptor.count ||
    !sameCursor(first, descriptor.first) ||
    !sameCursor(last, descriptor.last)
  ) {
    throw indexContractError(
      runRoot,
      `page object '${descriptor.objectId}' does not match its descriptor`
    );
  }
  return page.entries;
}

export async function readBlockRunIndexSnapshot(
  runRoot: string
): Promise<BlockRunIndexReadSnapshot | null> {
  const root = indexRoot(runRoot);
  const pointerText = await optionalReadFile(pointerPath(runRoot), "utf8");
  if (pointerText === null) return null;
  const pointerResult = supportedPointerSchema.safeParse(JSON.parse(pointerText) as unknown);
  if (!pointerResult.success) {
    throw indexContractError(runRoot, "unsupported or malformed pointer contract");
  }
  const pointer = pointerResult.data;
  if (pointer.version === 3) {
    const generationRoot = join(root, "generations", pointer.generation);
    const manifest = await readParsed(
      join(generationRoot, "manifest.json"),
      blockRunIndexV3ManifestSchema
    );
    if (!manifest || manifest.generation !== pointer.generation) {
      throw indexContractError(runRoot, `generation '${pointer.generation}' is incomplete`);
    }
    return {
      version: 3,
      generation: pointer.generation,
      total: manifest.total,
      pageCount: manifest.headPage,
      head: manifest.head,
      latestArtifact: manifest.latestArtifact,
      async readPage(pageIndex) {
        if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= manifest.headPage) {
          throw indexContractError(runRoot, `page index ${pageIndex} is out of bounds`);
        }
        const pageNumber = pageIndex + 1;
        const page = await readParsed(
          join(generationRoot, `page-${String(pageNumber).padStart(6, "0")}.json`),
          blockRunIndexV3PageSchema
        );
        if (!page || page.generation !== pointer.generation || page.page !== pageNumber) {
          throw indexContractError(runRoot, `v3 page ${pageNumber} is incomplete`);
        }
        return page.entries;
      }
    };
  }

  if (pointer.version === 5) {
    const manifest = await readV5Manifest(runRoot, pointer.currentGeneration);
    return {
      version: 5,
      pointer,
      manifest,
      total: manifest.total,
      pageCount: manifest.pageCount,
      head: manifest.head,
      latestArtifact: manifest.latestArtifact,
      async readPage(pageIndex) {
        if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= manifest.pageCount) {
          throw indexContractError(runRoot, `page index ${pageIndex} is out of bounds`);
        }
        if (!manifest.rootNodeId) {
          throw indexContractError(runRoot, "v5 manifest root is missing");
        }
        try {
          const descriptor = await readBlockRunIndexV5DescriptorAt(
            root,
            manifest.rootNodeId,
            pageIndex
          );
          return await readV4PageObject(runRoot, descriptor);
        } catch (error) {
          const latestPointerText = await optionalReadFile(pointerPath(runRoot), "utf8");
          const latestPointer = latestPointerText
            ? blockRunIndexV5PointerSchema.safeParse(JSON.parse(latestPointerText) as unknown)
            : null;
          if (
            latestPointer?.success &&
            latestPointer.data.currentGeneration !== pointer.currentGeneration
          ) {
            throw new BlockRunIndexSnapshotChangedError(runRoot);
          }
          throw error;
        }
      }
    };
  }

  const manifest = await readV4Manifest(runRoot, pointer.currentGeneration);
  return {
    version: 4,
    pointer,
    manifest,
    total: manifest.total,
    pageCount: manifest.pages.length,
    head: manifest.head,
    latestArtifact: manifest.latestArtifact,
    async readPage(pageIndex) {
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= manifest.pages.length) {
        throw indexContractError(runRoot, `page index ${pageIndex} is out of bounds`);
      }
      const descriptor = manifest.pages.at(pageIndex);
      if (!descriptor)
        throw indexContractError(runRoot, `page index ${pageIndex} is out of bounds`);
      try {
        return await readV4PageObject(runRoot, descriptor);
      } catch (error) {
        const latestPointerText = await optionalReadFile(pointerPath(runRoot), "utf8");
        const latestPointer = latestPointerText
          ? blockRunIndexV4PointerSchema.safeParse(JSON.parse(latestPointerText) as unknown)
          : null;
        if (
          latestPointer?.success &&
          latestPointer.data.currentGeneration !== pointer.currentGeneration
        ) {
          throw new BlockRunIndexSnapshotChangedError(runRoot);
        }
        throw error;
      }
    }
  };
}

export async function readAllBlockRunIndexEntries(
  snapshot: BlockRunIndexReadSnapshot
): Promise<BlockRunIndexEntry[]> {
  const entries: BlockRunIndexEntry[] = [];
  for (let pageIndex = 0; pageIndex < snapshot.pageCount; pageIndex += 1) {
    entries.push(...(await snapshot.readPage(pageIndex)));
  }
  if (entries.length !== snapshot.total) {
    throw new Error("Block run index total does not match its readable page entries.");
  }
  return entries;
}

async function writePageObject(
  runRoot: string,
  objectId: string,
  entries: readonly BlockRunIndexEntry[],
  options: BlockRunIndexStorageOptions
): Promise<void> {
  const path = objectPath(runRoot, objectId);
  if (await optionalStat(path)) {
    await readV4PageObject(runRoot, pageDescriptor(entries));
    return;
  }
  const page = {
    version: 4,
    objectId,
    checksum: blockRunIndexPageChecksum(entries),
    entries
  };
  await options.instrumentation?.atFaultPoint?.("page-write");
  await writeJsonFile(path, page);
  options.instrumentation?.recordWrite?.({
    kind: "page",
    payloadBytes: Buffer.byteLength(`${JSON.stringify(page, null, 2)}\n`, "utf8")
  });
  await readV4PageObject(runRoot, pageDescriptor(entries));
}

async function verifyLiveClosure(
  runRoot: string,
  pointer: BlockRunIndexV4Pointer
): Promise<Map<string, BlockRunIndexV4Manifest>> {
  const manifests = new Map<string, BlockRunIndexV4Manifest>();
  for (const generation of [pointer.currentGeneration, pointer.previousGeneration]) {
    if (generation === null || manifests.has(generation)) continue;
    const manifest = await readV4Manifest(runRoot, generation);
    for (const page of manifest.pages) {
      if (!(await optionalStat(objectPath(runRoot, page.objectId)))) {
        throw indexContractError(
          runRoot,
          `generation '${generation}' references missing page object '${page.objectId}'`
        );
      }
    }
    manifests.set(generation, manifest);
  }
  return manifests;
}

async function verifyV5LiveClosure(
  runRoot: string,
  pointer: BlockRunIndexV5Pointer
): Promise<{
  generations: Set<string>;
  objects: Set<string>;
  nodes: Set<string>;
}> {
  const generations = new Set<string>();
  const objects = new Set<string>();
  const nodes = new Set<string>();
  for (const generation of [pointer.currentGeneration, pointer.previousGeneration]) {
    if (generation === null || generations.has(generation)) continue;
    const manifest = await readV5Manifest(runRoot, generation);
    const descriptors = await readAllBlockRunIndexV5Descriptors(
      indexRoot(runRoot),
      manifest.rootNodeId,
      nodes
    );
    if (
      descriptors.length !== manifest.pageCount ||
      descriptors.reduce((total, descriptor) => total + descriptor.count, 0) !== manifest.total
    ) {
      throw indexContractError(runRoot, `generation '${generation}' tree totals are invalid`);
    }
    for (const descriptor of descriptors) {
      if (!(await optionalStat(objectPath(runRoot, descriptor.objectId)))) {
        throw indexContractError(
          runRoot,
          `generation '${generation}' references missing page object '${descriptor.objectId}'`
        );
      }
      objects.add(descriptor.objectId);
    }
    generations.add(generation);
  }
  return { generations, objects, nodes };
}

async function garbageCollect(
  runRoot: string,
  pointer: BlockRunIndexV4Pointer | BlockRunIndexV5Pointer,
  liveGenerations: Set<string>,
  liveObjects: Set<string>,
  liveNodes: Set<string>,
  options: BlockRunIndexStorageOptions
): Promise<void> {
  const generationsRoot = join(indexRoot(runRoot), "generations");
  await options.instrumentation?.atFaultPoint?.("generation-gc");
  for (const entry of (await optionalReaddir(generationsRoot, { withFileTypes: true })) ?? []) {
    if (!entry.isDirectory() || liveGenerations.has(entry.name)) continue;
    await rm(join(generationsRoot, entry.name), { recursive: true, force: true });
  }
  const objectsRoot = join(indexRoot(runRoot), "objects");
  await options.instrumentation?.atFaultPoint?.("object-gc");
  for (const entry of (await optionalReaddir(objectsRoot, { withFileTypes: true })) ?? []) {
    if (!(entry.isFile() && entry.name.endsWith(".json"))) continue;
    const objectId = entry.name.slice(0, -".json".length);
    if (liveObjects.has(objectId)) continue;
    await rm(join(objectsRoot, entry.name), { force: true });
  }
  const nodesRoot = join(indexRoot(runRoot), "nodes");
  for (const entry of (await optionalReaddir(nodesRoot, { withFileTypes: true })) ?? []) {
    if (!(entry.isFile() && entry.name.endsWith(".json"))) continue;
    const objectId = entry.name.slice(0, -".json".length);
    if (liveNodes.has(objectId)) continue;
    await rm(join(nodesRoot, entry.name), { force: true });
  }
  const publishedPointer = supportedPointerSchema.parse(
    JSON.parse((await optionalReadFile(pointerPath(runRoot), "utf8")) ?? "null") as unknown
  );
  if (
    publishedPointer.version !== pointer.version ||
    !("currentGeneration" in publishedPointer) ||
    publishedPointer.currentGeneration !== pointer.currentGeneration ||
    publishedPointer.previousGeneration !== pointer.previousGeneration
  ) {
    throw indexContractError(runRoot, "pointer changed during locked maintenance");
  }
}

export async function maintainBlockRunIndex(
  runRoot: string,
  options: BlockRunIndexStorageOptions = {}
): Promise<void> {
  const pointerText = await optionalReadFile(pointerPath(runRoot), "utf8");
  if (pointerText === null) return;
  const pointer = supportedPointerSchema.parse(JSON.parse(pointerText) as unknown);
  if (pointer.version === 3) return;
  if (pointer.version === 4) {
    const manifests = await verifyLiveClosure(runRoot, pointer);
    const objects = new Set(
      [...manifests.values()].flatMap((manifest) => manifest.pages.map((page) => page.objectId))
    );
    await garbageCollect(runRoot, pointer, new Set(manifests.keys()), objects, new Set(), options);
    return;
  }
  const closure = await verifyV5LiveClosure(runRoot, pointer);
  await garbageCollect(
    runRoot,
    pointer,
    closure.generations,
    closure.objects,
    closure.nodes,
    options
  );
}

async function maintainCommittedMutation(runRoot: string): Promise<void> {
  try {
    await maintainBlockRunIndex(runRoot);
  } catch (error) {
    if (error instanceof BlockRunIndexPartialMaintenanceError) throw error;
    throw new BlockRunIndexPartialMaintenanceError(runRoot, error);
  }
}

async function publishGeneration(
  runRoot: string,
  previous: BlockRunIndexReadSnapshot | null,
  draft: GenerationDraft,
  options: BlockRunIndexStorageOptions
): Promise<void> {
  const generation = crypto.randomUUID();
  await mkdir(join(indexRoot(runRoot), "generations", generation), { recursive: true });
  await options.afterStage?.("generation-created");
  for (const [objectId, entries] of draft.newPages) {
    await writePageObject(runRoot, objectId, entries, options);
  }
  const tree = draft.tree ?? buildBlockRunIndexV5Tree(draft.manifest.pages);
  for (const [objectId, node] of tree.nodes) {
    const path = join(indexRoot(runRoot), "nodes", `${objectId}.json`);
    if (await optionalStat(path)) {
      await readBlockRunIndexV5TreeNode(indexRoot(runRoot), objectId);
      continue;
    }
    await options.instrumentation?.atFaultPoint?.("tree-node-write");
    await writeJsonFile(path, node);
    options.instrumentation?.recordWrite?.({
      kind: "tree-node",
      payloadBytes: Buffer.byteLength(`${JSON.stringify(node, null, 2)}\n`, "utf8")
    });
    await readBlockRunIndexV5TreeNode(indexRoot(runRoot), objectId);
  }
  await options.afterStage?.("pages-written");
  const manifest = blockRunIndexV5ManifestSchema.parse({
    version: 5,
    generation,
    pageSize: BLOCK_RUN_INDEX_PAGE_SIZE,
    treeFanout: BLOCK_RUN_INDEX_TREE_FANOUT,
    treeDepth: BLOCK_RUN_INDEX_TREE_DEPTH,
    total: draft.manifest.total,
    pageCount: draft.manifest.pages.length,
    maxRetryIndex: draft.manifest.maxRetryIndex,
    head: draft.manifest.head,
    latestArtifact: draft.manifest.latestArtifact,
    rootNodeId: tree.rootNodeId
  });
  await options.instrumentation?.atFaultPoint?.("manifest-write");
  await writeJsonFile(v4ManifestPath(runRoot, generation), manifest);
  options.instrumentation?.recordWrite?.({
    kind: "manifest",
    payloadBytes: Buffer.byteLength(`${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  });
  await options.afterStage?.("before-publish");
  const pointer = blockRunIndexV5PointerSchema.parse({
    version: 5,
    currentGeneration: generation,
    previousGeneration: previous?.version === 5 ? previous.pointer.currentGeneration : null
  });
  await options.instrumentation?.atFaultPoint?.("before-pointer-write");
  await writeJsonFile(pointerPath(runRoot), pointer);
  options.instrumentation?.recordWrite?.({
    kind: "pointer",
    payloadBytes: Buffer.byteLength(`${JSON.stringify(pointer, null, 2)}\n`, "utf8")
  });
  await options.instrumentation?.atFaultPoint?.("after-pointer-write");
  await options.afterStage?.("published");
  try {
    const closure = await verifyV5LiveClosure(runRoot, pointer);
    await garbageCollect(
      runRoot,
      pointer,
      closure.generations,
      closure.objects,
      closure.nodes,
      options
    );
  } catch (error) {
    throw new BlockRunIndexPartialMaintenanceError(runRoot, error);
  }
}

function fullGenerationDraft(rawEntries: readonly BlockRunIndexEntry[]): GenerationDraft {
  const entries = [...rawEntries].sort(compareBlockRunChronology);
  const pages: BlockRunIndexV4PageDescriptor[] = [];
  const newPages = new Map<string, readonly BlockRunIndexEntry[]>();
  for (let start = 0; start < entries.length; start += BLOCK_RUN_INDEX_PAGE_SIZE) {
    const pageEntries = entries.slice(start, start + BLOCK_RUN_INDEX_PAGE_SIZE);
    const descriptor = pageDescriptor(pageEntries);
    pages.push(descriptor);
    newPages.set(descriptor.objectId, pageEntries);
  }
  return {
    manifest: {
      total: entries.length,
      maxRetryIndex: entries.reduce((max, entry) => Math.max(max, entry.retryIndex), 0),
      head: entries.at(-1) ?? null,
      latestArtifact: entries.filter((entry) => entry.hasArtifact).at(-1) ?? null,
      pages
    },
    newPages
  };
}

export async function replaceBlockRunIndexWithV5(
  runRoot: string,
  previous: BlockRunIndexReadSnapshot | null,
  entries: readonly BlockRunIndexEntry[],
  options: BlockRunIndexStorageOptions = {}
): Promise<void> {
  await publishGeneration(runRoot, previous, fullGenerationDraft(entries), options);
}

function targetPageIndex(
  pages: readonly BlockRunIndexV4PageDescriptor[],
  cursor: Pick<BlockRunIndexEntry, "orderedAt" | "stableIdentity">
): number {
  let low = 0;
  let high = pages.length - 1;
  let result = pages.length;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const page = pages[middle];
    if (!page) break;
    if (compareBlockRunChronology(page.last, cursor) >= 0) {
      result = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return Math.min(result, pages.length - 1);
}

function draftPage(
  entries: readonly BlockRunIndexEntry[],
  newPages: Map<string, readonly BlockRunIndexEntry[]>
): BlockRunIndexV4PageDescriptor {
  const descriptor = pageDescriptor(entries);
  newPages.set(descriptor.objectId, entries);
  return descriptor;
}

async function mutateV5(
  runRoot: string,
  snapshot: BlockRunIndexV5ReadSnapshot,
  mutation: BlockRunIndexMutation,
  options: BlockRunIndexStorageOptions
): Promise<boolean> {
  const manifest = {
    ...snapshot.manifest,
    pages: await readAllBlockRunIndexV5Descriptors(indexRoot(runRoot), snapshot.manifest.rootNodeId)
  };
  const mutationRunId = mutation.kind === "upsert" ? mutation.entry.runId : mutation.runId;
  if (manifest.pages.length === 0) {
    if (mutation.kind !== "upsert") {
      if (mutation.kind === "markArtifact") {
        throw new Error(`Run '${mutation.runId}' is missing from the block run index.`);
      }
      await maintainCommittedMutation(runRoot);
      return false;
    }
    const entry = { ...mutation.entry, retryIndex: manifest.maxRetryIndex + 1 };
    await publishGeneration(runRoot, snapshot, fullGenerationDraft([entry]), options);
    return true;
  }

  const cursor = mutation.kind === "upsert" ? mutation.entry : mutation.cursor;
  const pageIndex = targetPageIndex(manifest.pages, cursor);
  const pageEntries = await snapshot.readPage(pageIndex);
  const existingIndex = pageEntries.findIndex((entry) => entry.runId === mutationRunId);
  if (mutation.kind === "markArtifact" && existingIndex < 0) {
    throw new Error(`Run '${mutation.runId}' is missing from the block run index.`);
  }
  if (mutation.kind === "remove" && existingIndex < 0) {
    await maintainCommittedMutation(runRoot);
    return false;
  }

  const pages = [...manifest.pages];
  const previousPageCount = pages.length;
  const newPages = new Map<string, readonly BlockRunIndexEntry[]>();
  let maxRetryIndex = manifest.maxRetryIndex;
  let head = manifest.head;
  let latestArtifact = manifest.latestArtifact;

  if (mutation.kind === "remove") {
    const removed = pageEntries[existingIndex];
    if (!removed) throw new Error(`Run '${mutation.runId}' is missing from the block run index.`);
    const remaining = pageEntries.filter((entry) => entry.runId !== mutation.runId);
    if (remaining.length === 0) pages.splice(pageIndex, 1);
    else pages.splice(pageIndex, 1, draftPage(remaining, newPages));
    if (head?.runId === removed.runId) {
      if (remaining.length > 0 && pageIndex === pages.length - 1) head = remaining.at(-1) ?? null;
      else if (pages.length === 0) head = null;
      else {
        const tail = pages.at(-1);
        if (tail) {
          const tailEntries =
            newPages.get(tail.objectId) ?? (await readV4PageObject(runRoot, tail));
          head = tailEntries.at(-1) ?? null;
        } else head = null;
      }
    }
    if (latestArtifact?.runId === removed.runId) {
      latestArtifact = await findLatestArtifactForRunRoot(runRoot, pages, newPages);
    }
  } else {
    let updatedEntries: BlockRunIndexEntry[] | null = null;
    if (existingIndex >= 0) {
      const existing = pageEntries[existingIndex];
      if (!existing) throw new Error(`Run '${mutationRunId}' is missing from the block run index.`);
      const hasArtifact =
        existing.hasArtifact || mutation.kind === "markArtifact" || mutation.entry.hasArtifact;
      if (hasArtifact === existing.hasArtifact) {
        await maintainCommittedMutation(runRoot);
        return false;
      }
      updatedEntries = [...pageEntries];
      updatedEntries[existingIndex] = { ...existing, hasArtifact };
      if (!latestArtifact || compareBlockRunChronology(existing, latestArtifact) > 0) {
        latestArtifact = updatedEntries[existingIndex] ?? latestArtifact;
      }
    } else {
      if (mutation.kind !== "upsert") throw new Error("Unexpected block run index mutation.");
      maxRetryIndex += 1;
      const entry: BlockRunIndexEntry = { ...mutation.entry, retryIndex: maxRetryIndex };
      const isSequentialFullAppend =
        pageIndex === pages.length - 1 &&
        pageEntries.length === BLOCK_RUN_INDEX_PAGE_SIZE &&
        compareBlockRunChronology(entry, pageEntries.at(-1) ?? entry) > 0;
      if (isSequentialFullAppend) {
        pages.push(draftPage([entry], newPages));
      } else {
        updatedEntries = [...pageEntries, entry].sort(compareBlockRunChronology);
        if (updatedEntries.length <= BLOCK_RUN_INDEX_PAGE_SIZE) {
          pages.splice(pageIndex, 1, draftPage(updatedEntries, newPages));
        } else {
          const splitAt = Math.ceil(updatedEntries.length / 2);
          pages.splice(
            pageIndex,
            1,
            draftPage(updatedEntries.slice(0, splitAt), newPages),
            draftPage(updatedEntries.slice(splitAt), newPages)
          );
        }
      }
      if (!head || compareBlockRunChronology(entry, head) > 0) head = entry;
      if (
        entry.hasArtifact &&
        (!latestArtifact || compareBlockRunChronology(entry, latestArtifact) > 0)
      ) {
        latestArtifact = entry;
      }
    }
    if (existingIndex >= 0) {
      if (!updatedEntries) throw new Error(`Run '${mutationRunId}' could not be updated.`);
      pages.splice(pageIndex, 1, draftPage(updatedEntries, newPages));
    }
  }

  if (!snapshot.manifest.rootNodeId) {
    throw indexContractError(runRoot, "v5 manifest root is missing");
  }
  const replacementCount = pages.length - previousPageCount + 1;
  const tree = await updateBlockRunIndexV5Tree(
    indexRoot(runRoot),
    snapshot.manifest.rootNodeId,
    pageIndex,
    pages.slice(pageIndex, pageIndex + replacementCount)
  );
  await publishGeneration(
    runRoot,
    snapshot,
    {
      manifest: {
        total: pages.reduce((total, page) => total + page.count, 0),
        maxRetryIndex,
        head,
        latestArtifact,
        pages
      },
      newPages,
      tree
    },
    options
  );
  return true;
}

async function findLatestArtifactForRunRoot(
  runRoot: string,
  pages: readonly BlockRunIndexV4PageDescriptor[],
  newPages: Map<string, readonly BlockRunIndexEntry[]>
): Promise<BlockRunIndexEntry | null> {
  for (let pageIndex = pages.length - 1; pageIndex >= 0; pageIndex -= 1) {
    const descriptor = pages[pageIndex];
    if (!descriptor) continue;
    const entries =
      newPages.get(descriptor.objectId) ?? (await readV4PageObject(runRoot, descriptor));
    const artifact = entries.filter((entry) => entry.hasArtifact).at(-1);
    if (artifact) return artifact;
  }
  return null;
}

function mutateEntries(
  entries: readonly BlockRunIndexEntry[],
  mutation: BlockRunIndexMutation
): BlockRunIndexEntry[] {
  const next = [...entries];
  const mutationRunId = mutation.kind === "upsert" ? mutation.entry.runId : mutation.runId;
  const existingIndex = next.findIndex((entry) => entry.runId === mutationRunId);
  if (mutation.kind === "remove") {
    return existingIndex < 0 ? next : next.filter((entry) => entry.runId !== mutation.runId);
  }
  if (mutation.kind === "markArtifact") {
    if (existingIndex < 0)
      throw new Error(`Run '${mutation.runId}' is missing from the block run index.`);
    const existing = next[existingIndex];
    if (existing) next[existingIndex] = { ...existing, hasArtifact: true };
    return next;
  }
  if (existingIndex >= 0) {
    const existing = next[existingIndex];
    if (existing)
      next[existingIndex] = {
        ...existing,
        hasArtifact: existing.hasArtifact || mutation.entry.hasArtifact
      };
    return next;
  }
  const retryIndex = next.reduce((max, entry) => Math.max(max, entry.retryIndex), 0) + 1;
  next.push({ ...mutation.entry, retryIndex });
  return next;
}

export async function mutateBlockRunIndex(
  runRoot: string,
  snapshot: BlockRunIndexReadSnapshot,
  mutation: BlockRunIndexMutation,
  options: BlockRunIndexStorageOptions = {}
): Promise<boolean> {
  if (snapshot.version === 5) return mutateV5(runRoot, snapshot, mutation, options);
  const entries = await readAllBlockRunIndexEntries(snapshot);
  const next = mutateEntries(entries, mutation);
  await publishGeneration(runRoot, snapshot, fullGenerationDraft(next), options);
  return true;
}
