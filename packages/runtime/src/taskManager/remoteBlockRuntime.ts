import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveResultsPath } from "./resultPaths.js";
import { findAvailableRunId } from "../autoRun/executorShared.js";
import { withPreparedBlockRunIndex } from "../autoRun/blockRunIndex.js";
import { withExecutionStateLock } from "./executionStateBoundary.js";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { loadPackage } from "../package/loadPackage.js";
import { writeState } from "../state.js";
import type { PackageWorkspaceRef } from "../types.js";
import { submitRemoteBlockResult } from "./blockSubmission.js";
import { applyCurrentReviewResumeClaim } from "./blockStatusMutations.js";
import { reviewClaimForm } from "./claimReadiness.js";
import { materializeRemoteAcpFailure } from "./remoteAcpTranscript.js";
import { updateTaskIndex } from "./resultIndex.js";
import {
  assertRemoteBlockDispatchable,
  assertRemoteBlockExecutable,
  inspectRemoteBlockCandidate
} from "./remoteBlockInspection.js";
import {
  activateRemoteBlockOwnership,
  assertActiveRemoteBlockOwnership,
  failRemoteBlockOwnership,
  interruptRemoteBlockOwnership,
  markRemoteBlockOwnershipSourceDrift,
  matchesRemoteOperationReceipt,
  prepareRemoteBlockOwnership,
  restoreStoppedRemoteBlock,
  resumeRemoteBlockOwnership,
  retryRemoteBlockOwnership,
  RemoteOwnershipConflictError,
  type ActiveRemoteOperationIdentity
} from "./remoteOwnershipTransitions.js";
import {
  remoteBlockActiveIdentitySchema,
  remoteBlockBindingViewSchema,
  remoteBlockClaimInputSchema,
  remoteBlockCompletionResultSchema,
  remoteBlockFailureInputSchema,
  remoteBlockInspectInputSchema,
  remoteBlockInterruptionInputSchema,
  remoteBlockMutationResultSchema,
  remoteBlockOperationQuerySchema,
  remoteBlockRefIdentitySchema,
  remoteBlockRetryAttemptInputSchema,
  RemoteBlockRuntimeError,
  type RemoteBlockBindingView,
  type RemoteBlockClaimInput,
  type RemoteBlockCompletionInput,
  type RemoteBlockCompletionResult,
  type RemoteBlockDispatchCandidate,
  type RemoteBlockFailureInput,
  type RemoteBlockInterruptionInput,
  type RemoteBlockInspectInput,
  type RemoteBlockMutationResult,
  type RemoteBlockOperationQuery,
  type RemoteBlockRefIdentity,
  type RemoteBlockRetryAttemptInput
} from "./remoteBlockRuntimeContracts.js";
import { remoteBlockSourceEvidence, sameRemoteBlockAuthority } from "./remoteBlockSource.js";
import {
  loadRuntime,
  loadRuntimeReadonly,
  refreshDerivedState,
  type RuntimeContext
} from "./runtimeContext.js";

function withCurrentRef(currentRefs: string[], ref: string): string[] {
  return currentRefs.includes(ref) ? currentRefs : [...currentRefs, ref];
}

/** Drop dangling current pointers after remote fail / interrupt / source-drift. */
function releaseCurrentBlockPointers(
  state: Pick<RuntimeContext["state"], "currentRefs" | "currentReviewBlockRef">,
  ref: string
): void {
  state.currentRefs = state.currentRefs.filter((current) => current !== ref);
  if (state.currentReviewBlockRef === ref) {
    state.currentReviewBlockRef = null;
  }
}

function bindingView(context: RuntimeContext, ref: string): RemoteBlockBindingView {
  const state = context.state.blocks[ref];
  if (!state) {
    throw new RemoteBlockRuntimeError("remote_block_not_found", `Block '${ref}' does not exist.`);
  }
  return remoteBlockBindingViewSchema.parse({
    ref,
    status: state.status,
    ...(state.remoteOwnership ? { ownership: state.remoteOwnership } : {}),
    ...(state.remoteInterruption ? { interruption: state.remoteInterruption } : {}),
    ...(state.remoteOperationReceipt ? { terminalReceipt: state.remoteOperationReceipt } : {}),
    ...(state.blockedReason !== undefined ? { blockedReason: state.blockedReason } : {}),
    ...(state.divergenceReason !== undefined ? { divergenceReason: state.divergenceReason } : {})
  });
}

