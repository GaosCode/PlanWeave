import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withAdvisoryDirectoryLock } from "../fs/advisoryDirectoryLock.js";
import { optionalReaddir, optionalStat } from "../fs/optionalFile.js";
import { loadPackage } from "../package/loadPackage.js";
import {
  readImplementationRunMetadataFile,
  type ImplementationRunMetadata
} from "../taskManager/implementationRunMetadata.js";
import type { PackageWorkspaceRef } from "../types.js";
import {
  compareBlockRunChronology,
  type BlockRunIndexEntry,
  type BlockRunLogicalCursor
} from "./blockRunIndexSchema.js";
import {
  BlockRunIndexSnapshotChangedError,
  maintainBlockRunIndex,
  mutateBlockRunIndex,
  readBlockRunIndexSnapshot,
  replaceBlockRunIndexWithV5,
  type BlockRunIndexPublishStage,
  type BlockRunIndexReadSnapshot
} from "./blockRunIndexStorage.js";

export type { BlockRunIndexEntry, BlockRunLogicalCursor } from "./blockRunIndexSchema.js";
export { BlockRunIndexPartialMaintenanceError } from "./blockRunIndexStorage.js";
export type BlockRunIndexWriteStage = BlockRunIndexPublishStage;
export type BlockRunIndexWriteOptions = {
  afterStage?: (stage: BlockRunIndexWriteStage) => void | Promise<void>;
};
export { compareBlockRunChronology } from "./blockRunIndexSchema.js";

function sortEntries(entries: readonly BlockRunIndexEntry[]): BlockRunIndexEntry[] {
  return [...entries].sort(compareBlockRunChronology);
}

function blockRefFromRunRoot(runRoot: string): string {
  const blockId = basename(dirname(runRoot));
  const taskId = basename(dirname(dirname(dirname(runRoot))));
  if (!(taskId && blockId))
    throw new Error(`Cannot derive block identity from run root '${runRoot}'.`);
  return `${taskId}#${blockId}`;
}

function chronologyCandidates(metadata: ImplementationRunMetadata | null): Array<string | null | undefined> {
  return [metadata?.startedAt, metadata?.submittedAt, metadata?.finishedAt];
}

async function readRunFacts(
  runRoot: string,
  runId: string
): Promise<{
  orderedAt: string;
  stableIdentity: string;
  hasArtifact: boolean;
}> {
  const runDir = join(runRoot, runId);
  const metadataPath = join(runDir, "metadata.json");
  // Missing metadata is incomplete; present metadata uses the shared artifact contract.
  const metadata = (await optionalStat(metadataPath))
    ? await readImplementationRunMetadataFile(metadataPath)
    : null;
  let orderedAt: string | null = null;
  for (const candidate of chronologyCandidates(metadata)) {
    if (typeof candidate !== "string" || !Number.isFinite(Date.parse(candidate))) continue;
    orderedAt = new Date(candidate).toISOString();
    break;
  }
  if (orderedAt === null) {
    const ordinal = /^RUN-(\d+)$/i.exec(runId);
    if (ordinal) {
      orderedAt = new Date(Number.parseInt(ordinal[1]!, 10)).toISOString();
    } else {
      const stat = await optionalStat(runDir);
      if (!stat) throw new Error(`Run '${runId}' does not exist under '${runRoot}'.`);
      orderedAt = new Date(stat.mtimeMs).toISOString();
    }
  }
  const ref = metadata?.ref && metadata.ref !== "" ? metadata.ref : blockRefFromRunRoot(runRoot);
  const hasArtifact =
    Boolean(await optionalStat(join(runDir, "report.md"))) ||
    metadata?.artifactReference !== undefined;
  return { orderedAt, stableIdentity: `${ref}::${runId}`, hasArtifact };
}

async function migrateExistingRuns(
  runRoot: string,
  previous: BlockRunIndexReadSnapshot | null,
  options: BlockRunIndexWriteOptions = {}
): Promise<void> {
  const directoryEntries = await optionalReaddir(runRoot, { withFileTypes: true });
  const runIds = (directoryEntries ?? [])
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
  const facts = await Promise.all(runIds.map((runId) => readRunFacts(runRoot, runId)));
  const entries = facts.map((fact, index) => ({
    runId: runIds[index]!,
    retryIndex: index + 1,
    ...fact
  }));
  const sorted = sortEntries(entries).map((entry, index) => ({ ...entry, retryIndex: index + 1 }));
  await replaceBlockRunIndexWithV5(runRoot, previous, sorted, options);
}

