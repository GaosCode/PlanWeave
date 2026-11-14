import { resolveResultsPath } from "../taskManager/resultPaths.js";
import { withExecutionStateLock } from "../taskManager/executionStateBoundary.js";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { loadPackage } from "../package/loadPackage.js";
import type { AgentExecutorProfile, PackageWorkspaceRef, ProjectWorkspace } from "../types.js";
import {
  allocateRunId,
  findAvailableRunId,
  prepareBlockRun,
  workspaceExecutionCwd,
  type BlockClaim
} from "./executorShared.js";
import { withPreparedBlockRunIndex } from "./blockRunIndex.js";
import { writeJsonFile } from "../json.js";
import type { ExecutionWaveId } from "./runnerContractSchemas.js";

export type PreparedAcpRun = {
  runId: string;
  runDir: string;
  metadataPath: string;
  cwd: string;
  startedAt?: string;
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
  const { workspace } = input.executionSnapshot ?? (await loadPackage(input.projectRoot));
  if (input.claim.blockType === "implementation") {
    const run = await prepareBlockRun({ ...input, projectRoot: workspace, adapter: "agent" });
    if (!run.executionAdmittedAt)
      throw new Error("ACP implementation preparation has no execution admission.");
    return {
      runId: run.runId,
      runDir: run.runDir,
      metadataPath: run.metadataPath,
      startedAt: run.startedAt,
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
  return withExecutionStateLock(input, workspace, async () => {
    const runRoot = await resolveResultsPath(
      workspace.resultsDir,
      taskId,
      "blocks",
      blockId,
      "runs"
    );
    return withPreparedBlockRunIndex(runRoot, async (prepareIndex) => {
      const runId = await findAvailableRunId(runRoot);
      const runDir = join(runRoot, runId);
      const startedAt = new Date().toISOString();
      const publishIndex = await prepareIndex(runId, {
        metadata: { ref: input.claim.ref, startedAt }
      });
      await mkdir(runDir, { recursive: false });
      const prepared = await prepare(runDir, runId, workspace, input.prompt);
      await writeJsonFile(prepared.metadataPath, {
        ref: input.claim.ref,
        taskId,
        blockId,
        runId,
        startedAt
      });
      await publishIndex();
      return { ...prepared, startedAt };
    });
  });
}

export async function prepareAcpFeedbackRun(input: {
  workspace: ProjectWorkspace;
  prompt: string;
}): Promise<PreparedAcpRun> {
  const runRoot = await resolveResultsPath(input.workspace.resultsDir, "feedback-runs");
  const runId = await allocateRunId(runRoot);
  return prepare(join(runRoot, runId), runId, input.workspace, input.prompt);
}

async function prepare(
  runDir: string,
  runId: string,
  workspace: ProjectWorkspace,
  prompt: string
): Promise<PreparedAcpRun> {
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
