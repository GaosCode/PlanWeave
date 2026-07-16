import { withProjectMutationLock } from "../fs/withProjectMutationLock.js";
import { loadProjectGraph } from "./loadProjectGraph.js";
import { projectGraphPath, writeProjectGraph } from "./loadProjectGraph.js";
import { PlanWeaveWorkspaceNotInitializedError } from "../errors.js";
import { requireInitializedProjectWorkspace } from "../project.js";
import { detectDefaultCanvasWorkspaceMigration } from "./defaultCanvasWorkspaceMigration.js";
import type { ProjectGraphSource } from "./types.js";

export type MaterializeProjectGraphResult = {
  path: string;
  created: boolean;
  source: ProjectGraphSource;
  canvasCount: number;
};

async function requireMaterializeProjectWorkspace(projectRoot: string) {
  try {
    return await requireInitializedProjectWorkspace(projectRoot);
  } catch (error) {
    if (error instanceof PlanWeaveWorkspaceNotInitializedError) {
      throw new Error(
        `PlanWeave workspace has not been initialized. Run 'planweave init --project-graph --json' first.`
      );
    }
    throw error;
  }
}

/**
 * Materialize under an already-held project mutation lock (or any caller that
 * serializes project graph writes). Loads the authoritative source and writes
 * `project-graph.json` when missing. Re-exported load/write stay free of lock
 * ownership so this primitive can reenter from create/duplicate.
 */
export async function materializeProjectGraphUnlocked(
  projectRoot: string
): Promise<MaterializeProjectGraphResult> {
  const workspace = await requireMaterializeProjectWorkspace(projectRoot);
  const loaded = await loadProjectGraph(projectRoot);
  const path = projectGraphPath(loaded.workspace);
  if (loaded.source === "project_graph") {
    return {
      path,
      created: false,
      source: loaded.source,
      canvasCount: loaded.manifest.canvases.length
    };
  }
  const migrationPlan = await detectDefaultCanvasWorkspaceMigration(workspace);
  if (migrationPlan.action !== "none") {
    throw new Error(
      `Default canvas root workspace must be migrated before materializing project-graph.json. Run 'planweave project-graph migrate --json'. ${migrationPlan.reason}`
    );
  }
  await writeProjectGraph(loaded.workspace, loaded.manifest);
  return {
    path,
    created: true,
    source: loaded.source,
    canvasCount: loaded.manifest.canvases.length
  };
}

/**
 * Public materialize entry: same project mutation lock as create/duplicate so a
 * stale first-write cannot race past a concurrent canvas mutation and overwrite
 * a fresher graph.
 *
 * Nested calls from `createProjectCanvas` / `duplicateProjectCanvas` reenter via
 * the advisory lock AsyncLocalStorage without double-locking.
 */
export async function materializeProjectGraph(
  projectRoot: string
): Promise<MaterializeProjectGraphResult> {
  const workspace = await requireMaterializeProjectWorkspace(projectRoot);
  return withProjectMutationLock(
    workspace.workspaceRoot,
    () => materializeProjectGraphUnlocked(projectRoot),
    { operation: "materialize-project-graph" }
  );
}