export async function migrateBlockRunIndexes(projectRoot: PackageWorkspaceRef): Promise<{
  indexedBlocks: number;
  indexedRuns: number;
}> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  let indexedBlocks = 0;
  let indexedRuns = 0;
  for (const node of manifest.nodes) {
    if (node.type !== "task") continue;
    for (const block of node.blocks) {
      const runRoot = join(workspace.resultsDir, node.id, "blocks", block.id, "runs");
      await rebuildBlockRunIndex(runRoot);
      const snapshot = await readBlockRunIndexSnapshot(runRoot);
      indexedBlocks += 1;
      indexedRuns += snapshot?.total ?? 0;
    }
  }
  return { indexedBlocks, indexedRuns };
}

export async function rebuildBlockRunIndex(
  runRoot: string,
  options: BlockRunIndexWriteOptions = {}
): Promise<void> {
  await mkdir(runRoot, { recursive: true });
  await withAdvisoryDirectoryLock(
    {
      lockPath: join(runRoot, ".planweave-task-workspace-run-index.lock"),
      operation: "rebuild-block-run-index"
    },
    async () => {
      const previous = await readBlockRunIndexSnapshot(runRoot);
      await migrateExistingRuns(runRoot, previous, options);
    }
  );
}

export async function initializeBlockRunIndex(
  runRoot: string,
  options: BlockRunIndexWriteOptions = {}
): Promise<void> {
  await mkdir(runRoot, { recursive: true });
  await withAdvisoryDirectoryLock(
    {
      lockPath: join(runRoot, ".planweave-task-workspace-run-index.lock"),
      operation: "initialize-block-run-index"
    },
    async () => {
      const snapshot = await readBlockRunIndexSnapshot(runRoot);
      if (!snapshot) await migrateExistingRuns(runRoot, null, options);
      else if (snapshot.version !== 3) await maintainBlockRunIndex(runRoot);
    }
  );
}

export async function upsertBlockRunInIndex(
  runRoot: string,
  runId: string,
  hasArtifact: boolean | undefined,
  options: BlockRunIndexWriteOptions = {}
): Promise<void> {
  await mkdir(runRoot, { recursive: true });
  await withAdvisoryDirectoryLock(
    {
      lockPath: join(runRoot, ".planweave-task-workspace-run-index.lock"),
      operation: "upsert-block-run-index"
    },
    async () => {
      let snapshot = await readBlockRunIndexSnapshot(runRoot);
      if (!snapshot) {
        await migrateExistingRuns(runRoot, null, options);
        snapshot = await readBlockRunIndexSnapshot(runRoot);
      }
      if (!snapshot) throw new Error(`Failed to initialize block run index at '${runRoot}'.`);
      const facts = await readRunFacts(runRoot, runId);
      await mutateBlockRunIndex(
        runRoot,
        snapshot,
        {
          kind: "upsert",
          entry: { runId, ...facts, hasArtifact: facts.hasArtifact || hasArtifact === true }
        },
        options
      );
    }
  );
}

export async function recordBlockRunInIndex(
  runRoot: string,
  runId: string,
  options: BlockRunIndexWriteOptions = {}
): Promise<void> {
  await upsertBlockRunInIndex(runRoot, runId, undefined, options);
}

export async function requireBlockRunIndex(runRoot: string): Promise<void> {
  if (!(await readBlockRunIndexSnapshot(runRoot))) {
    throw new Error(
      `Task Workspace run index is missing at '${runRoot}'. Create or migrate the index before querying history.`
    );
  }
}

async function readBlockRunIndexViewOnce(
  runRoot: string,
  options: { before?: BlockRunLogicalCursor; limit: number }
): Promise<{
  entries: BlockRunIndexEntry[];
  hasMore: boolean;
  head: BlockRunIndexEntry | null;
  latestArtifact: BlockRunIndexEntry | null;
}> {
  const snapshot = await readBlockRunIndexSnapshot(runRoot);
  if (!snapshot) throw new Error(`Block run index is missing at '${runRoot}'.`);
  let startPage = snapshot.pageCount - 1;
  if (options.before && startPage > 0) {
    let low = 0;
    let high = startPage;
    let newestEligiblePage = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const entries = await snapshot.readPage(middle);
      const first = entries[0];
      const last = entries.at(-1);
      if (!(first && last)) {
        throw new Error(`Block run index page ${middle} is empty at '${runRoot}'.`);
      }
      if (compareBlockRunChronology(last, options.before) < 0) {
        newestEligiblePage = middle;
        low = middle + 1;
        continue;
      }
      if (compareBlockRunChronology(first, options.before) >= 0) {
        high = middle - 1;
        continue;
      }
      newestEligiblePage = middle;
      break;
    }
    startPage = newestEligiblePage;
  }
  const newestFirst: BlockRunIndexEntry[] = [];
  for (
    let pageNumber = startPage;
    pageNumber >= 0 && newestFirst.length <= options.limit;
    pageNumber -= 1
  ) {
    const entries = await snapshot.readPage(pageNumber);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (options.before && compareBlockRunChronology(entry, options.before) >= 0) continue;
      newestFirst.push(entry);
      if (newestFirst.length > options.limit) break;
    }
  }
  return {
    entries: newestFirst.slice(0, options.limit),
    hasMore: newestFirst.length > options.limit,
    head: snapshot.head,
    latestArtifact: snapshot.latestArtifact
  };
}

