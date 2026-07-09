import type { ValidationIssue } from "../../types.js";
import type {
  DesktopSearchFilters,
  DesktopSearchProjection,
  DesktopSearchResult
} from "../types.js";
import { appendDesktopDiagnostics } from "./desktopDiagnostics.js";
import {
  readDesktopProjectProjectionContext,
  readDesktopProjectSearchIndexFromContext
} from "./projectProjectionModel.js";
import { searchDesktopSearchIndex } from "./searchIndexModel.js";

const bodySearchKinds = new Set(["prompt", "run_record", "review_attempt"]);

function searchNeedsBodyIndex(filters: DesktopSearchFilters): boolean {
  if (typeof filters.includeBodies === "boolean") {
    return filters.includeBodies;
  }
  if (!filters.kinds?.length) {
    return true;
  }
  return filters.kinds.some((kind) => bodySearchKinds.has(kind));
}

export async function searchProjectWithDiagnostics(
  projectRoot: string,
  query: string,
  filters: DesktopSearchFilters = {}
): Promise<DesktopSearchProjection> {
  const context = await readDesktopProjectProjectionContext(projectRoot);
  const projection = context.projection;
  const diagnostics: ValidationIssue[] = [...projection.diagnostics];

  if (
    typeof filters.canvasId === "string" &&
    !projection.todoContext.aggregation.canvasesById.has(filters.canvasId)
  ) {
    throw new Error(`Task canvas '${filters.canvasId}' does not exist.`);
  }

  const index = await readDesktopProjectSearchIndexFromContext(context, {
    includeBodies: searchNeedsBodyIndex(filters)
  });
  appendDesktopDiagnostics(diagnostics, index.diagnostics);
  return {
    results: searchDesktopSearchIndex(index, query, filters),
    diagnostics
  };
}

export async function searchProject(
  projectRoot: string,
  query: string,
  filters: DesktopSearchFilters = {}
): Promise<DesktopSearchResult[]> {
  return (await searchProjectWithDiagnostics(projectRoot, query, filters)).results;
}
