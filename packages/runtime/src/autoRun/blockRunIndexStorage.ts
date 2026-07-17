import { optionalReadFile } from "../fs/optionalFile.js";
import {
  BLOCK_RUN_INDEX_PAGE_SIZE,
  blockRunIndexPageChecksum,
  blockRunIndexPageObjectId,
  blockRunIndexV3ManifestSchema,
  blockRunIndexV3PageSchema,
  blockRunIndexV3PointerSchema,
  blockRunIndexV4ManifestSchema,
  blockRunIndexV4PageSchema,
  blockRunIndexV4PointerSchema,
  type BlockRunIndexEntry
} from "./blockRunIndexSchema.js";
import { join } from "node:path";
import { z } from "zod";

const indexDirectoryName = ".planweave-task-workspace-run-index";
const supportedPointerSchema = z.union([
  blockRunIndexV3PointerSchema,
  blockRunIndexV4PointerSchema
]);

export interface BlockRunIndexReadSnapshot {
  version: 3 | 4;
  total: number;
  pageCount: number;
  head: BlockRunIndexEntry | null;
  latestArtifact: BlockRunIndexEntry | null;
  readPage(pageIndex: number): Promise<BlockRunIndexEntry[]>;
}

function indexRoot(runRoot: string): string {
  return join(runRoot, indexDirectoryName);
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

export async function readBlockRunIndexSnapshot(
  runRoot: string
): Promise<BlockRunIndexReadSnapshot | null> {
  const root = indexRoot(runRoot);
  const pointerText = await optionalReadFile(join(root, "current.json"), "utf8");
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
        if (
          !page ||
          page.generation !== pointer.generation ||
          page.page !== pageNumber ||
          page.entries.length > BLOCK_RUN_INDEX_PAGE_SIZE
        ) {
          throw indexContractError(runRoot, `v3 page ${pageNumber} is incomplete`);
        }
        return page.entries;
      }
    };
  }

  const generation = pointer.currentGeneration;
  const manifest = await readParsed(
    join(root, "generations", generation, "manifest.json"),
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

  return {
    version: 4,
    total: manifest.total,
    pageCount: manifest.pages.length,
    head: manifest.head,
    latestArtifact: manifest.latestArtifact,
    async readPage(pageIndex) {
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= manifest.pages.length) {
        throw indexContractError(runRoot, `page index ${pageIndex} is out of bounds`);
      }
      const descriptor = manifest.pages.at(pageIndex);
      if (!descriptor) {
        throw indexContractError(runRoot, `page index ${pageIndex} is out of bounds`);
      }
      const page = await readParsed(
        join(root, "objects", `${descriptor.objectId}.json`),
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
      if (!first || !last) {
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
  };
}