function assertOperationMatchesView(view: RemoteBlockBindingView, operationId: string): void {
  const recordedOperationId = view.ownership?.operationId ?? view.terminalReceipt?.operationId;
  if (!recordedOperationId) {
    throw new RemoteOwnershipConflictError(
      "remote_ownership_not_active",
      `Block '${view.ref}' has no remote operation binding.`
    );
  }
  if (recordedOperationId !== operationId) {
    throw new RemoteOwnershipConflictError(
      "remote_ownership_operation_conflict",
      `Remote operation '${operationId}' conflicts with owner '${recordedOperationId}'.`
    );
  }
}

async function writeLockedState(context: RuntimeContext): Promise<void> {
  await writeState(
    context.workspace.stateFile,
    refreshDerivedState(context.manifest, context.state)
  );
}

function identityFromInput(input: {
  operationId: string;
  controlPlane?: "collaboration" | "owner";
  sourceRevision: string;
  graphFingerprint: string;
  dispatchId: string;
  executionAttemptId: string;
}): ActiveRemoteOperationIdentity {
  return remoteBlockActiveIdentitySchema.parse({
    operationId: input.operationId,
    ...(input.controlPlane ? { controlPlane: input.controlPlane } : {}),
    sourceRevision: input.sourceRevision,
    graphFingerprint: input.graphFingerprint,
    dispatchId: input.dispatchId,
    executionAttemptId: input.executionAttemptId
  });
}

function remoteExecutableBlockType(context: RuntimeContext, ref: string) {
  return assertRemoteBlockExecutable(context, ref);
}

export interface RemoteBlockRuntimePort {
  inspect(input: RemoteBlockInspectInput): Promise<RemoteBlockDispatchCandidate>;
  claim(input: RemoteBlockClaimInput): Promise<RemoteBlockBindingView>;
  activate(input: RemoteBlockRefIdentity): Promise<RemoteBlockBindingView>;
  query(input: RemoteBlockOperationQuery): Promise<RemoteBlockBindingView>;
  reconcile(input: RemoteBlockOperationQuery): Promise<RemoteBlockBindingView>;
  markInterrupted(input: RemoteBlockInterruptionInput): Promise<RemoteBlockMutationResult>;
  resumeAttempt(input: RemoteBlockRefIdentity): Promise<RemoteBlockBindingView>;
  retryAttempt(input: RemoteBlockRetryAttemptInput): Promise<RemoteBlockBindingView>;
  complete(input: RemoteBlockCompletionInput): Promise<RemoteBlockCompletionResult>;
  fail(input: RemoteBlockFailureInput): Promise<RemoteBlockMutationResult>;
}

