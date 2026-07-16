import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { withAdvisoryDirectoryLock } from "../fs/advisoryDirectoryLock.js";
import { optionalReadFile, optionalReaddir, optionalStat } from "../fs/optionalFile.js";
import { writeJsonFile } from "../json.js";
import { loadPackage } from "../package/loadPackage.js";
import type { PackageWorkspaceRef } from "../types.js";

const PAGE_SIZE = 64;
const indexDirectoryName = ".planweave-task-workspace-run-index";
const pointerSchema = z.object({ version: z.literal(3), generation: z.string().min(1) }).strict();
const entrySchema = z.object({
  runId: z.string().min(1),
  retryIndex: z.number().int().positive(),
  orderedAt: z.string().datetime({ offset: true }),
  stableIdentity: z.string().min(1),
  hasArtifact: z.boolean()
}).strict();
const manifestSchema = z.object({
  version: z.literal(3),
  generation: z.string().min(1),
  pageSize: z.literal(PAGE_SIZE),
  total: z.number().int().nonnegative(),
  headPage: z.number().int().nonnegative(),
  head: entrySchema.nullable(),
  latestArtifact: entrySchema.nullable()
}).strict();
const pageSchema = z.object({
  version: z.literal(3),
  generation: z.string().min(1),
  page: z.number().int().positive(),
  entries: z.array(entrySchema).max(PAGE_SIZE)
}).strict();

type Manifest = z.infer<typeof manifestSchema>;
type Snapshot = { generation: string; manifest: Manifest };
export type BlockRunIndexEntry = z.infer<typeof entrySchema>;
export type BlockRunLogicalCursor = Pick<BlockRunIndexEntry, "orderedAt" | "stableIdentity">;
export type BlockRunIndexWriteStage =
  | "generation-created"
  | "pages-written"
  | "before-publish"
  | "published";
export type BlockRunIndexWriteOptions = {
  afterStage?: (stage: BlockRunIndexWriteStage) => void | Promise<void>;
};

function indexRoot(runRoot: string): string {
  return join(runRoot, indexDirectoryName);
}

function pointerPath(runRoot: string): string {
  return join(indexRoot(runRoot), "current.json");
}

function generationRoot(runRoot: string, generation: string): string {
  return join(indexRoot(runRoot), "generations", generation);
}

function manifestPath(runRoot: string, generation: string): string {
  return join(generationRoot(runRoot, generation), "manifest.json");
}

function pagePath(runRoot: string, generation: string, page: number): string {
  return join(generationRoot(runRoot, generation), `page-${String(page).padStart(6, "0")}.json`);
}

async function readParsed<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  const text = await optionalReadFile(path, "utf8");
  if (text === null) return null;
  return schema.parse(JSON.parse(text) as unknown);
}

async function readSnapshot(runRoot: string): Promise<Snapshot | null> {
  const text = await optionalReadFile(pointerPath(runRoot), "utf8");
  if (text === null) return null;
  const raw = JSON.parse(text) as unknown;
  const pointer = pointerSchema.safeParse(raw);
  if (!pointer.success) {
    throw new Error(`Block run index at '${runRoot}' uses an obsolete or invalid generation contract; run 'planweave run-index migrate'.`);
  }
  const manifest = await readParsed(manifestPath(runRoot, pointer.data.generation), manifestSchema);
  if (!manifest || manifest.generation !== pointer.data.generation) {
    throw new Error(`Block run index generation '${pointer.data.generation}' is incomplete at '${runRoot}'.`);
  }
  return { generation: pointer.data.generation, manifest };
}

async function readPage(runRoot: string, snapshot: Snapshot, pageNumber: number) {
  const page = await readParsed(pagePath(runRoot, snapshot.generation, pageNumber), pageSchema);
  if (!page || page.generation !== snapshot.generation) {
    throw new Error(`Block run index page ${pageNumber} is missing at '${runRoot}'.`);
  }
  return page;
}

async function readAllEntries(runRoot: string, snapshot: Snapshot): Promise<BlockRunIndexEntry[]> {
  const entries: BlockRunIndexEntry[] = [];
  for (let pageNumber = 1; pageNumber <= snapshot.manifest.headPage; pageNumber += 1) {
    entries.push(...(await readPage(runRoot, snapshot, pageNumber)).entries);
  }
  if (entries.length !== snapshot.manifest.total) {
    throw new Error(`Block run index total mismatch at '${runRoot}'.`);
  }
  return entries;
}

