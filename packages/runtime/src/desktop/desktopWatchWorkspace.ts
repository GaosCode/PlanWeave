import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { directRegisteredWorkspaceId, resolveProjectWorkspaceInHome } from "../project.js";
import type { ProjectWorkspace } from "../types.js";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import type { DesktopWatchRegistration } from "./types/desktopBridgeInputSchemas.js";

/** Resolve a watch against its registered Home instead of the process's current Home. */
export async function resolveDesktopWatchWorkspace(
  registration: DesktopWatchRegistration
): Promise<ProjectWorkspace> {
  const workspaceRoot = resolve(registration.workspaceRoot);
  const home = dirname(dirname(workspaceRoot));
  if (!(await directRegisteredWorkspaceId(home, workspaceRoot))) {
    throw new Error("Desktop watch workspace must be a registered project directory.");
  }
  const project = await resolveProjectWorkspaceInHome(registration.projectRoot, home);
  const registeredRoot = await realpath(workspaceRoot);
  if ((await realpath(project.workspaceRoot)) !== registeredRoot) {
    throw new Error("Desktop watch project does not match the registered workspace.");
  }
  return resolveTaskCanvasWorkspace(project, registration.canvasId);
}
