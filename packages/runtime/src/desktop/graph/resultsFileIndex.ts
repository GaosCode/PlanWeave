import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { optionalStat } from "../../fs/optionalFile.js";
import { parseFeedbackSubmissionMetadata } from "../../taskManager/feedbackSubmissionMetadata.js";
import { parseImplementationRunMetadata } from "../../taskManager/implementationRunMetadata.js";
import { parseReviewAttemptMetadata } from "../../taskManager/reviewAttemptMetadata.js";
import type { ProjectWorkspace, ValidationIssue } from "../../types.js";
import { appendDesktopDiagnostic, desktopDiagnostic, errorMessage } from "./desktopDiagnostics.js";
import {
  maxCachedResultsDirectories,
  ResultsFileIndexCache,
  type ResultsFileIndexCacheScope
} from "./resultsFileIndexCache.js";

const resultFilePattern = /\.(md|json|log|txt)$/;

export const maxIndexedResultFileBytes = 256_000;
export const maxIndexedResultFileCount = 2_000;
export const maxIndexedResultTotalBodyBytes = 16_000_000;

const resultsIndexConcurrency = {
  directoryReads: 8,
  fileStats: 16,
  metadataReads: 8,
  bodyReads: 4
};

export type ResultsIndexLimits = {
  maxFiles: number;
  maxTotalBodyBytes: number;
  maxSingleFileBytes: number;
};

export type ResultFileFingerprint = {
  path: string;
  ctimeMs: number;
  mtimeMs: number;
  size: number;
};

export type ResultsFileIndexEntry = {
  absolutePath: string;
  relativePath: string;
  fingerprint: ResultFileFingerprint;
  body: string;
  bodyLoaded: boolean;
  bodyTruncated: boolean;
  metadata: Record<string, unknown> | null;
};

export type ResultsFileIndex = {
  workspace: ProjectWorkspace;
  entries: ResultsFileIndexEntry[];
  diagnostics: ValidationIssue[];
};

export type ResultsFileIndexWithFingerprint = {
  index: ResultsFileIndex;
  fingerprint: ResultsFileFingerprintSnapshot;
};

export type ResultsFileFingerprintSnapshot = {
  diagnostics: ValidationIssue[];
  files: ResultFileFingerprint[];
};

type CachedResultsFileIndexEntry = {
  fingerprint: ResultFileFingerprint;
  entry: ResultsFileIndexEntry;
  diagnostics: ValidationIssue[];
};

type CachedResultFileBody = {
  fingerprint: ResultFileFingerprint;
  body: string;
  diagnostics: ValidationIssue[];
};

type CachedResultsFileIndex = {
  entriesByRelativePath: Map<string, CachedResultsFileIndexEntry>;
  bodiesByRelativePath: Map<string, CachedResultFileBody>;
};

type ResultFingerprintSelection = {
  selected: ResultFileFingerprint[];
  observedFileCount: number;
  observedReadableBodyBytes: number;
  observedReadableBodyFileCount: number;
};

type CollectedResultDirectory = {
  directories: string[];
  files: string[];
  diagnostics: ValidationIssue[];
};

type CachedResultsFingerprintSnapshot = {
  signature: string;
  snapshot: ResultsFileFingerprintSnapshot;
};

const resultsFileIndexCacheByResultsDir = new ResultsFileIndexCache<CachedResultsFileIndex>(
  maxCachedResultsDirectories
);
const resultsFingerprintSnapshotCache = new ResultsFileIndexCache<CachedResultsFingerprintSnapshot>(
  maxCachedResultsDirectories
);

/** Counts full fingerprint rebuilds that walk the results tree via collectResultFiles. */
let resultsFingerprintFullScanCount = 0;

export { maxCachedResultsDirectories };

export function getResultsFingerprintFullScanCount(): number {
  return resultsFingerprintFullScanCount;
}

export function resetResultsFingerprintFullScanCount(): void {
  resultsFingerprintFullScanCount = 0;
}

export function clearResultsFileIndexCache(scope?: ResultsFileIndexCacheScope): void {
  resultsFileIndexCacheByResultsDir.clear(scope);
  resultsFingerprintSnapshotCache.clear(scope);
}

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

function resultPath(resultsDir: string, path: string): string {
  const resultRelativePath = toPosixPath(relative(resultsDir, path));
  return resultRelativePath ? `results/${resultRelativePath}` : "results";
}

async function runBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const boundedConcurrency = Math.max(1, Math.floor(concurrency));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(boundedConcurrency, items.length) }, runWorker));
  return results;
}