export function compareBlockRunChronology(
  left: BlockRunLogicalCursor,
  right: BlockRunLogicalCursor
): number {
  const byTime = Date.parse(left.orderedAt) - Date.parse(right.orderedAt);
  return byTime !== 0 ? byTime : left.stableIdentity.localeCompare(right.stableIdentity);
}

function sortEntries(entries: readonly BlockRunIndexEntry[]): BlockRunIndexEntry[] {
  return [...entries].sort(compareBlockRunChronology);
}

async function writeSnapshot(
  runRoot: string,
  rawEntries: readonly BlockRunIndexEntry[],
  options: BlockRunIndexWriteOptions = {}
): Promise<void> {
  const entries = sortEntries(rawEntries);
  const generation = randomUUID();
  const root = generationRoot(runRoot, generation);
  await mkdir(root, { recursive: true });
  await options.afterStage?.("generation-created");
  let page = 0;
  for (let start = 0; start < entries.length; start += PAGE_SIZE) {
    page += 1;
    await writeJsonFile(pagePath(runRoot, generation, page), {
      version: 3,
      generation,
      page,
      entries: entries.slice(start, start + PAGE_SIZE)
    });
  }
  await options.afterStage?.("pages-written");
  await writeJsonFile(manifestPath(runRoot, generation), {
    version: 3,
    generation,
    pageSize: PAGE_SIZE,
    total: entries.length,
    headPage: page,
    head: entries.at(-1) ?? null,
    latestArtifact: entries.filter((entry) => entry.hasArtifact).at(-1) ?? null
  });
  await options.afterStage?.("before-publish");
  await writeJsonFile(pointerPath(runRoot), { version: 3, generation });
  await options.afterStage?.("published");
}

function blockRefFromRunRoot(runRoot: string): string {
  const blockId = basename(dirname(runRoot));
  const taskId = basename(dirname(dirname(dirname(runRoot))));
  if (!taskId || !blockId) throw new Error(`Cannot derive block identity from run root '${runRoot}'.`);
  return `${taskId}#${blockId}`;
}

async function readRunFacts(runRoot: string, runId: string): Promise<{
  orderedAt: string;
  stableIdentity: string;
  hasArtifact: boolean;
}> {
  const runDir = join(runRoot, runId);
  const metadataText = await optionalReadFile(join(runDir, "metadata.json"), "utf8");
  const metadata = metadataText === null
    ? null
    : z.record(z.string(), z.unknown()).parse(JSON.parse(metadataText) as unknown);
  const candidates = [metadata?.startedAt, metadata?.submittedAt, metadata?.finishedAt];
  let orderedAt: string | null = null;
  for (const candidate of candidates) {
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
  const ref = typeof metadata?.ref === "string" && metadata.ref !== ""
    ? metadata.ref
    : blockRefFromRunRoot(runRoot);
  const hasArtifact = Boolean(
    await optionalStat(join(runDir, "report.md"))
  ) || Boolean(metadata?.artifactReference && typeof metadata.artifactReference === "object");
  return { orderedAt, stableIdentity: `${ref}::${runId}`, hasArtifact };
}

async function migrateExistingRuns(
  runRoot: string,
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
  await writeSnapshot(runRoot, sorted, options);
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
      const snapshot = await readSnapshot(runRoot);
      indexedBlocks += 1;
      indexedRuns += snapshot?.manifest.total ?? 0;
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
    { lockPath: join(runRoot, ".planweave-task-workspace-run-index.lock"), operation: "rebuild-block-run-index" },
    () => migrateExistingRuns(runRoot, options)
  );
}

export async function initializeBlockRunIndex(
  runRoot: string,
  options: BlockRunIndexWriteOptions = {}
): Promise<void> {
  await mkdir(runRoot, { recursive: true });
  await withAdvisoryDirectoryLock(
    { lockPath: join(runRoot, ".planweave-task-workspace-run-index.lock"), operation: "initialize-block-run-index" },
    async () => {
      if (!(await readSnapshot(runRoot))) await migrateExistingRuns(runRoot, options);
    }
  );
}

