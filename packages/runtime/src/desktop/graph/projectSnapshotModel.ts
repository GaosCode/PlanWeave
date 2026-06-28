import { resolve } from "node:path";
import { readProjectPrompt, readProjectPromptPolicy } from "../../projectPromptPolicy.js";
import { getDesktopLayout, getDesktopLayoutForPackage } from "../layoutApi.js";
import { resolveTaskCanvasWorkspace } from "../canvasApi.js";
import type { ProjectWorkspace, ValidationIssue } from "../../types.js";
import type { DesktopCanvasReference, DesktopProjectSnapshot } from "../types.js";
import {
  buildDesktopGraphViewModelContext,
  buildGraphViewModel,
  loadDesktopGraphViewModelContext,
  type DesktopGraphViewModelContext
} from "./readModel.js";
import { appendDesktopDiagnostic, appendDesktopDiagnostics, desktopDiagnostic, errorMessage, formatDesktopDiagnostic } from "./desktopDiagnostics.js";
import {
  buildDesktopProjectStatisticsProjectionFromProjection,
  readDesktopProjectProjection,
  type DesktopProjectProjection
} from "./projectProjectionModel.js";
import { buildProjectExecutionPlanFromContext, buildTodoGroupsFromContext, type ProjectTodoContext } from "./todoModel.js";

async function captureSnapshotPart<T>(
  diagnostics: ValidationIssue[],
  label: string,
  load: () => Promise<T>
): Promise<T | null> {
  try {
    return await load();
  } catch (caught) {
    appendDesktopDiagnostic(diagnostics, desktopDiagnostic("desktop_snapshot_part_failed", errorMessage(caught), label));
    return null;
  }
}

type SelectedWorkspaceResult =
  | { ok: true; workspace: Awaited<ReturnType<typeof resolveTaskCanvasWorkspace>> }
  | { ok: false; error: unknown };

type SnapshotResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

async function captureResult<T>(load: () => Promise<T>): Promise<SnapshotResult<T>> {
  try {
    return { ok: true, value: await load() };
  } catch (error) {
    return { ok: false, error };
  }
}

function unwrapSnapshotResult<T>(result: SnapshotResult<T>): T {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function sameWorkspace(left: ProjectWorkspace, right: ProjectWorkspace): boolean {
  return resolve(left.packageDir) === resolve(right.packageDir)
    && resolve(left.stateFile) === resolve(right.stateFile)
    && resolve(left.resultsDir) === resolve(right.resultsDir);
}

function selectedGraphContextFromProjectTodoContext(
  context: ProjectTodoContext,
  selectedWorkspace: ProjectWorkspace
): DesktopGraphViewModelContext {
  const canvas = context.aggregation.canvases.find((candidate) => sameWorkspace(candidate.workspace, selectedWorkspace));
  if (!canvas) {
    throw new Error("Selected task canvas is not listed in project aggregation.");
  }
  const snapshot = context.snapshotsByCanvas.get(canvas.canvasId);
  if (!snapshot) {
    throw new Error(`Selected task canvas '${canvas.canvasId}' execution snapshot is missing.`);
  }
  if (snapshot.error) {
    throw new Error(`Selected task canvas '${canvas.canvasId}' execution snapshot failed: ${errorMessage(snapshot.error)}`);
  }
  if (!snapshot.runtime || !snapshot.status) {
    throw new Error(`Selected task canvas '${canvas.canvasId}' execution status is unavailable.`);
  }
  return buildDesktopGraphViewModelContext(snapshot.runtime, snapshot.status);
}

export async function getDesktopProjectSnapshot(ref: DesktopCanvasReference): Promise<DesktopProjectSnapshot> {
  const diagnostics: ValidationIssue[] = [];
  const selectedWorkspace: SelectedWorkspaceResult = await resolveTaskCanvasWorkspace(ref.projectRoot, ref.canvasId)
    .then((workspace) => ({ ok: true, workspace }) as const)
    .catch((error: unknown) => ({ ok: false, error }) as const);
  const getSelectedWorkspace = () => {
    if (!selectedWorkspace.ok) {
      throw selectedWorkspace.error;
    }
    return selectedWorkspace.workspace;
  };
  const projectProjection: SnapshotResult<DesktopProjectProjection> = await captureResult(() => readDesktopProjectProjection(ref.projectRoot));
  if (projectProjection.ok) {
    appendDesktopDiagnostics(diagnostics, projectProjection.value.diagnostics);
  }
  const projectTodoContext: SnapshotResult<ProjectTodoContext> = projectProjection.ok
    ? { ok: true, value: projectProjection.value.todoContext }
    : { ok: false, error: projectProjection.error };
  const selectedGraphContext: SnapshotResult<DesktopGraphViewModelContext> = selectedWorkspace.ok
    ? projectTodoContext.ok
      ? await captureResult(async () => selectedGraphContextFromProjectTodoContext(projectTodoContext.value, selectedWorkspace.workspace))
      : await captureResult(() => loadDesktopGraphViewModelContext(selectedWorkspace.workspace))
    : { ok: false, error: selectedWorkspace.error };

  const [
    projectPromptMarkdown,
    projectPromptPolicy,
    graph,
    layout,
    todoGroups,
    executionPlan,
    statistics
  ] = await Promise.all([
    captureSnapshotPart(diagnostics, "projectPromptMarkdown", () => readProjectPrompt(ref.projectRoot)),
    captureSnapshotPart(diagnostics, "projectPromptPolicy", () => readProjectPromptPolicy(ref.projectRoot)),
    captureSnapshotPart(diagnostics, "graph", async () => buildGraphViewModel(unwrapSnapshotResult(selectedGraphContext))),
    captureSnapshotPart(diagnostics, "layout", async () => {
      if (selectedGraphContext.ok) {
        return getDesktopLayoutForPackage(selectedGraphContext.value.workspace, selectedGraphContext.value.manifest);
      }
      return getDesktopLayout(getSelectedWorkspace());
    }),
    captureSnapshotPart(diagnostics, "todoGroups", async () => buildTodoGroupsFromContext(unwrapSnapshotResult(projectTodoContext))),
    captureSnapshotPart(diagnostics, "executionPlan", async () => buildProjectExecutionPlanFromContext(unwrapSnapshotResult(projectTodoContext))),
    captureSnapshotPart(diagnostics, "statistics", async () => {
      const projection = await buildDesktopProjectStatisticsProjectionFromProjection(
        unwrapSnapshotResult(projectProjection),
        ref.projectRoot
      );
      appendDesktopDiagnostics(diagnostics, projection.diagnostics);
      return projection.statistics;
    })
  ]);

  return {
    projectPromptMarkdown,
    projectPromptPolicy,
    graph,
    layout,
    todoGroups,
    executionPlan,
    statistics,
    diagnostics,
    errors: diagnostics.map(formatDesktopDiagnostic)
  };
}
