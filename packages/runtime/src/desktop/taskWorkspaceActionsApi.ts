import { executeTaskWorkspaceRetry } from "./taskWorkspaceRetry.js";
import { recoverTaskWorkspaceAcpRun as executeTaskWorkspaceAcpRecovery } from "./taskWorkspaceAcpRecovery.js";
import { reconcileOrphanedAcpRun } from "./acpOrphanReconciliation.js";
import { getTaskWorkspaceRunDetail } from "./taskWorkspaceApi.js";
import { parseRunRecordId } from "./runRecordIdentity.js";
import { basename, dirname } from "node:path";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import {
  taskWorkspaceAcpRecoveryIdentitySchema,
  type TaskWorkspaceAcpRecoveryIdentity,
  taskWorkspaceRetryIdentitySchema,
  type TaskWorkspaceRetryIdentity
} from "./types/taskWorkspaceTypes.js";
import { taskWorkspaceRunDetailInputSchema } from "./types/taskWorkspaceQueryTypes.js";

export function retryTaskWorkspaceRun(rawIdentity: TaskWorkspaceRetryIdentity) {
  return executeTaskWorkspaceRetry(taskWorkspaceRetryIdentitySchema.parse(rawIdentity));
}

export async function recoverTaskWorkspaceAcpRun(
  rawIdentity: TaskWorkspaceAcpRecoveryIdentity,
  audit: { source: string; reason: string }
) {
  const identity = taskWorkspaceAcpRecoveryIdentitySchema.parse(rawIdentity);
  const state = await executeTaskWorkspaceAcpRecovery(identity, audit);
  const detail = await getTaskWorkspaceRunDetail(
    taskWorkspaceRunDetailInputSchema.parse({
      projectRoot: identity.projectRoot,
      canvasId: identity.canvasId,
      taskId: identity.taskId,
      recordId: identity.recordId
    }),
    { selectedRecordId: identity.recordId }
  );
  return { state, detail, nextActions: detail.item.run.nextActions };
}

export async function recoverAcpRunByRecord(
  input: { projectRoot: string; canvasId: string | null; recordId: string },
  audit: { source: string; reason: string }
) {
  const parsed = parseRunRecordId(input.recordId);
  if (parsed.kind !== "block") {
    throw new Error("ACP recovery requires a persisted Block run record.");
  }
  const taskId = parsed.blockRef.split("#")[0];
  if (!taskId) throw new Error("ACP recovery record has no task identity.");
  const workspace = await resolveTaskCanvasWorkspace(input.projectRoot, input.canvasId);
  const canvasId = basename(dirname(workspace.packageDir));
  await reconcileOrphanedAcpRun({
    projectRoot: workspace.rootPath,
    canvasId,
    recordId: input.recordId
  });
  const detail = await getTaskWorkspaceRunDetail(
    taskWorkspaceRunDetailInputSchema.parse({
      projectRoot: workspace.rootPath,
      canvasId,
      taskId,
      recordId: input.recordId
    }),
    { selectedRecordId: input.recordId }
  );
  const capability = detail.item.run.capabilities.recoverAcpSession;
  if (!capability.available || capability.identity === null) {
    throw new Error(capability.reason?.message ?? "ACP recovery is unavailable.");
  }
  return recoverTaskWorkspaceAcpRun(capability.identity, audit);
}