export async function recordBlockRunInIndex(
  runRoot: string,
  runId: string,
  options: BlockRunIndexWriteOptions = {}
): Promise<void> {
  await mkdir(runRoot, { recursive: true });
  await withAdvisoryDirectoryLock(
    { lockPath: join(runRoot, ".planweave-task-workspace-run-index.lock"), operation: "record-block-run-index" },
    async () => {
      let snapshot = await readSnapshot(runRoot);
      if (!snapshot) {
        await migrateExistingRuns(runRoot, options);
        snapshot = await readSnapshot(runRoot);
      }
      if (!snapshot) throw new Error(`Failed to initialize block run index at '${runRoot}'.`);
      const entries = await readAllEntries(runRoot, snapshot);
      if (entries.some((entry) => entry.runId === runId)) return;
      const facts = await readRunFacts(runRoot, runId);
      const retryIndex = entries.reduce((max, entry) => Math.max(max, entry.retryIndex), 0) + 1;
      await writeSnapshot(runRoot, [...entries, { runId, retryIndex, ...facts }], options);
    }
  );
}

export async function requireBlockRunIndex(runRoot: string): Promise<void> {
  if (!(await readSnapshot(runRoot))) {
    throw new Error(`Task Workspace run index is missing at '${runRoot}'. Create or migrate the index before querying history.`);
  }
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
  const snapshot = await readSnapshot(runRoot);
  if (!snapshot) throw new Error(`Block run index is missing at '${runRoot}'.`);
  let startPage = snapshot.manifest.headPage;
  if (options.before && startPage > 0) {
    let low = 1;
    let high = startPage;
    let newestEligiblePage = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const page = await readPage(runRoot, snapshot, middle);
      const first = page.entries[0];
      const last = page.entries.at(-1);
      if (!first || !last) {
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
    pageNumber > 0 && newestFirst.length <= options.limit;
    pageNumber -= 1
  ) {
    const page = await readPage(runRoot, snapshot, pageNumber);
    for (let index = page.entries.length - 1; index >= 0; index -= 1) {
      const entry = page.entries[index]!;
      if (options.before && compareBlockRunChronology(entry, options.before) >= 0) continue;
      newestFirst.push(entry);
      if (newestFirst.length > options.limit) break;
    }
  }
  return {
    entries: newestFirst.slice(0, options.limit),
    hasMore: newestFirst.length > options.limit,
    head: snapshot.manifest.head,
    latestArtifact: snapshot.manifest.latestArtifact
  };
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

export async function readBlockRunIndexEntry(
  runRoot: string,
  runId: string
): Promise<BlockRunIndexEntry> {
  const snapshot = await readSnapshot(runRoot);
  if (!snapshot) throw new Error(`Block run index is missing at '${runRoot}'.`);
  const entry = (await readAllEntries(runRoot, snapshot)).find((candidate) => candidate.runId === runId);
  if (!entry) throw new Error(`Run '${runId}' is missing from the block run index.`);
  return entry;
}

export async function recordBlockRunArtifactInIndex(
  runRoot: string,
  runId: string,
  options: BlockRunIndexWriteOptions = {}
): Promise<void> {
  await withAdvisoryDirectoryLock(
    { lockPath: join(runRoot, ".planweave-task-workspace-run-index.lock"), operation: "record-block-run-artifact-index" },
    async () => {
      const snapshot = await readSnapshot(runRoot);
      if (!snapshot) throw new Error(`Block run index is missing at '${runRoot}'.`);
      const entries = await readAllEntries(runRoot, snapshot);
      const index = entries.findIndex((entry) => entry.runId === runId);
      if (index < 0) throw new Error(`Run '${runId}' is missing from the block run index.`);
      if (entries[index]!.hasArtifact) return;
      entries[index] = { ...entries[index]!, hasArtifact: true };
      await writeSnapshot(runRoot, entries, options);
    }
  );
}

export async function removeBlockRunFromIndex(runRoot: string, runId: string): Promise<void> {
  await withAdvisoryDirectoryLock(
    { lockPath: join(runRoot, ".planweave-task-workspace-run-index.lock"), operation: "remove-block-run-index" },
    async () => {
      let snapshot = await readSnapshot(runRoot);
      if (!snapshot) {
        await migrateExistingRuns(runRoot);
        snapshot = await readSnapshot(runRoot);
      }
      if (!snapshot) throw new Error(`Block run index is missing at '${runRoot}'.`);
      const entries = await readAllEntries(runRoot, snapshot);
      if (!entries.some((entry) => entry.runId === runId)) return;
      await writeSnapshot(runRoot, entries.filter((entry) => entry.runId !== runId));
    }
  );
}
