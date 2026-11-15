import { dirname, relative } from "node:path";
import type { ProjectWorkspace } from "../types.js";
import type { DesktopAutoRunActivityEvent, DesktopAutoRunActivityScope } from "./types.js";

const listeners = new Set<(event: DesktopAutoRunActivityEvent) => void>();

export function autoRunActivityScope(workspace: ProjectWorkspace): DesktopAutoRunActivityScope {
  return {
    projectId: workspace.id,
    canvasKey: relative(dirname(workspace.projectFile), workspace.stateFile)
  };
}

export function subscribeAutoRunActivityEvents(
  listener: (event: DesktopAutoRunActivityEvent) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishAutoRunActivityChange(workspace: ProjectWorkspace): void {
  const event = { scope: autoRunActivityScope(workspace), planweaveHome: workspace.planweaveHome };
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error("Auto Run activity listener failed.", error);
    }
  }
}