async function readResultDirectory(
  resultsDir: string,
  root: string
): Promise<CollectedResultDirectory> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const directories: string[] = [];
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
      } else if (entry.isFile() && resultFilePattern.test(entry.name)) {
        files.push(path);
      }
    }
    return { directories, files, diagnostics: [] };
  } catch (caught) {
    return {
      directories: [],
      files: [],
      diagnostics: [
        desktopDiagnostic(
          "desktop_results_read_failed",
          `Result files could not be listed: ${errorMessage(caught)}`,
          resultPath(resultsDir, root)
        )
      ]
    };
  }
}

async function walkResultFiles(
  resultsDir: string,
  root: string,
  diagnostics: ValidationIssue[],
  files: string[]
): Promise<void> {
  let directories = [root];
  while (directories.length > 0) {
    const collectedDirectories = await runBounded(
      directories,
      resultsIndexConcurrency.directoryReads,
      (directory) => readResultDirectory(resultsDir, directory)
    );
    const nextDirectories: string[] = [];
    for (const collected of collectedDirectories) {
      for (const diagnostic of collected.diagnostics) {
        appendDesktopDiagnostic(diagnostics, diagnostic);
      }
      files.push(...collected.files);
      nextDirectories.push(...collected.directories);
    }
    directories = nextDirectories;
  }
}

async function collectResultFiles(
  resultsDir: string,
  root: string,
  diagnostics: ValidationIssue[],
  files: string[]
): Promise<void> {
  resultsFingerprintFullScanCount += 1;
  await walkResultFiles(resultsDir, root, diagnostics, files);
}

/**
 * Conservative change detector for the results tree.
 * Includes every indexed result file's relative path plus ctimeMs/mtimeMs/size so in-place
 * rewrites (including same-size body edits that preserve mtime via utimes) are visible without
 * relying on parent-directory mtime. Matches ResultFileFingerprint identity fields.
 * This walk intentionally does not go through collectResultFiles (full fingerprint scan counter).
 */
export async function resultsDirSignature(resultsDir: string): Promise<string | null> {
  const top = await optionalStat(resultsDir);
  if (!top) {
    return null;
  }

  const diagnostics: ValidationIssue[] = [];
  const files: string[] = [];
  await walkResultFiles(resultsDir, resultsDir, diagnostics, files);

  const parts = new Array<string>(files.length);
  await runBounded(files, resultsIndexConcurrency.fileStats, async (absolutePath, index) => {
    const relativePath = toPosixPath(relative(resultsDir, absolutePath));
    try {
      const metadata = await stat(absolutePath);
      parts[index] = `${relativePath}\t${metadata.ctimeMs}\t${metadata.mtimeMs}\t${metadata.size}`;
    } catch {
      parts[index] = `${relativePath}\tmissing`;
    }
  });
  parts.sort((left, right) => left.localeCompare(right));
  // Directory list failures still affect the next full fingerprint snapshot diagnostics;
  // include a stable marker so a previously readable subtree becoming unreadable changes the signature.
  const diagnosticMarker = diagnostics
    .map((diagnostic) => `${diagnostic.code}\t${diagnostic.path ?? ""}\t${diagnostic.message}`)
    .sort((left, right) => left.localeCompare(right))
    .join("\n");
  return diagnosticMarker
    ? `${parts.join("\n")}\n#diagnostics\n${diagnosticMarker}`
    : parts.join("\n");
}

async function readResultBody(
  path: string,
  size: number,
  resultsDir: string
): Promise<{ body: string; diagnostics: ValidationIssue[] }> {
  if (size > maxIndexedResultFileBytes) {
    return { body: "", diagnostics: [] };
  }
  try {
    return { body: await readFile(path, "utf8"), diagnostics: [] };
  } catch (caught) {
    return {
      body: "",
      diagnostics: [
        desktopDiagnostic(
          "desktop_result_file_read_failed",
          `Result file could not be read: ${errorMessage(caught)}`,
          resultPath(resultsDir, path)
        )
      ]
    };
  }
}

function isMetadataPath(relativePath: string): boolean {
  return relativePath.endsWith("/metadata.json");
}

type ResultMetadataContract =
  | "implementation_run"
  | "review_attempt"
  | "feedback_submission"
  | "generic_object";

/**
 * Map result-relative metadata paths onto the shared taskManager artifact contracts.
 * Unknown layouts stay generic-object-only so non-result metadata files do not force a schema.
 */
