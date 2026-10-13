import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ZodError } from "zod";
import { withPackageFileConsistency } from "../package/packageFileConsistency.js";
import { assertCurrentCanvasWorkspaceIdentity } from "../package/assertCurrentCanvasWorkspace.js";
import { optionalStat } from "../fs/optionalFile.js";
import { initManagedWorkspace } from "../initWorkspace.js";
import { withManagedProjectCreation } from "./managedProjectCreation.js";
import { assertCurrentProjectWorkspace, resolveProjectWorkspaceInHome } from "../project.js";
import { withProjectMutationLock } from "../fs/withProjectMutationLock.js";
import { resolvePlanweaveHome } from "../paths.js";
import { createManagedProjectId } from "../projectId.js";
import type { PackageWorkspaceRef, ProjectWorkspace, ValidationIssue } from "../types.js";
import { selectTaskCanvas } from "./canvasSelectionApi.js";
import { readActiveTaskCanvasSelection } from "./canvasSelectionStore.js";
import {
  createProjectCanvasStore,
  populateDuplicatedCanvasWorkspace
} from "./projectCanvasStore.js";
import type { DesktopTaskCanvasWorkspace } from "./projectCanvasStore.js";
import type {
  DesktopCanvasDiagnosticIssue,
  DesktopProjectSummary,
  DesktopTaskCanvasSummary
} from "./types.js";

export type { DesktopTaskCanvasWorkspace } from "./projectCanvasStore.js";

const defaultCanvasId = "default";

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, path };
}

function projectGraphReadDiagnostics(error: unknown): ValidationIssue[] {
  if (error instanceof ZodError) {
    return error.issues.map((zodIssue) =>
      issue(
        "project_graph_schema",
        zodIssue.message,
        zodIssue.path.length > 0
          ? `project-graph.json:${zodIssue.path.join(".")}`
          : "project-graph.json"
      )
    );
  }
  return [
    issue(
      "project_graph_read_failed",
      error instanceof Error ? error.message : String(error),
      "project-graph.json"
    )
  ];
}

