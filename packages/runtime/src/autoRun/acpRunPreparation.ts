import { writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { loadPackage } from "../package/loadPackage.js";
import type { PackageWorkspaceRef, ProjectWorkspace } from "../types.js";
import { allocateRunId, workspaceExecutionCwd } from "./executorShared.js";

export type PreparedAcpRun = {
  runId: string;
  runDir: string;
  metadataPath: string;
  cwd: string;
  projectId: string;
  canvasId: string;
};

export async function prepareAcpBlockRun(input: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  prompt: string;
}): Promise<PreparedAcpRun> {
  const { workspace } = await loadPackage(input.projectRoot);
  const { taskId, blockId } = parseBlockRef(input.ref);
  return prepare(
    join(workspace.resultsDir, taskId, "blocks", blockId, "runs"),
    workspace,
    input.prompt
  );
}

export function prepareAcpFeedbackRun(input: {
  workspace: ProjectWorkspace;
  prompt: string;
}): Promise<PreparedAcpRun> {
  return prepare(join(input.workspace.resultsDir, "feedback-runs"), input.workspace, input.prompt);
}

async function prepare(
  runRoot: string,
  workspace: ProjectWorkspace,
  prompt: string,
): Promise<PreparedAcpRun> {
  const runId = await allocateRunId(runRoot);
  const runDir = join(runRoot, runId);
  await writeFile(join(runDir, "prompt.md"), prompt, "utf8");
  return {
    runId,
    runDir,
    metadataPath: join(runDir, "metadata.json"),
    cwd: workspaceExecutionCwd(workspace),
    projectId: workspace.id,
    canvasId: basename(dirname(workspace.packageDir))
  };
}
