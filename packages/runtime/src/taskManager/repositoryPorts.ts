import type { ProjectWorkspace, RuntimeState } from "../types.js";

export interface RuntimeStateRepository {
  loadState(workspace: ProjectWorkspace): Promise<RuntimeState>;
  saveState(workspace: ProjectWorkspace, state: RuntimeState): Promise<void>;
}