export function createRemoteBlockRuntimePort(options: {
  projectRoot: PackageWorkspaceRef;
}): RemoteBlockRuntimePort {
  const projectRoot = options.projectRoot;

  async function withLock<T>(
    operation: (context: RuntimeContext) => Promise<T>,
    loadContext = loadRuntime
  ): Promise<T> {
    const { workspace } = await loadPackage(projectRoot);
    return withExecutionStateLock({ projectRoot: workspace }, workspace, async () =>
      operation(await loadContext({ projectRoot: workspace }))
    );
  }

  return {
    inspect: async (rawInput) => {
      const { ref } = remoteBlockInspectInputSchema.parse(rawInput);
      return inspectRemoteBlockCandidate(projectRoot, ref);
    },

    claim: async (rawInput) => {
      const input = remoteBlockClaimInputSchema.parse(rawInput);
      return withLock(async (context) => {
        const blockType = remoteExecutableBlockType(context, input.ref);
        const existing = context.state.blocks[input.ref];
        const current =
          input.restoration && !existing.remoteOwnership
            ? restoreStoppedRemoteBlock(existing, input.restoration)
            : existing;
        if (current !== existing) context.state.blocks[input.ref] = current;
        const reviewForm =
          blockType === "review" && !current.remoteOwnership
            ? reviewClaimForm(context.graph, context.state, input.ref)
            : null;
        const prepared = prepareRemoteBlockOwnership({
          blockType,
          blockState: current,
          ownership: {
            operationId: input.operationId,
            controlPlane: input.controlPlane,
            sourceRevision: input.sourceRevision,
            graphFingerprint: input.graphFingerprint
          }
        });
        if (current.remoteOwnership) {
          const source = await remoteBlockSourceEvidence(context, input.ref);
          if (!sameRemoteBlockAuthority(source, input)) {
            context.state.blocks[input.ref] = markRemoteBlockOwnershipSourceDrift({
              blockType,
              blockState: current,
              ...source,
              reason: `Remote source changed after operation '${input.operationId}' was prepared.`
            });
            releaseCurrentBlockPointers(context.state, input.ref);
            await writeLockedState(context);
            throw new RemoteBlockRuntimeError(
              "remote_block_source_changed",
              `Remote source changed after operation '${input.operationId}' was prepared.`
            );
          }
        } else {
          await assertRemoteBlockDispatchable(context, input.ref);
          const source = await remoteBlockSourceEvidence(context, input.ref);
          if (!sameRemoteBlockAuthority(source, input)) {
            throw new RemoteBlockRuntimeError(
              "remote_block_source_changed",
              `Inspected source for '${input.ref}' is no longer current.`
            );
          }
        }
        context.state.blocks[input.ref] = prepared;
        if (reviewForm?.kind === "resume") {
          const clearCurrentFeedback = Boolean(
            context.state.currentFeedbackId &&
              context.state.feedback[context.state.currentFeedbackId]?.status === "resolved"
          );
          applyCurrentReviewResumeClaim(context.state, input.ref, { clearCurrentFeedback });
        } else {
          context.state.currentRefs = withCurrentRef(context.state.currentRefs, input.ref);
          if (blockType === "review") {
            context.state.currentReviewBlockRef = input.ref;
          }
        }
        await writeLockedState(context);
        return bindingView(context, input.ref);
      });
    },

    activate: async (rawInput) => {
      const input = remoteBlockRefIdentitySchema.parse(rawInput);
      return withLock(async (context) => {
        const blockType = remoteExecutableBlockType(context, input.ref);
        activateRemoteBlockOwnership({
          blockType,
          blockState: context.state.blocks[input.ref],
          ownership: identityFromInput(input)
        });
        const source = await remoteBlockSourceEvidence(context, input.ref);
        if (!sameRemoteBlockAuthority(source, input)) {
          context.state.blocks[input.ref] = markRemoteBlockOwnershipSourceDrift({
            blockType,
            blockState: context.state.blocks[input.ref],
            ...source,
            reason: `Remote source changed before activation of '${input.ref}'.`
          });
          releaseCurrentBlockPointers(context.state, input.ref);
          await writeLockedState(context);
          throw new RemoteBlockRuntimeError(
            "remote_block_source_changed",
            `Remote source changed before activation of '${input.ref}'.`
          );
        }
        context.state.blocks[input.ref] = activateRemoteBlockOwnership({
          blockType,
          blockState: context.state.blocks[input.ref],
          ownership: identityFromInput(input)
        });
        await writeLockedState(context);
        return bindingView(context, input.ref);
      });
    },

    query: async (rawInput) => {
      const { ref, operationId } = remoteBlockOperationQuerySchema.parse(rawInput);
      const context = await loadRuntimeReadonly({ projectRoot });
      remoteExecutableBlockType(context, ref);
      const view = bindingView(context, ref);
      assertOperationMatchesView(view, operationId);
      return view;
    },

    reconcile: async (rawInput) => {
      const { ref, operationId } = remoteBlockOperationQuerySchema.parse(rawInput);
      return withLock(async (context) => {
        const blockType = remoteExecutableBlockType(context, ref);
        let view = bindingView(context, ref);
        assertOperationMatchesView(view, operationId);
        if (!view.ownership) {
          return view;
        }
        const source = await remoteBlockSourceEvidence(context, ref);
        if (!sameRemoteBlockAuthority(source, view.ownership)) {
          context.state.blocks[ref] = markRemoteBlockOwnershipSourceDrift({
            blockType,
            blockState: context.state.blocks[ref],
            ...source,
            reason: `Remote source changed while operation '${operationId}' was active.`
          });
          releaseCurrentBlockPointers(context.state, ref);
          await writeLockedState(context);
          view = bindingView(context, ref);
        }
        return view;
      });
    },

    markInterrupted: async (rawInput) => {
      const input = remoteBlockInterruptionInputSchema.parse(rawInput);
      return withLock(async (context) => {
        const blockType = remoteExecutableBlockType(context, input.ref);
        const current = context.state.blocks[input.ref];
        assertActiveRemoteBlockOwnership({
          blockType,
          blockState: current,
          ownership: identityFromInput(input)
        });
        const source = await remoteBlockSourceEvidence(context, input.ref);
        if (!sameRemoteBlockAuthority(source, input)) {
          context.state.blocks[input.ref] = markRemoteBlockOwnershipSourceDrift({
            blockType,
            blockState: context.state.blocks[input.ref],
            ...source,
            reason: `Remote source changed before interruption of '${input.ref}'.`
          });
          releaseCurrentBlockPointers(context.state, input.ref);
          await writeLockedState(context);
          throw new RemoteBlockRuntimeError(
            "remote_block_source_changed",
            `Remote source changed before interruption of '${input.ref}'.`
          );
        }
        const interrupted = interruptRemoteBlockOwnership({
          blockType,
          blockState: current,
          ownership: identityFromInput(input),
          interruption: input.interruption,
          reason: `Remote execution interrupted: ${input.interruption.reason}.`
        });
        const retryDecision = input.interruption.resumable
          ? "resume_exact_attempt"
          : "manual_retry_required";
        if (interrupted === current) {
          return remoteBlockMutationResultSchema.parse({
            binding: bindingView(context, input.ref),
            retryDecision
          });
        }
        let runId: string | undefined;
        // Non-resumable interruptions (e.g. lease_lost) never create a local run unless we
        // materialize one here — otherwise Task Workspace keeps showing older local Auto Runs.
        if (!input.interruption.resumable) {
          runId = await persistRemoteFailure(
            context.workspace,
            input.ref,
            {
              code: "transport_failed",
              message: `Remote execution interrupted: ${input.interruption.reason}.`,
              retryable: false
            },
            identityFromInput(input),
            input.agentId
          );
        }
        context.state.blocks[input.ref] = runId
          ? { ...interrupted, lastRunId: runId }
          : interrupted;
        releaseCurrentBlockPointers(context.state, input.ref);
        await writeLockedState(context);
        return remoteBlockMutationResultSchema.parse({
          binding: bindingView(context, input.ref),
          retryDecision
        });
      }, loadRuntimeReadonly);
    },

    resumeAttempt: async (rawInput) => {
      const input = remoteBlockRefIdentitySchema.parse(rawInput);
      return withLock(async (context) => {
        const blockType = remoteExecutableBlockType(context, input.ref);
        const current = context.state.blocks[input.ref];
        const requested = identityFromInput(input);
        if (
          current.status === "in_progress" &&
          current.remoteOwnership?.phase === "active" &&
          JSON.stringify(current.remoteOwnership) ===
            JSON.stringify({ phase: "active", ...requested })
        ) {
          return bindingView(context, input.ref);
        }
        assertActiveRemoteBlockOwnership({
          blockType,
          blockState: current,
          ownership: requested
        });
        const source = await remoteBlockSourceEvidence(context, input.ref);
        if (!sameRemoteBlockAuthority(source, input)) {
          context.state.blocks[input.ref] = markRemoteBlockOwnershipSourceDrift({
            blockType,
            blockState: context.state.blocks[input.ref],
            ...source,
            reason: `Remote source changed before resume of '${input.ref}'.`
          });
          releaseCurrentBlockPointers(context.state, input.ref);
          await writeLockedState(context);
          throw new RemoteBlockRuntimeError(
            "remote_block_source_changed",
            `Remote source changed before resume of '${input.ref}'.`
          );
        }
        context.state.blocks[input.ref] = resumeRemoteBlockOwnership({
          blockType,
          blockState: context.state.blocks[input.ref],
          ownership: identityFromInput(input)
        });
        await writeLockedState(context);
        return bindingView(context, input.ref);
      });
    },

    retryAttempt: async (rawInput) => {
      const input = remoteBlockRetryAttemptInputSchema.parse(rawInput);
      return withLock(async (context) => {
        const blockType = remoteExecutableBlockType(context, input.ref);
        const current = context.state.blocks[input.ref];
        const retriedIdentity = identityFromInput({
          ...input,
          dispatchId: input.newDispatchId,
          executionAttemptId: input.newExecutionAttemptId
        });
        if (
          current.status === "in_progress" &&
          current.remoteOwnership?.phase === "active" &&
          JSON.stringify(current.remoteOwnership) ===
            JSON.stringify({ phase: "active", ...retriedIdentity })
        ) {
          return bindingView(context, input.ref);
        }
        assertActiveRemoteBlockOwnership({
          blockType,
          blockState: current,
          ownership: identityFromInput(input)
        });
        const source = await remoteBlockSourceEvidence(context, input.ref);
        if (!sameRemoteBlockAuthority(source, input)) {
          context.state.blocks[input.ref] = markRemoteBlockOwnershipSourceDrift({
            blockType,
            blockState: context.state.blocks[input.ref],
            ...source,
            reason: `Remote source changed before retry of '${input.ref}'.`
          });
          releaseCurrentBlockPointers(context.state, input.ref);
          await writeLockedState(context);
          throw new RemoteBlockRuntimeError(
            "remote_block_source_changed",
            `Remote source changed before retry of '${input.ref}'.`
          );
        }
        context.state.blocks[input.ref] = retryRemoteBlockOwnership({
          blockType,
          blockState: context.state.blocks[input.ref],
          ownership: identityFromInput(input),
          newDispatchId: input.newDispatchId,
          newExecutionAttemptId: input.newExecutionAttemptId
        });
        await writeLockedState(context);
        return bindingView(context, input.ref);
      });
    },

    complete: async (input) =>
      remoteBlockCompletionResultSchema.parse(
        await submitRemoteBlockResult({ projectRoot, ...input })
      ),

    fail: async (rawInput) => {
      const input = remoteBlockFailureInputSchema.parse(rawInput);
      return withLock(async (context) => {
        const blockType = remoteExecutableBlockType(context, input.ref);
        const current = context.state.blocks[input.ref];
        if (current.remoteOperationReceipt) {
          if (
            current.remoteOperationReceipt.outcome !== "failed" ||
            !matchesRemoteOperationReceipt(current.remoteOperationReceipt, input) ||
            JSON.stringify(current.remoteOperationReceipt.failure) !== JSON.stringify(input.failure)
          ) {
            throw new RemoteOwnershipConflictError(
              "remote_ownership_terminal_conflict",
              `Remote failure for '${input.ref}' conflicts with its terminal operation receipt.`
            );
          }
          return remoteBlockMutationResultSchema.parse({
            binding: bindingView(context, input.ref),
            retryDecision: input.failure.retryable ? "manual_retry_required" : "not_retryable"
          });
        }
        assertActiveRemoteBlockOwnership({
          blockType,
          blockState: current,
          ownership: identityFromInput(input)
        });
        const source = await remoteBlockSourceEvidence(context, input.ref);
        if (!sameRemoteBlockAuthority(source, input)) {
          context.state.blocks[input.ref] = markRemoteBlockOwnershipSourceDrift({
            blockType,
            blockState: current,
            ...source,
            reason: `Remote source changed before failure of '${input.ref}'.`
          });
          releaseCurrentBlockPointers(context.state, input.ref);
          await writeLockedState(context);
          throw new RemoteBlockRuntimeError(
            "remote_block_source_changed",
            `Remote source changed before failure of '${input.ref}'.`
          );
        }
        const runId = await persistRemoteFailure(
          context.workspace,
          input.ref,
          input.failure,
          identityFromInput(input),
          input.agentId
        );
        context.state.blocks[input.ref] = failRemoteBlockOwnership({
          blockType,
          blockState: current,
          ownership: identityFromInput(input),
          failure: input.failure,
          blockedReason: `[${input.failure.code}] ${input.failure.message}`,
          runId
        });
        releaseCurrentBlockPointers(context.state, input.ref);
        await writeLockedState(context);
        return remoteBlockMutationResultSchema.parse({
          binding: bindingView(context, input.ref),
          retryDecision: input.failure.retryable ? "manual_retry_required" : "not_retryable"
        });
      }, loadRuntimeReadonly);
    }
  };
}