function resultMetadataContractForRelativePath(relativePath: string): ResultMetadataContract {
  if (/^[^/]+\/blocks\/[^/]+\/runs\/[^/]+\/metadata\.json$/.test(relativePath)) {
    return "implementation_run";
  }
  if (/^[^/]+\/reviews\/[^/]+\/attempts\/[^/]+\/metadata\.json$/.test(relativePath)) {
    return "review_attempt";
  }
  if (/^[^/]+\/feedback\/[^/]+\/submissions\/[^/]+\/metadata\.json$/.test(relativePath)) {
    return "feedback_submission";
  }
  return "generic_object";
}

function parseMetadataWithArtifactContract(
  raw: unknown,
  relativePath: string,
  displayPath: string
): { value: Record<string, unknown> | null; diagnostics: ValidationIssue[] } {
  const contract = resultMetadataContractForRelativePath(relativePath);
  try {
    switch (contract) {
      case "implementation_run":
        return {
          value: parseImplementationRunMetadata(raw, displayPath) as Record<string, unknown>,
          diagnostics: []
        };
      case "review_attempt":
        return {
          value: parseReviewAttemptMetadata(raw, displayPath) as Record<string, unknown>,
          diagnostics: []
        };
      case "feedback_submission":
        return {
          value: parseFeedbackSubmissionMetadata(raw, displayPath) as Record<string, unknown>,
          diagnostics: []
        };
      case "generic_object":
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          return { value: raw as Record<string, unknown>, diagnostics: [] };
        }
        return {
          value: null,
          diagnostics: [
            desktopDiagnostic(
              "desktop_result_metadata_invalid",
              "Result metadata must be a JSON object.",
              displayPath
            )
          ]
        };
    }
  } catch (caught) {
    // Present malformed/invalid artifact metadata is a diagnostic, never an empty valid object.
    return {
      value: null,
      diagnostics: [
        desktopDiagnostic(
          "desktop_result_metadata_invalid",
          errorMessage(caught),
          displayPath
        )
      ]
    };
  }
}

