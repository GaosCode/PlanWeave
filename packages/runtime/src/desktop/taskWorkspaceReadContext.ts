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
import {
  createCanvasCommandFlagReader,
  createProjectCanvasContextReader
} from "../taskManager/promptRenderer.js";
import type { ExecutionGraphSession, PackageWorkspaceRef } from "../types.js";
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
  projectCanvasContextReader: ReturnType<typeof createProjectCanvasContextReader>;
  canvasCommandFlagReader: ReturnType<typeof createCanvasCommandFlagReader>;
}

async function createTaskWorkspaceReadContext(options: {
  projectRoot: PackageWorkspaceRef;
  canvasId?: string | null;
  session?: ExecutionGraphSession;
}): Promise<TaskWorkspaceReadContext> {
  let workspace = options.projectRoot;
  if (typeof workspace === "string") {
    workspace = await resolveTaskCanvasWorkspace(workspace, options.canvasId);
  }
  const session = options.session ?? (await createExecutionGraphSession(workspace));
  const runtime = await loadRuntimeReadonly({ projectRoot: workspace, session });
  const claimGuard = await createProjectGraphClaimGuard(runtime);
  const status = await buildExecutionStatus(runtime, { claimGuard });
  const planGraphPackage = await loadPlanGraphPackage(workspace);
  const promptSourceReader = createTaskWorkspacePromptSourceReader(workspace);
  const promptPolicy = await promptSourceReader.readProjectPromptPolicy();
  await Promise.all([
    promptSourceReader.readProjectPrompt(),
    promptPolicy.includeGlobalPrompt ? promptSourceReader.readGlobalPrompt() : Promise.resolve()
  ]);

  return {
    runtime,
    status,
    planGraphPackage,
    claimGuard,
    promptSourceReader,
    projectCanvasContextReader: createProjectCanvasContextReader(runtime),
    canvasCommandFlagReader: createCanvasCommandFlagReader(workspace)
  };
}

export { createTaskWorkspaceReadContext };
export type { TaskWorkspaceReadContext };