async function persistRemoteFailure(
  workspace: Parameters<typeof materializeRemoteAcpFailure>[0]["workspace"],
  ref: string,
  failure: Parameters<typeof materializeRemoteAcpFailure>[0]["failure"],
  identity: Parameters<typeof materializeRemoteAcpFailure>[0]["identity"],
  agentId: string | undefined
): Promise<string> {
  const { taskId, blockId } = parseBlockRef(ref);
  const runRoot = await resolveResultsPath(workspace.resultsDir, taskId, "blocks", blockId, "runs");
  await resolveResultsPath(workspace.resultsDir, taskId, "index.json");
  return withPreparedBlockRunIndex(runRoot, async (prepareIndex) => {
    const runId = await findAvailableRunId(runRoot);
    const startedAt = new Date().toISOString();
    const publishIndex = await prepareIndex(runId, {
      metadata: { ref, startedAt },
      hasArtifact: true
    });
    await mkdir(join(runRoot, runId), { recursive: false });
    await materializeRemoteAcpFailure({
      workspace,
      ref,
      runId,
      failure,
      startedAt,
      identity,
      ...(agentId ? { agentId } : {})
    });
    await publishIndex();
    await updateTaskIndex(workspace, taskId, (index) => ({
      ...index,
      latestRunByBlock: { ...index.latestRunByBlock, [ref]: runId }
    }));
    return runId;
  });
}
