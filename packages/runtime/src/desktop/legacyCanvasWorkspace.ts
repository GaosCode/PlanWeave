import { dirname, isAbsolute, join } from "node:path";
import type { ProjectWorkspace } from "../types.js";
import type { TaskCanvasRecord } from "./canvasRegistry.js";

function fromWorkspaceRelative(workspace: ProjectWorkspace, path: string): string {
  return isAbsolute(path) ? path : join(workspace.workspaceRoot, path);
}

export function legacyCanvasWorkspace(
  projectWorkspace: ProjectWorkspace,
  record: TaskCanvasRecord
): ProjectWorkspace {
  const packageDir = fromWorkspaceRelative(projectWorkspace, record.packageDir);
  const stateFile = fromWorkspaceRelative(projectWorkspace, record.stateFile);
  const resultsDir = fromWorkspaceRelative(projectWorkspace, record.resultsDir);
  const workspaceRoot =
    record.canvasId === "default" ? projectWorkspace.workspaceRoot : dirname(packageDir);
  return {
    ...projectWorkspace,
    packageStorageIdentity: null,
    resultsStorageIdentity: null,
    workspaceRoot,
    packageDir,
    manifestFile: join(packageDir, "manifest.json"),
    stateFile,
    resultsDir
  };
}
