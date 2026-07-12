import { readState, writeState } from "../state.js";
import type { ProjectWorkspace, RuntimeState } from "../types.js";
import type { RuntimeStateRepository } from "./repositoryPorts.js";

export const fileRuntimeStateRepository: RuntimeStateRepository = {
  async loadState(workspace: ProjectWorkspace): Promise<RuntimeState> {
    return readState(workspace.stateFile);
  },

  async saveState(workspace: ProjectWorkspace, state: RuntimeState): Promise<void> {
    await writeState(workspace.stateFile, state);
  }
};
