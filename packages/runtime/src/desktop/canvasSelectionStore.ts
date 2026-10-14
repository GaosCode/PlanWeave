import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { optionalStat } from "../fs/optionalFile.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { withProjectMutationLock } from "../fs/withProjectMutationLock.js";
import { assertCurrentProjectWorkspace, resolveProjectWorkspace } from "../project.js";
import { loadProjectGraphForWorkspace } from "../projectGraph/index.js";
import type { PackageWorkspaceRef, ProjectWorkspace } from "../types.js";
import { normalizeRegistry, registryVersion, type TaskCanvasRegistry } from "./canvasRegistry.js";

const activeCanvasVersion = "desktop-active-canvas/v1" as const;

export type ActiveTaskCanvasSelection = {
  activeCanvasId: string;
};

function registryPath(workspace: ProjectWorkspace): string {
  return join(workspace.workspaceRoot, "desktop", "canvases.json");
}

function activeCanvasPath(workspace: ProjectWorkspace): string {
  return join(workspace.workspaceRoot, "desktop", "active-canvas.json");
}

function selectedRegistryCanvasId(registry: TaskCanvasRegistry): string | null {
  if (
    registry.activeCanvasId &&
    registry.canvases.some((canvas) => canvas.canvasId === registry.activeCanvasId)
  ) {
    return registry.activeCanvasId;
  }
  return registry.canvases[0]?.canvasId ?? null;
}

async function readLegacyRegistry(workspace: ProjectWorkspace): Promise<TaskCanvasRegistry | null> {
  const path = registryPath(workspace);
  if (!(await optionalStat(path))) {
    return null;
  }
  return normalizeRegistry(await readJsonFile<unknown>(path));
}

async function readProjectGraphActiveCanvas(
  workspace: ProjectWorkspace,
  canvasIds: string[]
): Promise<string | null> {
  const path = activeCanvasPath(workspace);
  if (await optionalStat(path)) {
    const raw = await readJsonFile<unknown>(path);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const activeCanvasId = (raw as Record<string, unknown>).activeCanvasId;
      if (typeof activeCanvasId === "string" && canvasIds.includes(activeCanvasId)) {
        return activeCanvasId;
      }
    }
  }
  return canvasIds[0] ?? null;
}

export async function readActiveTaskCanvasSelection(
  projectRoot: PackageWorkspaceRef
): Promise<ActiveTaskCanvasSelection> {
  const projectWorkspace =
    typeof projectRoot === "string" ? await resolveProjectWorkspace(projectRoot) : projectRoot;
  return readActiveTaskCanvasSelectionForWorkspace(projectWorkspace);
}

export async function readActiveTaskCanvasSelectionForWorkspace(
  workspace: ProjectWorkspace
): Promise<ActiveTaskCanvasSelection> {
  const loaded = await loadProjectGraphForWorkspace(workspace);
  const projectWorkspace = loaded.workspace;
  if (loaded.source === "project_graph") {
    const activeCanvasId = await readProjectGraphActiveCanvas(
      projectWorkspace,
      loaded.manifest.canvases.map((canvas) => canvas.id)
    );
    if (!activeCanvasId) {
      throw new Error("Project has no task canvas.");
    }
    return { activeCanvasId };
  }
  const registry = await readLegacyRegistry(projectWorkspace);
  const activeCanvasId = registry ? selectedRegistryCanvasId(registry) : null;
  if (!activeCanvasId) {
    throw new Error("Project has no task canvas.");
  }
  return { activeCanvasId };
}

export async function writeActiveTaskCanvasSelection(
  projectRoot: PackageWorkspaceRef,
  activeCanvasId: string
): Promise<ActiveTaskCanvasSelection> {
  const projectWorkspace =
    typeof projectRoot === "string" ? await resolveProjectWorkspace(projectRoot) : projectRoot;
  return writeActiveTaskCanvasSelectionForWorkspace(projectWorkspace, activeCanvasId);
}

export async function writeActiveTaskCanvasSelectionForWorkspace(
  workspace: ProjectWorkspace,
  activeCanvasId: string
): Promise<ActiveTaskCanvasSelection> {
  return withProjectMutationLock(
    join(workspace.planweaveHome, "projects", workspace.id),
    async () => {
      await assertCurrentProjectWorkspace(workspace);
      const loaded = await loadProjectGraphForWorkspace(workspace);
      const projectWorkspace = loaded.workspace;
      if (loaded.source === "project_graph") {
        if (!loaded.manifest.canvases.some((canvas) => canvas.id === activeCanvasId)) {
          throw new Error(`Project canvas '${activeCanvasId}' does not exist.`);
        }
        const path = activeCanvasPath(projectWorkspace);
        await mkdir(dirname(path), { recursive: true });
        await writeJsonFile(path, { version: activeCanvasVersion, activeCanvasId });
        return { activeCanvasId };
      }
      const registry = await readLegacyRegistry(projectWorkspace);
      if (!registry || !registry.canvases.some((canvas) => canvas.canvasId === activeCanvasId)) {
        throw new Error(`Task canvas '${activeCanvasId}' does not exist.`);
      }
      const path = registryPath(projectWorkspace);
      await mkdir(dirname(path), { recursive: true });
      await writeJsonFile(path, { ...registry, version: registryVersion, activeCanvasId });
      return { activeCanvasId };
    },
    { operation: `select-canvas:${activeCanvasId}` }
  );
}
