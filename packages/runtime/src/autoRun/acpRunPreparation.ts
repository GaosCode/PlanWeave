import { withExecutionStateLock } from "../taskManager/executionStateBoundary.js";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { loadPackage } from "../package/loadPackage.js";
import type { AgentExecutorProfile, PackageWorkspaceRef, ProjectWorkspace } from "../types.js";
import {
  allocateRunId,
  prepareBlockRun,
  workspaceExecutionCwd,
  type BlockClaim
} from "./executorShared.js";
import type { ExecutionWaveId } from "./runnerContractSchemas.js";

export type PreparedAcpRun = {
  runId: string;
  runDir: string;
  metadataPath: string;
  cwd: string;
  projectId: string;
  canvasId: string;
  implementationIdentity?: {
    adapter: "agent";
    submissionAttemptId?: string;
    executionAdmittedAt: string;
    preparedContentRevision?: string;
  };
};

export async function prepareAcpBlockRun(input: {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  executionSnapshot?: import("../package/packageExecutionSnapshot.js").PackageExecutionSnapshot;
  executorName: string;
  profile: AgentExecutorProfile;
  prompt: string;
  executionWaveId?: ExecutionWaveId;
}): Promise<PreparedAcpRun> {
  const { workspace } = await loadPackage(input.projectRoot);
  if (input.claim.blockType === "implementation") {
    const run = await prepareBlockRun({ ...input, adapter: "agent" });
    if (!run.executionAdmittedAt)
      throw new Error("ACP implementation preparation has no execution admission.");
    return {
      runId: run.runId,
      runDir: run.runDir,
      metadataPath: run.metadataPath,
      cwd: workspaceExecutionCwd(workspace),
      projectId: workspace.id,
      canvasId: basename(dirname(workspace.packageDir)),
      implementationIdentity: {
        adapter: "agent",
        executionAdmittedAt: run.executionAdmittedAt,
        ...(input.executionSnapshot
          ? { preparedContentRevision: input.executionSnapshot.contentRevision }
          : {}),
        ...(input.claim.submissionAttemptId
          ? { submissionAttemptId: input.claim.submissionAttemptId }
          : {})
      }
    };
  }
  const { taskId, blockId } = parseBlockRef(input.claim.ref);
  return withExecutionStateLock(input, dirname(workspace.stateFile), () =>
    prepare(join(workspace.resultsDir, taskId, "blocks", blockId, "runs"), workspace, input.prompt)
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
  prompt: string
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
