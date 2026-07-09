import { resolvePackagePath } from "../../package/resolvePackagePath.js";
import type { ValidationIssue } from "../../types.js";
import type {
  DesktopSearchFilters,
  DesktopSearchMatch,
  DesktopSearchMatchField,
  DesktopSearchResult,
  DesktopSearchResultKind
} from "../types.js";
import { appendDesktopDiagnostics } from "./desktopDiagnostics.js";
import { blockRef, getTask, promptPreview, readOptionalFile } from "./graphHelpers.js";
import type { CanvasExecutionSnapshot, ProjectTodoContext } from "./todoModel.js";
import type { ResultsFileIndex } from "./resultsFileIndex.js";
import type { ProjectCanvasAggregationContext } from "./projectCanvasAggregation.js";

export type DesktopSearchDocumentTier = "summary" | "body";

export type DesktopSearchDocument = {
  kind: DesktopSearchResultKind;
  tier: DesktopSearchDocumentTier;
  canvasId: string;
  canvasName: string;
  ref: string;
  targetRef?: string;
  title: string;
  normalizedTitle: string;
  body: string;
  normalizedBody: string;
  path?: string;
  recordId?: string;
};

export type DesktopSearchDocumentInput = Omit<
  DesktopSearchDocument,
  "normalizedTitle" | "normalizedBody" | "tier"
> & {
  tier?: DesktopSearchDocumentTier;
};

export type DesktopSearchIndex = {
  documents: DesktopSearchDocument[];
  diagnostics: ValidationIssue[];
};

export type CanvasSearchDocumentsInput = {
  aggregation: ProjectCanvasAggregationContext;
  canvasId: string;
  snapshot: CanvasExecutionSnapshot | undefined;
  resultIndex: ResultsFileIndex | undefined;
};

const defaultSearchLimit = 100;
const minSearchLimit = 1;
const maxSearchLimit = 100;
const maxPromptPreviewLength = 220;
const maxSearchMatchExcerptLength = 120;
const promptPreviewWhitespacePattern = /\s/;

function runRecordIdFromResultPath(path: string): string | null {
  const match = /^([^/]+)\/blocks\/([^/]+)\/runs\/([^/]+)\//.exec(path);
  if (!match) {
    return null;
  }
  return `${match[1]}#${match[2]}::${match[3]}`;
}

