import { join } from "node:path";
import {
  createCodexExecAdapter,
  createLocalReviewAdapter,
  createOpencodeExecAdapter,
  getAutoRunStatus,
  resolveTaskCanvasWorkspace,
  runAutoRunStep
} from "../index.js";
import { writeJsonFile } from "../json.js";
import { canonicalProjectCanvasNode, writeProjectGraph } from "../projectGraph/index.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

export type AutoRunStepOptions = Parameters<typeof runAutoRunStep>[0];

export function runContractAutoRunStep(options: AutoRunStepOptions) {
  return runAutoRunStep({ tmuxEnabled: false, ...options });
}

export function createContractCodexExecAdapter(options: Parameters<typeof createCodexExecAdapter>[0]) {
  return createCodexExecAdapter({ ...options, runtime: { ...options.runtime, tmuxEnabled: false } });
}

export function createContractOpencodeExecAdapter(options: Parameters<typeof createOpencodeExecAdapter>[0]) {
  return createOpencodeExecAdapter({ ...options, runtime: { ...options.runtime, tmuxEnabled: false } });
}

export function createContractLocalReviewAdapter(options: Parameters<typeof createLocalReviewAdapter>[0]) {
  return createLocalReviewAdapter({ ...options, runtime: { ...options.runtime, tmuxEnabled: false } });
}

export async function waitForAutoRunStatus(
  projectRoot: string,
  predicate: (status: Awaited<ReturnType<typeof getAutoRunStatus>>) => boolean
): Promise<Awaited<ReturnType<typeof getAutoRunStatus>>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = await getAutoRunStatus({ projectRoot });
    if (predicate(status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return getAutoRunStatus({ projectRoot });
}

export async function createFormalManualCanvasWorkspace() {
  const { root, init } = await createTestWorkspace();
  const packageDir = join(init.workspace.workspaceRoot, "manual-canvas", "package");
  const manifest = basicManifest();
  await writeJsonFile(join(packageDir, "manifest.json"), manifest);
  await writePromptFiles(packageDir, manifest);
  await writeProjectGraph(init.workspace, {
    version: "plan-project/v1",
    canvases: [
      canonicalProjectCanvasNode({ id: "default", title: "Runtime" }),
      {
        id: "manual-canvas",
        type: "canvas",
        title: "Manual Canvas",
        packageDir: "manual-canvas/package",
        stateFile: "manual-canvas/state.json",
        resultsDir: "manual-canvas/results"
      }
    ],
    edges: [],
    crossTaskEdges: []
  });
  return { root, workspace: await resolveTaskCanvasWorkspace(root, "manual-canvas") };
}
