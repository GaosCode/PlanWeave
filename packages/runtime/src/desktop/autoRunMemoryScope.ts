import { resolve } from "node:path";
import type { ProjectWorkspace } from "../types.js";
import { isNonTerminalAutoRunPhase } from "./autoRunPhasePolicy.js";
import type { DesktopAutoRunState } from "./types.js";

/** In-process ownership is bound to the workspace captured when the run was admitted. */
export function autoRunMemoryScope(
  workspace: ProjectWorkspace,
  memory: {
    runs: Map<string, DesktopAutoRunState>;
    workspaces: ReadonlyMap<string, ProjectWorkspace>;
    activeLoops: ReadonlySet<string>;
    hasPendingOperation: (runId: string) => boolean;
  }
) {
  const matches = (runId: string): boolean => {
    const owner = memory.workspaces.get(runId);
    return (
      owner !== undefined &&
      resolve(owner.planweaveHome) === resolve(workspace.planweaveHome) &&
      resolve(owner.projectFile) === resolve(workspace.projectFile) &&
      resolve(owner.stateFile) === resolve(workspace.stateFile) &&
      resolve(owner.resultsDir) === resolve(workspace.resultsDir)
    );
  };
  const isReserved = (runId: string): boolean => {
    const existing = memory.runs.get(runId);
    return (
      memory.activeLoops.has(runId) ||
      memory.hasPendingOperation(runId) ||
      (existing !== undefined && isNonTerminalAutoRunPhase(existing.phase))
    );
  };
  return {
    isReserved,
    get: (runId: string): DesktopAutoRunState | null =>
      matches(runId) ? (memory.runs.get(runId) ?? null) : null,
    values: (): DesktopAutoRunState[] =>
      [...memory.runs.values()].filter((state) => matches(state.runId)),
    hasActiveLoop: (runId: string): boolean => matches(runId) && memory.activeLoops.has(runId),
    updateRecovered: (state: DesktopAutoRunState): void => {
      if (matches(state.runId) && memory.runs.has(state.runId)) {
        memory.runs.set(state.runId, state);
      }
    },
    assertCanAdopt: (state: DesktopAutoRunState, initializing = false): void => {
      if ((!initializing && matches(state.runId)) || !isReserved(state.runId)) {
        return;
      }
      const existing = memory.runs.get(state.runId) ?? state;
      const owner = matches(state.runId) ? "this workspace" : "another workspace";
      throw new Error(
        `Auto Run '${state.runId}' already belongs to project '${existing.projectRoot}' canvas '${existing.canvasId ?? "default"}' in ${owner}. Stop its existing run before recovering this workspace's run.`
      );
    }
  };
}
