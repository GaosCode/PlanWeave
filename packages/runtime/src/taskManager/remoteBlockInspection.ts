import type { PackageWorkspaceRef } from "../types.js";
import { commandCanvasIdForWorkspace } from "./canvasCommandScope.js";
import { projectBlockerReason } from "./claimReadinessRules.js";
import { createProjectGraphClaimGuard } from "./projectGraphClaimGuard.js";
import {
  remoteBlockDispatchCandidateSchema,
  RemoteBlockRuntimeError,
  type RemoteBlockDispatchCandidate
} from "./remoteBlockRuntimeContracts.js";
import { sameRemoteBlockSource } from "./remoteBlockSource.js";
import {
  assertRemoteBlockSnapshotDependencies,
  remoteBlockSourceSnapshot
} from "./remoteBlockSourceSnapshot.js";
import { loadRuntimeReadonly, type RuntimeContext } from "./runtimeContext.js";
import { remoteBlockDispatchReadiness } from "./remoteBlockDispatchReadiness.js";
import type { BlockType } from "../types.js";
import { effectiveBlockExecutor, validateClaimScope } from "./selectors.js";

/**
 * Remote Host ACP can execute every auto-run block type in the package model
 * (implementation + review). Returns the resolved block type.
 */
export function assertRemoteBlockExecutable(
  context: RuntimeContext,
  ref: string
): Extract<BlockType, "implementation" | "review"> {
  const invalidScope = validateClaimScope({ kind: "block", blockRef: ref }, context.graph);
  if (invalidScope) {
    const reason = "reason" in invalidScope ? invalidScope.reason : undefined;
    throw new RemoteBlockRuntimeError(
      "remote_block_not_found",
      reason ?? `Block '${ref}' does not exist.`
    );
  }
  const blockType = context.graph.blocksByRef.get(ref)?.type;
  if (blockType !== "implementation" && blockType !== "review") {
    throw new RemoteBlockRuntimeError(
      "remote_block_not_executable",
      `Remote dispatch supports implementation and review blocks; '${ref}' is not executable remotely.`
    );
  }
  return blockType;
}

/** @deprecated Use assertRemoteBlockExecutable. */
export function assertRemoteBlockImplementation(context: RuntimeContext, ref: string): void {
  assertRemoteBlockExecutable(context, ref);
}

export async function assertRemoteBlockDispatchable(
  context: RuntimeContext,
  ref: string
): Promise<void> {
  assertRemoteBlockExecutable(context, ref);
  const taskId = context.graph.blockTaskByRef.get(ref);
  const blocker = projectBlockerReason(await createProjectGraphClaimGuard(context), taskId);
  if (blocker) {
    throw new RemoteBlockRuntimeError("remote_block_not_dispatchable", blocker);
  }
  const readiness = remoteBlockDispatchReadiness({
    graph: context.graph,
    manifest: context.manifest,
    state: context.state,
    ref
  });
  if (!readiness.dispatchable) {
    throw new RemoteBlockRuntimeError("remote_block_not_dispatchable", readiness.reason);
  }
}

export async function inspectRemoteBlockCandidate(
  projectRoot: PackageWorkspaceRef,
  ref: string
): Promise<RemoteBlockDispatchCandidate> {
  const context = await loadRuntimeReadonly({ projectRoot });
  await assertRemoteBlockDispatchable(context, ref);
  const sourceBefore = await remoteBlockSourceSnapshot(context, ref);
  assertRemoteBlockSnapshotDependencies(sourceBefore, ref);
  const afterContext = await loadRuntimeReadonly({ projectRoot: context.workspace });
  const sourceAfter = await remoteBlockSourceSnapshot(afterContext, ref);
  if (!sameRemoteBlockSource(sourceBefore, sourceAfter)) {
    throw new RemoteBlockRuntimeError(
      "remote_block_source_changed",
      `Remote source changed while inspecting '${ref}'; inspect again.`
    );
  }
  const blockType = assertRemoteBlockExecutable(context, ref);
  const taskId = context.graph.blockTaskByRef.get(ref)!;
  const task = context.graph.tasksById.get(taskId)!;
  const effectiveExecutor = effectiveBlockExecutor(
    context.graph,
    ref,
    context.manifest.execution.defaultExecutor
  );
  const { executorRunnerEvidenceForManifest } = await import("../autoRun/executors.js");
  const runner = executorRunnerEvidenceForManifest(context.manifest, effectiveExecutor);
  if (runner.runnerKind !== "acp" || !runner.agentId) {
    throw new RemoteBlockRuntimeError(
      "remote_block_executor_not_acp",
      `Executor '${effectiveExecutor}' for '${ref}' is not an ACP agent profile.`
    );
  }
  return remoteBlockDispatchCandidateSchema.parse({
    projectId: context.workspace.id,
    canvasId: (await commandCanvasIdForWorkspace(context.workspace)) ?? "default",
    taskId,
    blockRef: ref,
    blockType,
    sourceRevision: sourceBefore.sourceRevision,
    graphFingerprint: sourceBefore.graphFingerprint,
    renderedPrompt: sourceBefore.renderedPrompt,
    acceptance: task.acceptance,
    dependencySummaries: sourceBefore.dependencySummaries,
    inputArtifacts: sourceBefore.inputArtifacts,
    workspaceId: context.workspace.id,
    effectiveExecutor,
    agentId: runner.agentId,
    agentProfileId: effectiveExecutor,
    session: {},
    requiredCapabilities: context.graph.requiredCapabilitiesByBlockRef.get(ref) ?? []
  });
}