function parseMetadata(
  body: string,
  displayPath: string,
  relativePath: string
): { value: Record<string, unknown> | null; diagnostics: ValidationIssue[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch (caught) {
    return {
      value: null,
      diagnostics: [
        desktopDiagnostic(
          "desktop_result_metadata_read_failed",
          `Result metadata could not be read or parsed: ${errorMessage(caught)}`,
          displayPath
        )
      ]
    };
  }

  return parseMetadataWithArtifactContract(parsed, relativePath, displayPath);
}

function sameResultsFingerprint(
  left: ResultFileFingerprint,
  right: ResultFileFingerprint
): boolean {
  return (
    left.path === right.path &&
    left.ctimeMs === right.ctimeMs &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size
  );
}

function newestResultFirst(left: ResultFileFingerprint, right: ResultFileFingerprint): number {
  const mtimeOrder = right.mtimeMs - left.mtimeMs;
  return mtimeOrder !== 0 ? mtimeOrder : left.path.localeCompare(right.path);
}

function createResultFingerprintSelection(): ResultFingerprintSelection {
  return {
    selected: [],
    observedFileCount: 0,
    observedReadableBodyBytes: 0,
    observedReadableBodyFileCount: 0
  };
}

function insertSelectedResultFingerprint(
  selected: ResultFileFingerprint[],
  fingerprint: ResultFileFingerprint,
  maxFiles: number
): void {
  if (maxFiles <= 0) {
    return;
  }
  let low = 0;
  let high = selected.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (newestResultFirst(fingerprint, selected[middle]) < 0) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  if (low >= maxFiles) {
    return;
  }
  selected.splice(low, 0, fingerprint);
  if (selected.length > maxFiles) {
    selected.pop();
  }
}

function observeResultFingerprint(
  selection: ResultFingerprintSelection,
  fingerprint: ResultFileFingerprint,
  limits: ResultsIndexLimits
): void {
  selection.observedFileCount += 1;
  if (fingerprint.size <= limits.maxSingleFileBytes) {
    selection.observedReadableBodyBytes += fingerprint.size;
    selection.observedReadableBodyFileCount += 1;
  }
  insertSelectedResultFingerprint(selection.selected, fingerprint, limits.maxFiles);
}

function finalizeResultFingerprintSelection(
  selection: ResultFingerprintSelection,
  limits: ResultsIndexLimits
): { files: ResultFileFingerprint[]; diagnostics: ValidationIssue[] } {
  const files: ResultFileFingerprint[] = [];
  let indexedBodyBytes = 0;
  let indexedReadableBodyFileCount = 0;
  let bodyBudgetExhausted = false;

  for (const fingerprint of selection.selected) {
    if (
      fingerprint.size <= limits.maxSingleFileBytes &&
      (bodyBudgetExhausted || indexedBodyBytes + fingerprint.size > limits.maxTotalBodyBytes)
    ) {
      bodyBudgetExhausted = true;
      continue;
    }
    files.push(fingerprint);
    if (fingerprint.size <= limits.maxSingleFileBytes) {
      indexedBodyBytes += fingerprint.size;
      indexedReadableBodyFileCount += 1;
    }
  }

  const diagnostics: ValidationIssue[] = [];
  if (selection.observedFileCount > limits.maxFiles) {
    diagnostics.push(
      desktopDiagnostic(
        "desktop_results_index_file_limit_exceeded",
        `Results index file limit exceeded: total=${selection.observedFileCount}, indexed=${files.length}, skipped=${selection.observedFileCount - files.length}, limit=${limits.maxFiles}.`,
        "results"
      )
    );
  }
  if (selection.observedReadableBodyBytes > limits.maxTotalBodyBytes) {
    const skippedBodyBytes = selection.observedReadableBodyBytes - indexedBodyBytes;
    const skippedBodyFiles = selection.observedReadableBodyFileCount - indexedReadableBodyFileCount;
    diagnostics.push(
      desktopDiagnostic(
        "desktop_results_index_byte_limit_exceeded",
        `Results index body byte limit exceeded: total=${selection.observedReadableBodyBytes}, indexed=${indexedBodyBytes}, skipped=${skippedBodyBytes}, limit=${limits.maxTotalBodyBytes}; skippedFiles=${skippedBodyFiles}.`,
        "results"
      )
    );
  }

  return { files, diagnostics };
}

export function selectIndexedResultFingerprints(
  fingerprints: ResultFileFingerprint[],
  limits: ResultsIndexLimits
): { files: ResultFileFingerprint[]; diagnostics: ValidationIssue[] } {
  const selection = createResultFingerprintSelection();
  for (const fingerprint of fingerprints) {
    observeResultFingerprint(selection, fingerprint, limits);
  }
  return finalizeResultFingerprintSelection(selection, limits);
}

async function fingerprintResultFiles(resultsDir: string): Promise<ResultsFileFingerprintSnapshot> {
  const diagnostics: ValidationIssue[] = [];
  const files: string[] = [];
  await collectResultFiles(resultsDir, resultsDir, diagnostics, files);
  const limits = {
    maxFiles: maxIndexedResultFileCount,
    maxTotalBodyBytes: maxIndexedResultTotalBodyBytes,
    maxSingleFileBytes: maxIndexedResultFileBytes
  };
  const selection = createResultFingerprintSelection();
  const statDiagnosticsByPath = new Map<string, ValidationIssue>();
  await runBounded(files, resultsIndexConcurrency.fileStats, async (absolutePath) => {
    try {
      const metadata = await stat(absolutePath);
      observeResultFingerprint(
        selection,
        {
          path: toPosixPath(relative(resultsDir, absolutePath)),
          ctimeMs: metadata.ctimeMs,
          mtimeMs: metadata.mtimeMs,
          size: metadata.size
        },
        limits
      );
    } catch (caught) {
      statDiagnosticsByPath.set(
        absolutePath,
        desktopDiagnostic(
          "desktop_result_file_read_failed",
          `Result file metadata could not be read: ${errorMessage(caught)}`,
          resultPath(resultsDir, absolutePath)
        )
      );
    }
  });
  for (const absolutePath of files) {
    const diagnostic = statDiagnosticsByPath.get(absolutePath);
    if (diagnostic) {
      appendDesktopDiagnostic(diagnostics, diagnostic);
    }
  }
  const selected = finalizeResultFingerprintSelection(selection, limits);
  for (const diagnostic of selected.diagnostics) {
    appendDesktopDiagnostic(diagnostics, diagnostic);
  }
  return {
    diagnostics,
    files: selected.files
  };
}

export async function snapshotResultsFileFingerprints(
  workspace: ProjectWorkspace
): Promise<ResultsFileFingerprintSnapshot> {
  const resultsDir = workspace.resultsDir;
  const signature = await resultsDirSignature(resultsDir);
  if (signature !== null) {
    const cached = resultsFingerprintSnapshotCache.get(resultsDir);
    if (cached && cached.signature === signature) {
      return cached.snapshot;
    }
  }

  const snapshot = await fingerprintResultFiles(resultsDir);
  if (signature !== null) {
    resultsFingerprintSnapshotCache.set(resultsDir, { signature, snapshot });
  }
  return snapshot;
}

function sameDiagnostic(left: ValidationIssue, right: ValidationIssue): boolean {
  return left.code === right.code && left.message === right.message && left.path === right.path;
}

function hasReadFailure(diagnostics: ValidationIssue[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.code === "desktop_result_file_read_failed");
}

export function sameResultsFileFingerprintSnapshot(
  left: ResultsFileFingerprintSnapshot,
  right: ResultsFileFingerprintSnapshot
): boolean {
  return (
    left.diagnostics.length === right.diagnostics.length &&
    left.diagnostics.every((diagnostic, index) =>
      sameDiagnostic(diagnostic, right.diagnostics[index])
    ) &&
    left.files.length === right.files.length &&
    left.files.every((fingerprint, index) =>
      sameResultsFingerprint(fingerprint, right.files[index])
    )
  );
}

async function readResultIndexEntry(
  workspace: ProjectWorkspace,
  fingerprint: ResultFileFingerprint
): Promise<CachedResultsFileIndexEntry> {
  const absolutePath = join(workspace.resultsDir, fingerprint.path);
  const diagnostics: ValidationIssue[] = [];
  const resultDisplayPath = resultPath(workspace.resultsDir, absolutePath);
  const metadataBody =
    isMetadataPath(fingerprint.path) && fingerprint.size <= maxIndexedResultFileBytes
      ? await readResultBody(absolutePath, fingerprint.size, workspace.resultsDir)
      : null;
  if (metadataBody) {
    for (const diagnostic of metadataBody.diagnostics) {
      appendDesktopDiagnostic(diagnostics, diagnostic);
    }
  }
  const parsedMetadata = isMetadataPath(fingerprint.path)
    ? fingerprint.size > maxIndexedResultFileBytes
      ? {
          value: null,
          diagnostics: [
            desktopDiagnostic(
              "desktop_result_metadata_read_failed",
              `Result metadata could not be read or parsed: file exceeds ${maxIndexedResultFileBytes} bytes.`,
              resultDisplayPath
            )
          ]
        }
      : parseMetadata(metadataBody?.body ?? "", resultDisplayPath, fingerprint.path)
    : { value: null, diagnostics: [] };
  for (const diagnostic of parsedMetadata.diagnostics) {
    appendDesktopDiagnostic(diagnostics, diagnostic);
  }
  const entry: ResultsFileIndexEntry = {
    absolutePath,
    relativePath: fingerprint.path,
    fingerprint,
    body: "",
    bodyLoaded: false,
    bodyTruncated: fingerprint.size > maxIndexedResultFileBytes,
    metadata: parsedMetadata.value
  };
  return {
    fingerprint,
    entry,
    diagnostics
  };
}

async function reuseOrReadResultIndexEntry(
  workspace: ProjectWorkspace,
  fingerprint: ResultFileFingerprint,
  cachedIndex: CachedResultsFileIndex | undefined
): Promise<CachedResultsFileIndexEntry> {
  const cached = cachedIndex?.entriesByRelativePath.get(fingerprint.path);
  if (cached && sameResultsFingerprint(cached.fingerprint, fingerprint)) {
    return cached;
  }
  return readResultIndexEntry(workspace, fingerprint);
}

export async function buildResultsFileIndexFromFingerprintSnapshot(
  workspace: ProjectWorkspace,
  snapshot: ResultsFileFingerprintSnapshot
): Promise<ResultsFileIndex> {
  const cachedIndex = resultsFileIndexCacheByResultsDir.get(workspace.resultsDir);
  const diagnostics: ValidationIssue[] = [...snapshot.diagnostics];
  const entries: ResultsFileIndexEntry[] = [];
  const nextEntriesByRelativePath = new Map<string, CachedResultsFileIndexEntry>();
  const cachedEntries = await runBounded(
    snapshot.files,
    resultsIndexConcurrency.metadataReads,
    (fingerprint) => reuseOrReadResultIndexEntry(workspace, fingerprint, cachedIndex)
  );
  for (const cachedEntry of cachedEntries) {
    for (const diagnostic of cachedEntry.diagnostics) {
      appendDesktopDiagnostic(diagnostics, diagnostic);
    }
    entries.push(cachedEntry.entry);
    if (!hasReadFailure(cachedEntry.diagnostics)) {
      nextEntriesByRelativePath.set(cachedEntry.fingerprint.path, cachedEntry);
    }
  }

  resultsFileIndexCacheByResultsDir.set(workspace.resultsDir, {
    entriesByRelativePath: nextEntriesByRelativePath,
    bodiesByRelativePath: cachedIndex?.bodiesByRelativePath ?? new Map()
  });

  return { workspace, entries, diagnostics };
}

function cachedResultBody(
  cachedIndex: CachedResultsFileIndex | undefined,
  fingerprint: ResultFileFingerprint
): CachedResultFileBody | null {
  const cached = cachedIndex?.bodiesByRelativePath.get(fingerprint.path);
  return cached && sameResultsFingerprint(cached.fingerprint, fingerprint) ? cached : null;
}

async function readCachedResultBody(
  workspace: ProjectWorkspace,
  entry: ResultsFileIndexEntry,
  cachedIndex: CachedResultsFileIndex | undefined
): Promise<CachedResultFileBody> {
  const cached = cachedResultBody(cachedIndex, entry.fingerprint);
  if (cached) {
    return cached;
  }
  const bodyResult = await readResultBody(
    entry.absolutePath,
    entry.fingerprint.size,
    workspace.resultsDir
  );
  return {
    fingerprint: entry.fingerprint,
    body: bodyResult.body,
    diagnostics: bodyResult.diagnostics
  };
}

function appendResultBodyLimitDiagnostic(
  diagnostics: ValidationIssue[],
  sourceDiagnostics: ValidationIssue[]
): void {
  const limited = sourceDiagnostics.some(
    (diagnostic) =>
      diagnostic.code === "desktop_results_index_file_limit_exceeded" ||
      diagnostic.code === "desktop_results_index_byte_limit_exceeded"
  );
  if (!limited) {
    return;
  }
  appendDesktopDiagnostic(
    diagnostics,
    desktopDiagnostic(
      "desktop_search_body_index_skipped_by_limit",
      "Search result body indexing skipped some result files because index limits were reached.",
      "results"
    )
  );
}

export async function hydrateResultsFileIndexBodies(
  index: ResultsFileIndex
): Promise<ResultsFileIndex> {
  const cachedIndex = resultsFileIndexCacheByResultsDir.get(index.workspace.resultsDir);
  const diagnostics: ValidationIssue[] = [...index.diagnostics];
  const entries: ResultsFileIndexEntry[] = [];
  const nextBodiesByRelativePath = new Map<string, CachedResultFileBody>();

  appendResultBodyLimitDiagnostic(diagnostics, index.diagnostics);

  const hydratedEntries = await runBounded(
    index.entries,
    resultsIndexConcurrency.bodyReads,
    async (entry) => {
      if (entry.bodyLoaded || entry.bodyTruncated) {
        return { entry, body: null };
      }
      const body = await readCachedResultBody(index.workspace, entry, cachedIndex);
      return {
        entry: {
          ...entry,
          body: body.body,
          bodyLoaded: body.diagnostics.length === 0,
          bodyTruncated: entry.bodyTruncated
        },
        body
      };
    }
  );

  for (const hydrated of hydratedEntries) {
    const body = hydrated.body;
    if (body) {
      for (const diagnostic of body.diagnostics) {
        appendDesktopDiagnostic(diagnostics, diagnostic);
      }
      if (!hasReadFailure(body.diagnostics)) {
        nextBodiesByRelativePath.set(hydrated.entry.relativePath, body);
      }
    }
    entries.push(hydrated.entry);
  }

  resultsFileIndexCacheByResultsDir.set(index.workspace.resultsDir, {
    entriesByRelativePath: cachedIndex?.entriesByRelativePath ?? new Map(),
    bodiesByRelativePath: nextBodiesByRelativePath
  });

  return {
    workspace: index.workspace,
    entries,
    diagnostics
  };
}

export async function buildResultsFileIndexWithFingerprint(
  workspace: ProjectWorkspace
): Promise<ResultsFileIndexWithFingerprint> {
  const fingerprint = await snapshotResultsFileFingerprints(workspace);
  return {
    index: await buildResultsFileIndexFromFingerprintSnapshot(workspace, fingerprint),
    fingerprint
  };
}

export async function buildResultsFileIndex(
  workspace: ProjectWorkspace
): Promise<ResultsFileIndex> {
  return (await buildResultsFileIndexWithFingerprint(workspace)).index;
}
