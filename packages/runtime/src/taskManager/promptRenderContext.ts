import { resolve } from "node:path";
import {
  loadPlanGraphPackage,
  type LoadedPlanGraphPackage
} from "../plangraph/packageRepository.js";
import {
  loadProjectCanvasRuntimeAggregation,
  runtimeSnapshotFromGraphState
} from "../projectGraph/runtimeAggregation.js";
import { canvasCommandFlagForLoadedProjectGraph } from "./canvasCommandScope.js";
import { buildExecutionStatus, type ExecutionStatus } from "./executionStatus.js";
import {
  renderProjectCanvasContextFromSnapshot,
  type ProjectCanvasContext
} from "./projectCanvasContext.js";
import { createProjectGraphClaimGuardFromAggregation } from "./projectGraphClaimGuard.js";
import { createPromptSourceReader, type PromptSourceReader } from "./promptSourceReader.js";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import { createExecutionGraphSessionFromSnapshot } from "../graph/session.js";
import type { PackageFileSnapshot, PackageWorkspaceRef } from "../types.js";
import { loadRuntimeReadonly, type RuntimeContext, type RuntimeOptions } from "./runtimeContext.js";

export interface PromptRenderContext {
  runtime: RuntimeContext;
  status: ExecutionStatus;
  planGraphPackage: LoadedPlanGraphPackage;
  promptSourceReader: PromptSourceReader;
  projectCanvasContextRenderer: (taskId: string) => ProjectCanvasContext;
  canvasCommandFlag: string;
  packagePromptSnapshotMode: "frozen" | "refresh-missing";
}

export async function createPromptRenderContext(
  options: RuntimeOptions,
  packageSnapshot?: PackageFileSnapshot
): Promise<PromptRenderContext> {
  const runtime = await loadRuntimeReadonly(options);
  const { workspace, manifest, graph, state } = runtime;
  const packageDir = resolve(workspace.packageDir);
  const projectAggregation = await loadProjectCanvasRuntimeAggregation(workspace, {
    runtimeSnapshotsByPackageDir: new Map([
      [packageDir, runtimeSnapshotFromGraphState(graph, state)]
    ]),
    packageSnapshotsByPackageDir: new Map([[packageDir, { manifest, graph }]])
  });
  const claimGuard = createProjectGraphClaimGuardFromAggregation(runtime, projectAggregation);
  const [status, planGraphPackage] = await Promise.all([
    buildExecutionStatus(runtime, { claimGuard }),
    loadPlanGraphPackage(workspace, {
      snapshot: {
        workspace,
        manifest,
        compiledGraph: graph,
        promptMarkdownByPath:
          packageSnapshot?.promptMarkdown ?? options.executionSnapshot?.promptMarkdownByPath,
        promptDiagnosticsByPath: packageSnapshot?.promptReadFailures
      }
    })
  ]);
  return {
    runtime,
    status,
    planGraphPackage,
    promptSourceReader: createPromptSourceReader(workspace),
    projectCanvasContextRenderer: (taskId) =>
      renderProjectCanvasContextFromSnapshot(runtime, projectAggregation, taskId),
    canvasCommandFlag: canvasCommandFlagForLoadedProjectGraph(workspace, projectAggregation.loaded),
    packagePromptSnapshotMode:
      options.executionSnapshot || packageSnapshot ? "frozen" : "refresh-missing"
  };
}

export async function createPromptRenderContextForPackageSnapshot(
  projectRoot: PackageWorkspaceRef,
  snapshot: PackageFileSnapshot
): Promise<PromptRenderContext> {
  const workspace = await resolvePackageWorkspace(projectRoot);
  return createPromptRenderContext(
    {
      projectRoot: workspace,
      session: createExecutionGraphSessionFromSnapshot({ projectRoot, workspace, snapshot })
    },
    snapshot
  );
}
