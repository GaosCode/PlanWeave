import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolvePlanweaveHome } from "../paths.js";
import { resolveProjectWorkspaceInHome } from "../project.js";
import { executePlanGraphCommand } from "../plangraph/index.js";
import { readActiveTaskCanvasSelectionForWorkspace } from "./canvasSelectionStore.js";
import { desktopLayoutCommandStore } from "./layoutStore.js";
import type { ProjectWorkspace } from "../types.js";
import { resolveSelectedCanvasWorkspaceForProject } from "./projectCanvasStore.js";

const selectionQueues = new Map<string, Promise<void>>();

function graphCommandError(result: Awaited<ReturnType<typeof executePlanGraphCommand>>): Error {
  return new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
}

export function selectTaskCanvas(projectRoot: string, canvasId: string): Promise<string> {
  const home = resolvePlanweaveHome();
  const root = resolve(projectRoot);
  let key: string;
  try {
    // Identity must be known before an asynchronous resolution can reorder intent admission.
    key = `${realpathSync.native(home)}\0${realpathSync.native(root)}`;
  } catch (caught) {
    return Promise.reject(caught);
  }
  const previous = selectionQueues.get(key) ?? Promise.resolve();
  const operation = previous.then(async () => {
    const projectWorkspace = await resolveProjectWorkspaceInHome(root, home);
    return selectTaskCanvasForWorkspace(projectWorkspace, canvasId);
  });
  const tail = operation.then(
    () => undefined,
    () => undefined
  );
  selectionQueues.set(key, tail);
  void tail.then(() => {
    if (selectionQueues.get(key) === tail) selectionQueues.delete(key);
  });
  return operation;
}

/** Execute selection inside an existing project lane without waiting on outer intent admission. */
export async function selectTaskCanvasForWorkspace(
  projectWorkspace: ProjectWorkspace,
  canvasId: string
): Promise<string> {
  const commandWorkspace = await resolveSelectedCanvasWorkspaceForProject(projectWorkspace);
  const result = await executePlanGraphCommand({
    projectRoot: commandWorkspace,
    indexPath: join(projectWorkspace.workspaceRoot, "cache", "plangraph.sqlite"),
    command: {
      type: "updateLayout",
      layoutScope: "canvas",
      layout: { activeCanvasId: canvasId }
    },
    dependencies: { layoutStore: desktopLayoutCommandStore }
  });
  if (!result.ok) throw graphCommandError(result);
  return (await readActiveTaskCanvasSelectionForWorkspace(projectWorkspace)).activeCanvasId;
}