function reviewBlockRefFromResultPath(path: string): string | null {
  const match = path.match(/^([^/]+)\/reviews\/([^/]+)\/attempts\//);
  return match ? blockRef(match[1], match[2]) : null;
}

function hasSearchBlockingPackageDiagnostics(diagnostics: ValidationIssue[]): boolean {
  return diagnostics.some(
    (diagnostic) =>
      diagnostic.code === "manifest_schema" || diagnostic.code === "manifest_read_failed"
  );
}

function normalizeSearchText(text: string): string {
  return text.toLowerCase();
}

function promptPreviewLength(markdown: string): number {
  let length = 0;
  let hasContent = false;
  let hasPendingWhitespace = false;

  for (let index = 0; index < markdown.length; index += 1) {
    const character = markdown[index];
    if (promptPreviewWhitespacePattern.test(character)) {
      if (hasContent) {
        hasPendingWhitespace = true;
      }
      continue;
    }
    if (hasPendingWhitespace) {
      length += 1;
      if (length >= maxPromptPreviewLength) {
        return maxPromptPreviewLength;
      }
      hasPendingWhitespace = false;
    }
    length += 1;
    hasContent = true;
    if (length >= maxPromptPreviewLength) {
      return maxPromptPreviewLength;
    }
  }

  return length;
}

export function createDesktopSearchDocument(
  document: DesktopSearchDocumentInput
): DesktopSearchDocument {
  return {
    ...document,
    tier: document.tier ?? "summary",
    normalizedTitle: normalizeSearchText(document.title),
    normalizedBody: normalizeSearchText(document.body)
  };
}

function documentMatches(document: DesktopSearchDocument, normalizedQuery: string): boolean {
  if (document.kind === "prompt") {
    return document.normalizedBody.includes(normalizedQuery);
  }
  return (
    document.normalizedTitle.includes(normalizedQuery) ||
    document.normalizedBody.includes(normalizedQuery)
  );
}

export function highlightableExcerpt(
  source: string,
  matchStart: number,
  matchLength: number
): Pick<DesktopSearchMatch, "excerpt" | "excerptStart"> {
  const leftContext = Math.max(0, Math.floor((maxSearchMatchExcerptLength - matchLength) / 2));
  let excerptStart = Math.max(0, matchStart - leftContext);
  let excerptEnd = Math.min(source.length, excerptStart + maxSearchMatchExcerptLength);

  if (excerptEnd - excerptStart < maxSearchMatchExcerptLength) {
    excerptStart = Math.max(0, excerptEnd - maxSearchMatchExcerptLength);
  }
  if (excerptStart > 0) {
    const nextWhitespace = source
      .slice(excerptStart, matchStart)
      .search(promptPreviewWhitespacePattern);
    if (nextWhitespace >= 0) {
      excerptStart += nextWhitespace + 1;
    }
  }
  if (excerptEnd < source.length) {
    const trailingWhitespace = source
      .slice(matchStart + matchLength, excerptEnd)
      .search(promptPreviewWhitespacePattern);
    if (trailingWhitespace >= 0) {
      excerptEnd = matchStart + matchLength + trailingWhitespace;
    }
  }

  return { excerpt: source.slice(excerptStart, excerptEnd), excerptStart };
}

export function buildSearchMatch(
  source: string,
  normalizedSource: string,
  normalizedQuery: string,
  field: DesktopSearchMatchField
): DesktopSearchMatch | null {
  const start = normalizedSource.indexOf(normalizedQuery);
  if (start < 0) {
    return null;
  }
  return {
    field,
    start,
    length: normalizedQuery.length,
    ...highlightableExcerpt(source, start, normalizedQuery.length)
  };
}

export function findDocumentMatch(
  document: DesktopSearchDocument,
  normalizedQuery: string
): DesktopSearchMatch | null {
  if (document.kind === "prompt") {
    return buildSearchMatch(document.body, document.normalizedBody, normalizedQuery, "body");
  }
  return (
    buildSearchMatch(document.title, document.normalizedTitle, normalizedQuery, "title") ??
    buildSearchMatch(document.body, document.normalizedBody, normalizedQuery, "body")
  );
}

type RankedSearchResult = {
  document: DesktopSearchDocument;
  rank: SearchRank;
  documentIndex: number;
};

type SearchRank = {
  titleExact: number;
  titleIncludes: number;
  primaryKind: number;
  matchIndex: number;
  previewLength: number;
};

function searchLimit(filters: DesktopSearchFilters): number {
  if (typeof filters.limit !== "number" || !Number.isFinite(filters.limit)) {
    return defaultSearchLimit;
  }
  return Math.min(maxSearchLimit, Math.max(minSearchLimit, Math.floor(filters.limit)));
}

function documentKindPriority(document: DesktopSearchDocument): number {
  if (document.kind === "run_record" || document.kind === "review_attempt") {
    return 1;
  }
  return 0;
}

function searchRank(document: DesktopSearchDocument, normalizedQuery: string): SearchRank {
  const normalizedTitle = document.normalizedTitle.trim();
  const titleIndex = normalizedTitle.indexOf(normalizedQuery);
  const bodyIndex = document.normalizedBody.indexOf(normalizedQuery);
  const matchedText = titleIndex >= 0 ? document.title : document.body;
  return {
    titleExact: normalizedTitle === normalizedQuery ? 0 : 1,
    titleIncludes: titleIndex >= 0 ? 0 : 1,
    primaryKind: documentKindPriority(document),
    matchIndex: titleIndex >= 0 ? titleIndex : bodyIndex,
    previewLength: promptPreviewLength(matchedText)
  };
}

function compareSearchRank(left: RankedSearchResult, right: RankedSearchResult): number {
  return (
    left.rank.titleExact - right.rank.titleExact ||
    left.rank.titleIncludes - right.rank.titleIncludes ||
    left.rank.primaryKind - right.rank.primaryKind ||
    left.rank.matchIndex - right.rank.matchIndex ||
    left.rank.previewLength - right.rank.previewLength ||
    left.documentIndex - right.documentIndex
  );
}

function searchResultFromDocument(
  document: DesktopSearchDocument,
  normalizedQuery: string
): DesktopSearchResult {
  const excerptSource = document.normalizedBody.includes(normalizedQuery)
    ? document.body
    : document.title;
  const match = findDocumentMatch(document, normalizedQuery) ?? undefined;
  return {
    kind: document.kind,
    canvasId: document.canvasId,
    canvasName: document.canvasName,
    ref: document.ref,
    targetRef: document.targetRef,
    title: document.title,
    excerpt: promptPreview(excerptSource),
    match,
    path: document.path,
    recordId: document.recordId
  };
}

function resultKindFromPath(path: string): DesktopSearchResultKind {
  return path.includes("/reviews/") ? "review_attempt" : "run_record";
}

function resultTargetRef(
  kind: DesktopSearchResultKind,
  relativePath: string,
  recordId: string | undefined
): string | undefined {
  return kind === "review_attempt"
    ? (reviewBlockRefFromResultPath(relativePath) ?? undefined)
    : recordId?.split("::")[0];
}

function resultSearchDocument(input: {
  canvasMeta: { canvasId: string; canvasName: string };
  entry: ResultsFileIndex["entries"][number];
  tier: DesktopSearchDocumentTier;
}): DesktopSearchDocument {
  const kind = resultKindFromPath(input.entry.relativePath);
  const recordId =
    kind === "run_record"
      ? (runRecordIdFromResultPath(input.entry.relativePath) ?? undefined)
      : undefined;
  return createDesktopSearchDocument({
    kind,
    tier: input.tier,
    ...input.canvasMeta,
    ref: input.entry.relativePath,
    targetRef: resultTargetRef(kind, input.entry.relativePath, recordId),
    title: input.entry.relativePath,
    body: input.tier === "body" ? input.entry.body : "",
    path: input.entry.relativePath,
    recordId
  });
}

export async function buildSearchIndexForCanvas(
  input: CanvasSearchDocumentsInput
): Promise<DesktopSearchIndex> {
  const diagnostics: ValidationIssue[] = [];
  const documents: DesktopSearchDocument[] = [];
  const canvas = input.aggregation.canvasesById.get(input.canvasId);
  const snapshot = input.snapshot;
  if (!canvas) {
    return { documents, diagnostics };
  }
  if (hasSearchBlockingPackageDiagnostics(canvas.canvas.diagnostics)) {
    appendDesktopDiagnostics(diagnostics, canvas.canvas.diagnostics);
    return { documents, diagnostics };
  }
  if (!snapshot || snapshot.error || !snapshot.runtime) {
    return { documents, diagnostics };
  }
  const canvasMeta = { canvasId: input.canvasId, canvasName: canvas.canvasName };
  for (const taskId of snapshot.runtime.graph.taskNodesInManifestOrder) {
    const task = getTask(snapshot.runtime.graph, taskId);
    documents.push(
      createDesktopSearchDocument({
        kind: "task",
        ...canvasMeta,
        ref: taskId,
        title: task.title,
        body: task.title
      })
    );
    documents.push(
      createDesktopSearchDocument({
        kind: "prompt",
        ...canvasMeta,
        ref: taskId,
        targetRef: taskId,
        title: task.title,
        body: ""
      })
    );
    for (const block of task.blocks) {
      const ref = blockRef(taskId, block.id);
      documents.push(
        createDesktopSearchDocument({
          kind: "block",
          ...canvasMeta,
          ref,
          title: block.title,
          body: block.title
        })
      );
      documents.push(
        createDesktopSearchDocument({
          kind: "prompt",
          ...canvasMeta,
          ref,
          targetRef: ref,
          title: block.title,
          body: ""
        })
      );
    }
  }
  for (const [feedbackId, feedback] of Object.entries(snapshot.runtime.state.feedback)) {
    documents.push(
      createDesktopSearchDocument({
        kind: "feedback",
        ...canvasMeta,
        ref: feedbackId,
        targetRef: feedback.sourceReviewBlockRef,
        title: `${feedbackId} · ${feedback.sourceReviewBlockRef}`,
        body: feedback.content
      })
    );
  }
  if (!input.resultIndex) {
    return { documents, diagnostics };
  }
  appendDesktopDiagnostics(diagnostics, input.resultIndex.diagnostics);
  for (const entry of input.resultIndex.entries) {
    documents.push(resultSearchDocument({ canvasMeta, entry, tier: "summary" }));
  }

  return { documents, diagnostics };
}

export async function buildSearchBodyIndexForCanvas(
  input: CanvasSearchDocumentsInput
): Promise<DesktopSearchIndex> {
  const diagnostics: ValidationIssue[] = [];
  const documents: DesktopSearchDocument[] = [];
  const canvas = input.aggregation.canvasesById.get(input.canvasId);
  const snapshot = input.snapshot;
  if (!canvas) {
    return { documents, diagnostics };
  }
  if (hasSearchBlockingPackageDiagnostics(canvas.canvas.diagnostics)) {
    appendDesktopDiagnostics(diagnostics, canvas.canvas.diagnostics);
    return { documents, diagnostics };
  }
  if (!snapshot || snapshot.error || !snapshot.runtime) {
    return { documents, diagnostics };
  }
  const canvasMeta = { canvasId: input.canvasId, canvasName: canvas.canvasName };
  for (const taskId of snapshot.runtime.graph.taskNodesInManifestOrder) {
    const task = getTask(snapshot.runtime.graph, taskId);
    const taskPrompt = (
      await readOptionalFile(
        await resolvePackagePath(snapshot.runtime.workspace.packageDir, task.prompt),
        task.prompt
      )
    ).markdown;
    documents.push(
      createDesktopSearchDocument({
        kind: "prompt",
        tier: "body",
        ...canvasMeta,
        ref: taskId,
        targetRef: taskId,
        title: task.title,
        body: taskPrompt
      })
    );
    for (const block of task.blocks) {
      const ref = blockRef(taskId, block.id);
      const blockPrompt = (
        await readOptionalFile(
          await resolvePackagePath(snapshot.runtime.workspace.packageDir, block.prompt),
          block.prompt
        )
      ).markdown;
      documents.push(
        createDesktopSearchDocument({
          kind: "prompt",
          tier: "body",
          ...canvasMeta,
          ref,
          targetRef: ref,
          title: block.title,
          body: blockPrompt
        })
      );
    }
  }
  if (input.resultIndex) {
    appendDesktopDiagnostics(diagnostics, input.resultIndex.diagnostics);
    for (const entry of input.resultIndex.entries) {
      if (entry.bodyLoaded && entry.body) {
        documents.push(resultSearchDocument({ canvasMeta, entry, tier: "body" }));
      }
    }
  }
  return { documents, diagnostics };
}

function searchDocumentKey(document: DesktopSearchDocument): string {
  return [
    document.kind,
    document.canvasId,
    document.ref,
    document.targetRef ?? "",
    document.path ?? "",
    document.recordId ?? ""
  ].join("\u001f");
}

export function mergeSearchIndexBodies(
  summaryIndex: DesktopSearchIndex,
  bodyIndex: DesktopSearchIndex
): DesktopSearchIndex {
  const diagnostics: ValidationIssue[] = [];
  appendDesktopDiagnostics(diagnostics, summaryIndex.diagnostics);
  appendDesktopDiagnostics(diagnostics, bodyIndex.diagnostics);
  const bodyDocumentsByKey = new Map(
    bodyIndex.documents.map((document) => [searchDocumentKey(document), document])
  );
  const summaryKeys = new Set<string>();
  const documents = summaryIndex.documents.map((document) => {
    const key = searchDocumentKey(document);
    summaryKeys.add(key);
    return bodyDocumentsByKey.get(key) ?? document;
  });
  for (const document of bodyIndex.documents) {
    if (!summaryKeys.has(searchDocumentKey(document))) {
      documents.push(document);
    }
  }
  return { documents, diagnostics };
}

export function buildSearchIndexFromCanvasIndexes(
  indexes: DesktopSearchIndex[]
): DesktopSearchIndex {
  const diagnostics: ValidationIssue[] = [];
  const documents: DesktopSearchDocument[] = [];
  for (const index of indexes) {
    documents.push(...index.documents);
    appendDesktopDiagnostics(diagnostics, index.diagnostics);
  }
  return { documents, diagnostics };
}

export async function buildSearchIndexFromProjectTodoContext(
  context: ProjectTodoContext,
  resultsByCanvas: Map<string, ResultsFileIndex>
): Promise<DesktopSearchIndex> {
  const indexes: DesktopSearchIndex[] = [];

  for (const canvasId of context.aggregation.orderedCanvasIds) {
    indexes.push(
      await buildSearchIndexForCanvas({
        aggregation: context.aggregation,
        canvasId,
        snapshot: context.snapshotsByCanvas.get(canvasId),
        resultIndex: resultsByCanvas.get(canvasId)
      })
    );
  }

  return buildSearchIndexFromCanvasIndexes(indexes);
}

export function searchDesktopSearchIndex(
  index: DesktopSearchIndex,
  query: string,
  filters: DesktopSearchFilters = {}
): DesktopSearchResult[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  const allowedKinds = filters.kinds?.length
    ? new Set<DesktopSearchResultKind>(filters.kinds)
    : null;
  return index.documents
    .map((document, documentIndex) => ({ document, documentIndex }))
    .filter(({ document }) => !allowedKinds || allowedKinds.has(document.kind))
    .filter(
      ({ document }) =>
        typeof filters.canvasId !== "string" || document.canvasId === filters.canvasId
    )
    .filter(({ document }) => documentMatches(document, normalized))
    .map(({ document, documentIndex }) => ({
      document,
      rank: searchRank(document, normalized),
      documentIndex
    }))
    .sort(compareSearchRank)
    .slice(0, searchLimit(filters))
    .map((ranked) => searchResultFromDocument(ranked.document, normalized));
}
