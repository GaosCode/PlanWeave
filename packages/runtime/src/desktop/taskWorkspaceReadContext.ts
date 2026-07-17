import { createExecutionGraphSession } from "../graph/session.js";
import {
  loadPlanGraphPackage,
  type LoadedPlanGraphPackage
} from "../plangraph/packageRepository.js";
import { buildExecutionStatus, type ExecutionStatus } from "../taskManager/executionStatus.js";
import {
  createProjectGraphClaimGuard,
  type ProjectGraphClaimGuard
} from "../taskManager/projectGraphClaimGuard.js";
import { loadRuntimeReadonly, type RuntimeContext } from "../taskManager/runtimeContext.js";
import type { ExecutionGraphSession } from "../types.js";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import {
  createTaskWorkspacePromptSourceReader,
  type TaskWorkspacePromptSourceReader
} from "./taskWorkspacePromptSourceReader.js";

interface TaskWorkspaceReadContext {
  runtime: RuntimeContext;
  status: ExecutionStatus;
  planGraphPackage: LoadedPlanGraphPackage;
  claimGuard: ProjectGraphClaimGuard;
  promptSourceReader: TaskWorkspacePromptSourceReader;
}

async function createTaskWorkspaceReadContext(options: {
  projectRoot: string;
  canvasId?: string | null;
  session?: ExecutionGraphSession;
}): Promise<TaskWorkspaceReadContext> {
  const workspace = await resolveTaskCanvasWorkspace(options.projectRoot, options.canvasId);
  const session = options.session ?? (await createExecutionGraphSession(workspace));
  const runtime = await loadRuntimeReadonly({ projectRoot: workspace, session });
  const claimGuard = await createProjectGraphClaimGuard(runtime);
  const status = await buildExecutionStatus(runtime, { claimGuard });
  const planGraphPackage = await loadPlanGraphPackage(workspace);

  return {
    runtime,
    status,
    planGraphPackage,
    claimGuard,
    promptSourceReader: createTaskWorkspacePromptSourceReader(workspace)
  };
}

export { createTaskWorkspaceReadContext };
export type { TaskWorkspaceReadContext };
