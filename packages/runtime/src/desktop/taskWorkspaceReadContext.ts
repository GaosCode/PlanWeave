import { resolve } from "node:path";
import { createExecutionGraphSession } from "../graph/session.js";
import {
  loadPlanGraphPackage,
  type LoadedPlanGraphPackage
} from "../plangraph/packageRepository.js";
import {
  loadProjectCanvasRuntimeAggregation,
  runtimeSnapshotFromGraphState
} from "../projectGraph/runtimeAggregation.js";
import {
  createPromptSourceReader,
  type PromptSourceReader
} from "../taskManager/promptSourceReader.js";
import { canvasCommandFlagForLoadedProjectGraph } from "../taskManager/canvasCommandScope.js";
import { buildExecutionStatus, type ExecutionStatus } from "../taskManager/executionStatus.js";
import {
  createProjectGraphClaimGuardFromAggregation,
  type ProjectGraphClaimGuard
} from "../taskManager/projectGraphClaimGuard.js";
import { loadRuntimeReadonly, type RuntimeContext } from "../taskManager/runtimeContext.js";
import {
  renderProjectCanvasContextFromSnapshot,
  type ProjectCanvasContext
} from "../taskManager/projectCanvasContext.js";
import type { ExecutionGraphSession, PackageWorkspaceRef } from "../types.js";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";

interface TaskWorkspaceReadContext {
  runtime: RuntimeContext;
  status: ExecutionStatus;
  planGraphPackage: LoadedPlanGraphPackage;
  claimGuard: ProjectGraphClaimGuard;
  promptSourceReader: PromptSourceReader;
  projectCanvasContextRenderer: (taskId: string) => ProjectCanvasContext;
  canvasCommandFlag: string;
  packagePromptSnapshotMode: "frozen";
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
  const projectAggregation = await loadProjectCanvasRuntimeAggregation(workspace, {
    runtimeSnapshotsByPackageDir: new Map([
      [resolve(workspace.packageDir), runtimeSnapshotFromGraphState(runtime.graph, runtime.state)]
    ]),
    packageSnapshotsByPackageDir: new Map([
      [resolve(workspace.packageDir), { manifest: runtime.manifest, graph: runtime.graph }]
    ])
  });
  const claimGuard = createProjectGraphClaimGuardFromAggregation(runtime, projectAggregation);
  const status = await buildExecutionStatus(runtime, { claimGuard });
  const planGraphPackage = await loadPlanGraphPackage(workspace, {
    snapshot: {
      workspace,
      manifest: runtime.manifest,
      compiledGraph: runtime.graph
    }
  });
  for (const failure of planGraphPackage.promptReadFailuresByPath.values()) {
    if (failure.kind === "read_error") {
      throw failure.error;
    }
  }
  const promptSourceReader = createPromptSourceReader(workspace);
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
    projectCanvasContextRenderer: (taskId) =>
      renderProjectCanvasContextFromSnapshot(runtime, projectAggregation, taskId),
    canvasCommandFlag: canvasCommandFlagForLoadedProjectGraph(workspace, projectAggregation.loaded),
    packagePromptSnapshotMode: "frozen"
  };
}

export { createTaskWorkspaceReadContext };
export type { TaskWorkspaceReadContext };