function projectGraphDiagnosticCanvas(diagnostics: ValidationIssue[]): DesktopTaskCanvasSummary {
  return {
    canvasId: "project-graph",
    name: "Project graph",
    packageDir: null,
    executionPolicy: null,
    taskCount: 0,
    missingPromptCount: 0,
    diagnostics: diagnostics.map(
      (diagnostic): DesktopCanvasDiagnosticIssue => ({ ...diagnostic, severity: "error" })
    ),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

async function managedProjectExists(name: string, planweaveHome: string): Promise<boolean> {
  const projectId = createManagedProjectId(name);
  return (await optionalStat(join(planweaveHome, "projects", projectId))) !== null;
}

async function nextCopiedProjectName(
  sourceName: string,
  requestedName: string | null | undefined,
  planweaveHome: string
): Promise<string> {
  const trimmedRequestedName = requestedName?.trim();
  if (trimmedRequestedName) {
    if (await managedProjectExists(trimmedRequestedName, planweaveHome)) {
      throw new Error(`PlanWeave project '${trimmedRequestedName}' already exists.`);
    }
    return trimmedRequestedName;
  }
  const baseName = `${sourceName.trim() || "Task canvas"} copy`;
  if (!(await managedProjectExists(baseName, planweaveHome))) {
    return baseName;
  }
  let index = 2;
  while (await managedProjectExists(`${baseName} ${index}`, planweaveHome)) {
    index += 1;
  }
  return `${baseName} ${index}`;
}

async function sourceCanvasForProjectCopy(
  projectRoot: PackageWorkspaceRef,
  canvasId: string
): Promise<{ name: string; workspace: ProjectWorkspace }> {
  return (await createProjectCanvasStore(projectRoot)).sourceCanvasWorkspace(canvasId);
}

function managedProjectSummary(
  project: Awaited<ReturnType<typeof initManagedWorkspace>>["project"],
  workspace: ProjectWorkspace,
  taskCanvases: DesktopTaskCanvasSummary[],
  activeCanvasId: string | null
): DesktopProjectSummary {
  return {
    projectId: project.id,
    name: project.name,
    kind: "managed",
    rootPath: workspace.workspaceRoot,
    sourceRoot: null,
    workspaceRoot: workspace.workspaceRoot,
    activeCanvasId,
    taskCanvases
  };
}

export async function listTaskCanvases(
  projectRoot: PackageWorkspaceRef
): Promise<DesktopTaskCanvasSummary[]> {
  try {
    // Await list() inside try so store open/load rejections are converted to diagnostics.
    return await (await createProjectCanvasStore(projectRoot)).list();
  } catch (error) {
    return [projectGraphDiagnosticCanvas(projectGraphReadDiagnostics(error))];
  }
}

export async function getActiveTaskCanvasId(
  projectRoot: PackageWorkspaceRef
): Promise<string | null> {
  try {
    return (await readActiveTaskCanvasSelection(projectRoot)).activeCanvasId;
  } catch (error) {
    if (
      error instanceof ZodError ||
      (error instanceof Error && error.message === "Project has no task canvas.")
    ) {
      return null;
    }
    throw error;
  }
}

export async function listTaskCanvasWorkspaces(
  projectRoot: PackageWorkspaceRef,
  options: { createRegistry?: boolean } = {}
): Promise<DesktopTaskCanvasWorkspace[]> {
  return (await createProjectCanvasStore(projectRoot)).listWorkspaces(options);
}

export async function resolveTaskCanvasWorkspace(
  projectRoot: PackageWorkspaceRef,
  canvasId?: string | null
): Promise<ProjectWorkspace> {
  return (await createProjectCanvasStore(projectRoot)).resolveWorkspace(canvasId);
}

export async function createTaskCanvas(
  projectRoot: string,
  input: { name?: string | null } = {}
): Promise<DesktopTaskCanvasSummary> {
  return (await createProjectCanvasStore(projectRoot)).create(input);
}

export async function duplicateTaskCanvas(
  projectRoot: string,
  canvasId: string,
  input: { name?: string | null } = {}
): Promise<DesktopTaskCanvasSummary> {
  return (await createProjectCanvasStore(projectRoot)).duplicate(canvasId, input);
}

export async function createProjectFromTaskCanvas(
  projectRoot: string,
  canvasId: string,
  input: { name?: string | null } = {}
): Promise<DesktopProjectSummary> {
  const planweaveHome = resolvePlanweaveHome();
  const projectWorkspace = await resolveProjectWorkspaceInHome(projectRoot, planweaveHome);
  const source = await sourceCanvasForProjectCopy(projectWorkspace, canvasId);
  const projectName = await nextCopiedProjectName(source.name, input.name, planweaveHome);
  const targetRoot = join(planweaveHome, "projects", createManagedProjectId(projectName));
  return withProjectMutationLock([projectWorkspace.workspaceRoot, targetRoot], async () => {
    await assertCurrentProjectWorkspace(source.workspace);
    return withManagedProjectCreation(
      { name: projectName, planweaveHome, sourceWorkspaces: [source.workspace] },
      async (init) => {
        const targetWorkspace = await resolveTaskCanvasWorkspace(init.workspace, defaultCanvasId);
        await withPackageFileConsistency(
          [
            source.workspace.packageDir,
            targetWorkspace.packageDir,
            join(source.workspace.workspaceRoot, "desktop", "layout.json"),
            join(targetWorkspace.workspaceRoot, "desktop", "layout.json")
          ],
          async () => {
            await assertCurrentCanvasWorkspaceIdentity(source.workspace);
            await rm(targetWorkspace.packageDir, { recursive: true, force: true });
            await populateDuplicatedCanvasWorkspace(source.workspace, targetWorkspace, projectName);
            await rm(targetWorkspace.resultsDir, { recursive: true, force: true });
            await mkdir(targetWorkspace.resultsDir, { recursive: true });
          }
        );
        const activeCanvasId = await getActiveTaskCanvasId(init.workspace);
        const taskCanvases = await listTaskCanvases(init.workspace);
        return managedProjectSummary(init.project, init.workspace, taskCanvases, activeCanvasId);
      }
    );
  });
}

export async function renameTaskCanvas(
  projectRoot: string,
  canvasId: string,
  name: string
): Promise<DesktopTaskCanvasSummary> {
  return (await createProjectCanvasStore(projectRoot)).rename(canvasId, name);
}

export async function removeTaskCanvas(
  projectRoot: string,
  canvasId: string
): Promise<DesktopTaskCanvasSummary[]> {
  return (await createProjectCanvasStore(projectRoot)).remove(canvasId);
}

export type ArchiveTaskCanvasOptions = {
  force?: boolean;
  reason?: string;
};

export type ArchiveTaskCanvasResult = {
  archivedCanvasId: string;
  reason: string | null;
  forced: boolean;
  activeCanvasId: string | null;
  remaining: DesktopTaskCanvasSummary[];
};

/**
 * Reversibly retire a non-default task canvas by quarantining its workspace and
 * removing it from the project registry. Delegates storage rules to removeTaskCanvas.
 * Refuses the only canvas, the formal default canvas (which remove would only reset),
 * and the active canvas unless force+reason are provided.
 */
export async function archiveTaskCanvas(
  projectRoot: string,
  canvasId: string,
  options: ArchiveTaskCanvasOptions = {}
): Promise<ArchiveTaskCanvasResult> {
  const requestedId = canvasId.trim();
  if (!requestedId) {
    throw new Error("Canvas id is required.");
  }

  const force = options.force === true;
  const reason = options.reason?.trim() || null;
  if (force && !reason) {
    throw new Error("Archiving with --force requires a non-empty --reason.");
  }

  const canvases = await listTaskCanvases(projectRoot);
  const target = canvases.find((canvas) => canvas.canvasId === requestedId);
  if (!target) {
    throw new Error(`Task canvas '${requestedId}' does not exist.`);
  }
  if (canvases.length <= 1) {
    throw new Error(
      `Cannot archive task canvas '${requestedId}' because it is the only canvas in the project.`
    );
  }
  if (requestedId === defaultCanvasId) {
    throw new Error(
      `Cannot archive formal default canvas '${defaultCanvasId}'. Archive is reversible retirement for non-default canvases only.`
    );
  }

  const activeCanvasId = await getActiveTaskCanvasId(projectRoot);
  if (activeCanvasId === requestedId && !force) {
    throw new Error(
      `Cannot archive active task canvas '${requestedId}' without --force and --reason. Switch with 'planweave canvas use <id>' first, or pass --force --reason.`
    );
  }

  if (activeCanvasId === requestedId) {
    const fallback = canvases.find((canvas) => canvas.canvasId !== requestedId);
    if (!fallback) {
      throw new Error(
        `Cannot archive task canvas '${requestedId}' because no fallback canvas remains.`
      );
    }
    await selectTaskCanvas(projectRoot, fallback.canvasId);
  }

  const remaining = await removeTaskCanvas(projectRoot, requestedId);
  if (remaining.some((canvas) => canvas.canvasId === requestedId)) {
    throw new Error(
      `Task canvas '${requestedId}' could not be archived because removal only reset it in place instead of retiring it.`
    );
  }

  return {
    archivedCanvasId: requestedId,
    reason,
    forced: force,
    activeCanvasId: await getActiveTaskCanvasId(projectRoot),
    remaining
  };
}