export async function readBlockRunIndexView(
  runRoot: string,
  options: { before?: BlockRunLogicalCursor; limit: number }
): Promise<{
  entries: BlockRunIndexEntry[];
  hasMore: boolean;
  head: BlockRunIndexEntry | null;
  latestArtifact: BlockRunIndexEntry | null;
}> {
  try {
    return await readBlockRunIndexViewOnce(runRoot, options);
  } catch (error) {
    if (!(error instanceof BlockRunIndexSnapshotChangedError)) throw error;
    return readBlockRunIndexViewOnce(runRoot, options);
  }
}

export async function readBlockRunIndexSummary(
  runRoot: string
): Promise<{ head: BlockRunIndexEntry | null; latestArtifactRunId: string | null }> {
  const view = await readBlockRunIndexView(runRoot, { limit: 0 });
  return { head: view.head, latestArtifactRunId: view.latestArtifact?.runId ?? null };
}

export async function readBlockRunIndexHead(runRoot: string): Promise<BlockRunIndexEntry | null> {
  return (await readBlockRunIndexView(runRoot, { limit: 0 })).head;
}

async function readBlockRunIndexEntryOnce(
  runRoot: string,
  runId: string
): Promise<BlockRunIndexEntry> {
  const snapshot = await readBlockRunIndexSnapshot(runRoot);
  if (!snapshot) throw new Error(`Block run index is missing at '${runRoot}'.`);
  for (let pageIndex = 0; pageIndex < snapshot.pageCount; pageIndex += 1) {
    const entry = (await snapshot.readPage(pageIndex)).find(
      (candidate) => candidate.runId === runId
    );
    if (entry) return entry;
  }
  throw new Error(`Run '${runId}' is missing from the block run index.`);
}

export async function readBlockRunIndexEntry(
  runRoot: string,
  runId: string
): Promise<BlockRunIndexEntry> {
  try {
    return await readBlockRunIndexEntryOnce(runRoot, runId);
  } catch (error) {
    if (!(error instanceof BlockRunIndexSnapshotChangedError)) throw error;
    return readBlockRunIndexEntryOnce(runRoot, runId);
  }
}

export async function recordBlockRunArtifactInIndex(
  runRoot: string,
  runId: string,
  options: BlockRunIndexWriteOptions = {}
): Promise<void> {
  await withAdvisoryDirectoryLock(
    {
      lockPath: join(runRoot, ".planweave-task-workspace-run-index.lock"),
      operation: "record-block-run-artifact-index"
    },
    async () => {
      const snapshot = await readBlockRunIndexSnapshot(runRoot);
      if (!snapshot) throw new Error(`Block run index is missing at '${runRoot}'.`);
      const facts = await readRunFacts(runRoot, runId);
      await mutateBlockRunIndex(
        runRoot,
        snapshot,
        {
          kind: "markArtifact",
          runId,
          cursor: facts
        },
        options
      );
    }
  );
}

export async function removeBlockRunFromIndex(runRoot: string, runId: string): Promise<void> {
  await withAdvisoryDirectoryLock(
    {
      lockPath: join(runRoot, ".planweave-task-workspace-run-index.lock"),
      operation: "remove-block-run-index"
    },
    async () => {
      let snapshot = await readBlockRunIndexSnapshot(runRoot);
      if (!snapshot) {
        await migrateExistingRuns(runRoot, null);
        snapshot = await readBlockRunIndexSnapshot(runRoot);
      }
      if (!snapshot) throw new Error(`Block run index is missing at '${runRoot}'.`);
      const facts = await readRunFacts(runRoot, runId);
      await mutateBlockRunIndex(runRoot, snapshot, { kind: "remove", runId, cursor: facts });
    }
  );
}
