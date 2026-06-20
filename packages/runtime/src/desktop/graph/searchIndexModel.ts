import { resolvePackagePath } from "../../package/resolvePackagePath.js";
import type { ValidationIssue } from "../../types.js";
import type { DesktopSearchFilters, DesktopSearchResult, DesktopSearchResultKind } from "../types.js";
import { appendDesktopDiagnostics } from "./desktopDiagnostics.js";
import { blockRef, getTask, promptPreview, readOptionalFile } from "./graphHelpers.js";
import type { ProjectTodoContext } from "./todoModel.js";
import type { ResultsFileIndex } from "./resultsFileIndex.js";

export type DesktopSearchDocument = {
  kind: DesktopSearchResultKind;
  canvasId: string;
  canvasName: string;
  ref: string;
  targetRef?: string;
  title: string;
  body: string;
  path?: string;
  recordId?: string;
};

export type DesktopSearchIndex = {
  documents: DesktopSearchDocument[];
  diagnostics: ValidationIssue[];
};

const defaultSearchLimit = 100;
const minSearchLimit = 1;
const maxSearchLimit = 100;

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
  return diagnostics.some((diagnostic) => diagnostic.code === "manifest_schema" || diagnostic.code === "manifest_read_failed");
}

function documentMatches(document: DesktopSearchDocument, normalizedQuery: string): boolean {
  if (document.kind === "prompt") {
    return document.body.toLowerCase().includes(normalizedQuery);
  }
  return document.title.toLowerCase().includes(normalizedQuery) || document.body.toLowerCase().includes(normalizedQuery);
}

type RankedSearchResult = {
  result: DesktopSearchResult;
  rank: SearchRank;
  documentIndex: number;
};

type SearchRank = {
  titleExact: number;
  titleIncludes: number;
  primaryKind: number;
  matchIndex: number;
  excerptLength: number;
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
  const normalizedTitle = document.title.trim().toLowerCase();
  const titleIndex = normalizedTitle.indexOf(normalizedQuery);
  const bodyIndex = document.body.toLowerCase().indexOf(normalizedQuery);
  const matchedText = titleIndex >= 0 ? document.title : document.body;
  return {
    titleExact: normalizedTitle === normalizedQuery ? 0 : 1,
    titleIncludes: titleIndex >= 0 ? 0 : 1,
    primaryKind: documentKindPriority(document),
    matchIndex: titleIndex >= 0 ? titleIndex : bodyIndex,
    excerptLength: promptPreview(matchedText).length
  };
}

function compareSearchRank(left: RankedSearchResult, right: RankedSearchResult): number {
  return left.rank.titleExact - right.rank.titleExact
    || left.rank.titleIncludes - right.rank.titleIncludes
    || left.rank.primaryKind - right.rank.primaryKind
    || left.rank.matchIndex - right.rank.matchIndex
    || left.rank.excerptLength - right.rank.excerptLength
    || left.documentIndex - right.documentIndex;
}

function searchResultFromDocument(document: DesktopSearchDocument, normalizedQuery: string): DesktopSearchResult {
  const excerptSource = document.body.toLowerCase().includes(normalizedQuery) ? document.body : document.title;
  return {
    kind: document.kind,
    canvasId: document.canvasId,
    canvasName: document.canvasName,
    ref: document.ref,
    targetRef: document.targetRef,
    title: document.title,
    excerpt: promptPreview(excerptSource),
    path: document.path,
    recordId: document.recordId
  };
}

export async function buildSearchIndexFromProjectTodoContext(
  context: ProjectTodoContext,
  resultsByCanvas: Map<string, ResultsFileIndex>
): Promise<DesktopSearchIndex> {
  const diagnostics: ValidationIssue[] = [];
  const documents: DesktopSearchDocument[] = [];

  for (const canvasId of context.aggregation.orderedCanvasIds) {
    const canvas = context.aggregation.canvasesById.get(canvasId);
    const snapshot = context.snapshotsByCanvas.get(canvasId);
    if (!canvas) {
      continue;
    }
    if (hasSearchBlockingPackageDiagnostics(canvas.canvas.diagnostics)) {
      appendDesktopDiagnostics(diagnostics, canvas.canvas.diagnostics);
      continue;
    }
    if (!snapshot || snapshot.error || !snapshot.runtime) {
      continue;
    }
    const canvasMeta = { canvasId, canvasName: canvas.canvasName };
    for (const taskId of snapshot.runtime.graph.taskNodesInManifestOrder) {
      const task = getTask(snapshot.runtime.graph, taskId);
      const taskPrompt = (await readOptionalFile(await resolvePackagePath(snapshot.runtime.workspace.packageDir, task.prompt), task.prompt)).markdown;
      documents.push({
        kind: "task",
        ...canvasMeta,
        ref: taskId,
        title: task.title,
        body: task.title
      });
      documents.push({
        kind: "prompt",
        ...canvasMeta,
        ref: taskId,
        targetRef: taskId,
        title: task.title,
        body: taskPrompt
      });
      for (const block of task.blocks) {
        const ref = blockRef(taskId, block.id);
        const blockPrompt = (await readOptionalFile(await resolvePackagePath(snapshot.runtime.workspace.packageDir, block.prompt), block.prompt)).markdown;
        documents.push({
          kind: "block",
          ...canvasMeta,
          ref,
          title: block.title,
          body: block.title
        });
        documents.push({
          kind: "prompt",
          ...canvasMeta,
          ref,
          targetRef: ref,
          title: block.title,
          body: blockPrompt
        });
      }
    }
    for (const [feedbackId, feedback] of Object.entries(snapshot.runtime.state.feedback)) {
      documents.push({
        kind: "feedback",
        ...canvasMeta,
        ref: feedbackId,
        targetRef: feedback.sourceReviewBlockRef,
        title: `${feedbackId} · ${feedback.sourceReviewBlockRef}`,
        body: feedback.content
      });
    }
    const resultIndex = resultsByCanvas.get(canvasId);
    if (!resultIndex) {
      continue;
    }
    appendDesktopDiagnostics(diagnostics, resultIndex.diagnostics);
    for (const entry of resultIndex.entries) {
      if (!entry.body) {
        continue;
      }
      const kind = entry.relativePath.includes("/reviews/") ? "review_attempt" : "run_record";
      const recordId = kind === "run_record" ? runRecordIdFromResultPath(entry.relativePath) ?? undefined : undefined;
      documents.push({
        kind,
        ...canvasMeta,
        ref: entry.relativePath,
        targetRef: kind === "review_attempt"
          ? reviewBlockRefFromResultPath(entry.relativePath) ?? undefined
          : recordId?.split("::")[0],
        title: entry.relativePath,
        body: entry.body,
        path: entry.relativePath,
        recordId
      });
    }
  }

  return { documents, diagnostics };
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
  const allowedKinds = filters.kinds?.length ? new Set<DesktopSearchResultKind>(filters.kinds) : null;
  return index.documents
    .map((document, documentIndex) => ({ document, documentIndex }))
    .filter(({ document }) => !allowedKinds || allowedKinds.has(document.kind))
    .filter(({ document }) => typeof filters.canvasId !== "string" || document.canvasId === filters.canvasId)
    .filter(({ document }) => documentMatches(document, normalized))
    .map(({ document, documentIndex }) => ({
      result: searchResultFromDocument(document, normalized),
      rank: searchRank(document, normalized),
      documentIndex
    }))
    .sort(compareSearchRank)
    .slice(0, searchLimit(filters))
    .map((ranked) => ranked.result);
}
