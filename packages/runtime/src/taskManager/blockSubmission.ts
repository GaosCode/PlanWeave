import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { OUTPUT_MAX_ARTIFACT_BYTES } from "@planweave-ai/agent-host-protocol/browser";
import {
  materializeArtifactBytes,
  readVerifiedArtifactReference,
  type ArtifactMaterializationHooks
} from "../autoRun/artifactReferenceContract.js";
import type { ArtifactReference } from "../autoRun/runnerContractSchemas.js";
import { findAvailableRunId } from "../autoRun/executorShared.js";
import { withPreparedBlockRunIndex } from "../autoRun/blockRunIndex.js";
import { optionalReaddir } from "../fs/optionalFile.js";
import { withExecutionStateLock } from "./executionStateBoundary.js";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { writeJsonFile } from "../json.js";
import { loadPackage } from "../package/loadPackage.js";
import { writeState } from "../state.js";
import { assertResultsRunId, resolveResultsPath } from "./resultPaths.js";
import type {
  BlockState,
  ExecutionGraphSession,
  PackageWorkspaceRef,
  SubmitResult
} from "../types.js";
import {
  findAttemptRun,
  readImplementationRunMetadataFile,
  type ImplementationRunMetadata
} from "./implementationRunMetadata.js";
import { exists, loadRuntimeReadonly, refreshDerivedState } from "./runtimeContext.js";
import { getBlock } from "./selectors.js";
import { incrementTaskIndexCount, updateTaskIndex } from "./resultIndex.js";
import { withoutRemoteBlockOwnership } from "./remoteOwnershipTransitions.js";
import {
  assertActiveRemoteBlockOwnership,
  completeRemoteBlockOwnership,
  matchesRemoteOperationReceipt,
  markRemoteBlockOwnershipSourceDrift,
  type ActiveRemoteOperationIdentity
} from "./remoteOwnershipTransitions.js";
import {
  remoteBlockCompletionInputSchema,
  RemoteBlockRuntimeError,
  type RemoteBlockCompletionInput
} from "./remoteBlockRuntimeContracts.js";
import { remoteBlockSourceEvidence, sameRemoteBlockAuthority } from "./remoteBlockSource.js";
import {
  assertRemoteAcpTranscriptPaths,
  materializeRemoteAcpTranscript,
  remoteAcpStartTime
} from "./remoteAcpTranscript.js";
import { submitRemoteReviewResult } from "./reviewSubmission.js";

type BlockSubmissionArtifact =
  | { mode: "legacy"; bytes: Buffer }
  | { mode: "verified"; reference: ArtifactReference; bytes: Buffer };

type SubmissionAuthority =
  | { kind: "local" }
  | {
      kind: "remote";
      identity: ActiveRemoteOperationIdentity;
      transcript?: NonNullable<RemoteBlockCompletionInput["transcript"]>;
    };

async function runHasSubmittedResult(
  runDir: string,
  ref: string,
  runId: string,
  artifact: BlockSubmissionArtifact
): Promise<boolean> {
  const metadataPath = await resolveResultsPath(runDir, "metadata.json");
  const reportPath =
    artifact.mode === "legacy"
      ? await resolveResultsPath(runDir, "report.md")
      : join(runDir, "report.md");
  if (!((await exists(metadataPath)) && (await exists(reportPath)))) {
    return false;
  }
  const metadata = await readImplementationRunMetadataFile(metadataPath);
  if (metadata.ref !== ref || metadata.runId !== runId) {
    return false;
  }
  const reportHash = createHash("sha256").update(artifact.bytes).digest("hex");
  if (metadata.reportHash !== reportHash) {
    return false;
  }
  let persistedBytes: Buffer;
  if (artifact.mode === "verified") {
    const persisted = await readVerifiedArtifactReference({
      rootDir: runDir,
      value: metadata.artifactReference
    });
    if (
      persisted.reference.version !== artifact.reference.version ||
      persisted.reference.kind !== artifact.reference.kind ||
      persisted.reference.relativePath !== artifact.reference.relativePath ||
      persisted.reference.sha256 !== artifact.reference.sha256 ||
      persisted.reference.sizeBytes !== artifact.reference.sizeBytes ||
      persisted.reference.mediaType !== artifact.reference.mediaType
    ) {
      throw new Error(`Persisted artifact reference for run '${runId}' does not match submission.`);
    }
    persistedBytes = persisted.bytes;
  } else {
    persistedBytes = await readFile(reportPath);
  }
  if (!persistedBytes.equals(artifact.bytes)) {
    throw new Error(`Persisted report for run '${runId}' does not match its submitted hash.`);
  }
  return true;
}

async function resolveSubmissionRun(options: {
  runRoot: string;
  blockState: BlockState;
  attemptId: string | undefined;
  selectedRunId: string | undefined;
  reservedRunId: string | undefined;
  ref: string;
  taskId: string;
  blockId: string;
  local: boolean;
}): Promise<{
  candidateRunId: string | undefined;
  candidateMetadata: ImplementationRunMetadata;
  candidateDirectoryExists: boolean;
}> {
  const {
    runRoot,
    blockState,
    attemptId,
    selectedRunId,
    reservedRunId,
    ref,
    taskId,
    blockId,
    local
  } = options;
  let candidateRunId = selectedRunId;
  if (!candidateRunId && attemptId)
    candidateRunId = (await findAttemptRun(runRoot, attemptId)) ?? undefined;
  if (!candidateRunId && local && blockState.status === "in_progress") {
    const entries = await optionalReaddir(runRoot, { withFileTypes: true });
    for (const entry of entries ?? []) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = await resolveResultsPath(runRoot, entry.name, "metadata.json");
      if (!(await exists(path))) {
        if (entry.name !== blockState.lastRunId) {
          throw new Error(
            `Submission identity is ambiguous for incomplete run '${entry.name}'; its owning claim must be proven before retrying.`
          );
        }
        continue;
      }
      const metadata = await readImplementationRunMetadataFile(path);
      if (!metadata.submissionAttemptId && entry.name !== blockState.lastRunId) {
        throw new Error(
          `Submission identity is ambiguous for legacy run '${entry.name}'; its owning claim must be proven before retrying.`
        );
      }
    }
  }
  const candidateDir = candidateRunId ? await resolveResultsPath(runRoot, candidateRunId) : null;
  const candidateDirectoryExists = candidateDir !== null && (await exists(candidateDir));
  const candidateMetadata =
    candidateDir && (await exists(await resolveResultsPath(candidateDir, "metadata.json")))
      ? await readImplementationRunMetadataFile(join(candidateDir, "metadata.json"))
      : {};
  if (candidateRunId) {
    for (const [key, expected] of Object.entries({
      ref,
      taskId,
      blockId,
      runId: candidateRunId
    })) {
      if (candidateMetadata[key] !== undefined && candidateMetadata[key] !== expected) {
        throw new Error(`Run '${candidateRunId}' identity conflicts with submission (${key}).`);
      }
    }
    if (
      candidateMetadata.submissionAttemptId &&
      candidateMetadata.submissionAttemptId !== attemptId &&
      !(
        attemptId === undefined &&
        blockState.status === "completed" &&
        candidateRunId === blockState.lastRunId
      )
    ) {
      throw new Error(`Run '${candidateRunId}' attempt conflicts with submission.`);
    }
    if (
      !candidateMetadata.submissionAttemptId &&
      blockState.status === "in_progress" &&
      candidateDirectoryExists &&
      reservedRunId !== candidateRunId
    ) {
      throw new Error(
        `Submission identity is ambiguous for legacy run '${candidateRunId}'; its owning claim must have a persisted reservation before retrying.`
      );
    }
    if (
      !candidateMetadata.submissionAttemptId &&
      candidateMetadata.reportHash &&
      blockState.status === "in_progress" &&
      candidateRunId === blockState.lastRunId
    ) {
      throw new Error(
        `Submission identity is ambiguous for historical run '${candidateRunId}'; prepare a new execution for this claim before submitting.`
      );
    }
  }
  if (blockState.status === "completed" && candidateRunId !== blockState.lastRunId) {
    throw new Error(`Run '${candidateRunId}' conflicts with completed submission.`);
  }
  return { candidateRunId, candidateMetadata, candidateDirectoryExists };
}

export async function submitBlockResult(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  reportPath: string;
  runId?: string;
  submissionAttemptId?: string;
  session?: ExecutionGraphSession;
  executionSnapshot?: import("../package/packageExecutionSnapshot.js").PackageExecutionSnapshot;
}): Promise<SubmitResult> {
  return submitBlockResultFromBytes(options, await readFile(options.reportPath));
}

export async function submitBlockResultFromBytes(
  options: {
    projectRoot: PackageWorkspaceRef;
    ref: string;
    reportPath: string;
    runId?: string;
    submissionAttemptId?: string;
    session?: ExecutionGraphSession;
    executionSnapshot?: import("../package/packageExecutionSnapshot.js").PackageExecutionSnapshot;
  },
  reportBytes: Buffer
): Promise<SubmitResult> {
  return submitBlockResultArtifact(options, { mode: "legacy", bytes: reportBytes });
}

export async function submitVerifiedBlockResult(
  options: {
    projectRoot: PackageWorkspaceRef;
    ref: string;
    reportPath: string;
    runId?: string;
    submissionAttemptId?: string;
    session?: ExecutionGraphSession;
    executionSnapshot?: import("../package/packageExecutionSnapshot.js").PackageExecutionSnapshot;
  },
  artifact: { reference: ArtifactReference; bytes: Buffer },
  hooks: ArtifactMaterializationHooks = {}
): Promise<SubmitResult> {
  return submitBlockResultArtifact(
    options,
    { mode: "verified", reference: artifact.reference, bytes: artifact.bytes },
    hooks,
    { kind: "local" }
  );
}

export async function submitRemoteBlockResult(
  options: { projectRoot: PackageWorkspaceRef } & RemoteBlockCompletionInput,
  hooks: ArtifactMaterializationHooks = {}
): Promise<SubmitResult> {
  const { projectRoot: _projectRoot, ...portableInput } = options;
  const input = remoteBlockCompletionInputSchema.parse(portableInput);
  const bytes = Buffer.from(input.reportBytes);
  if (bytes.byteLength > OUTPUT_MAX_ARTIFACT_BYTES) {
    throw new RemoteBlockRuntimeError(
      "remote_block_result_conflict",
      `Remote report exceeds the ${OUTPUT_MAX_ARTIFACT_BYTES}-byte output limit.`
    );
  }
  const sha256 = input.reportArtifactRef.slice("artifact:sha256:".length);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== actualSha256) {
    throw new RemoteBlockRuntimeError(
      "remote_block_result_conflict",
      "Remote report artifact reference does not match the supplied bytes."
    );
  }
  const identity = {
    operationId: input.operationId,
    ...(input.controlPlane ? { controlPlane: input.controlPlane } : {}),
    sourceRevision: input.sourceRevision,
    graphFingerprint: input.graphFingerprint,
    dispatchId: input.dispatchId,
    executionAttemptId: input.executionAttemptId
  };
  const context = await loadRuntimeReadonly({ projectRoot: options.projectRoot });
  const block = getBlock(context.graph, input.ref);
  if (block.type === "review") {
    const review = await submitRemoteReviewResult({
      projectRoot: options.projectRoot,
      ref: input.ref,
      reportBytes: bytes,
      ownership: identity,
      ...(input.transcript ? { transcript: input.transcript } : {})
    });
    // Remote operation terminal shape is always completed when Host writeback succeeds.
    return {
      ref: review.ref,
      runId: review.reviewAttemptId,
      status: "completed"
    };
  }
  return submitBlockResultArtifact(
    {
      projectRoot: options.projectRoot,
      ref: input.ref
    },
    {
      mode: "verified",
      reference: {
        version: "planweave.runner/v1",
        kind: "implementation",
        relativePath: "report.md",
        sha256,
        sizeBytes: bytes.byteLength,
        mediaType: "text/markdown"
      },
      bytes
    },
    hooks,
    {
      kind: "remote",
      ...(input.transcript ? { transcript: input.transcript } : {}),
      identity
    }
  );
}

async function submitBlockResultArtifact(
  options: {
    projectRoot: PackageWorkspaceRef;
    ref: string;
    reportPath?: string;
    runId?: string;
    submissionAttemptId?: string;
    session?: ExecutionGraphSession;
    executionSnapshot?: import("../package/packageExecutionSnapshot.js").PackageExecutionSnapshot;
  },
  artifact: BlockSubmissionArtifact,
  hooks: ArtifactMaterializationHooks = {},
  authority: SubmissionAuthority = { kind: "local" }
): Promise<SubmitResult> {
  if (options.runId !== undefined) assertResultsRunId(options.runId);
  const reportHash = createHash("sha256").update(artifact.bytes).digest("hex");
  if (
    artifact.mode === "verified" &&
    (artifact.reference.kind !== "implementation" ||
      artifact.reference.relativePath !== "report.md" ||
      artifact.reference.sha256 !== reportHash ||
      artifact.reference.sizeBytes !== artifact.bytes.byteLength)
  ) {
    throw new Error("Verified implementation artifact reference does not match its bytes.");
  }
  const { workspace: lockWorkspace } =
    options.executionSnapshot ?? (await loadPackage(options.projectRoot));
  return withExecutionStateLock(options, lockWorkspace, async () => {
    const context = await loadRuntimeReadonly({ ...options, projectRoot: lockWorkspace });
    const { workspace, manifest, graph } = context;
    let { state } = context;
    const { taskId, blockId } = parseBlockRef(options.ref);
    const block = getBlock(graph, options.ref);
    if (block.type === "review") {
      throw new Error("submit-result only accepts implementation blocks.");
    }
    const runRoot = await resolveResultsPath(
      workspace.resultsDir,
      taskId,
      "blocks",
      blockId,
      "runs"
    );
    await resolveResultsPath(workspace.resultsDir, taskId, "index.json");
    const blockState = state.blocks[options.ref];
    if (authority.kind === "local" && blockState?.remoteOwnership) {
      throw new Error(
        `Remote-owned block '${options.ref}' must be completed through the remote operation port.`
      );
    }
    if (authority.kind === "local" && blockState?.remoteOperationReceipt) {
      throw new Error(
        `Remote-completed block '${options.ref}' cannot be replayed through local submit-result.`
      );
    }
    if (authority.kind === "remote" && blockState?.remoteOperationReceipt) {
      if (
        blockState.remoteOperationReceipt.outcome !== "completed" ||
        !matchesRemoteOperationReceipt(blockState.remoteOperationReceipt, authority.identity)
      ) {
        throw new RemoteBlockRuntimeError(
          "remote_block_result_conflict",
          `Remote completion for '${options.ref}' conflicts with its terminal operation receipt.`
        );
      }
      const receiptRunId = blockState.remoteOperationReceipt.runId;
      assertResultsRunId(receiptRunId);
      const receiptRunDir = await resolveResultsPath(runRoot, receiptRunId);
      if (!(await runHasSubmittedResult(receiptRunDir, options.ref, receiptRunId, artifact))) {
        throw new RemoteBlockRuntimeError(
          "remote_block_result_conflict",
          `Remote completion receipt for '${options.ref}' does not match the submitted report.`
        );
      }
      return { ref: options.ref, runId: receiptRunId, status: "completed" };
    }
    if (authority.kind === "remote") {
      assertActiveRemoteBlockOwnership({
        blockType: block.type,
        blockState,
        ownership: authority.identity
      });
      const remoteCanSubmit =
        blockState?.status === "in_progress" ||
        (blockState?.status === "diverged" && blockState.remoteInterruption?.resumable === true);
      if (!remoteCanSubmit) {
        throw new Error(`Block '${options.ref}' must be in_progress before submit-result.`);
      }
      const currentSource = await remoteBlockSourceEvidence(context, options.ref);
      if (!sameRemoteBlockAuthority(currentSource, authority.identity)) {
        state.blocks[options.ref] = markRemoteBlockOwnershipSourceDrift({
          blockType: block.type,
          blockState,
          ...currentSource,
          reason: `Remote source changed before completion of '${options.ref}'.`
        });
        state = refreshDerivedState(manifest, state);
        await writeState(workspace.stateFile, state);
        throw new RemoteBlockRuntimeError(
          "remote_block_source_changed",
          `Remote source changed before completion of '${options.ref}'.`
        );
      }
    }
    if (
      authority.kind === "local" &&
      blockState?.status !== "in_progress" &&
      blockState?.status !== "completed"
    ) {
      throw new Error(`Block '${options.ref}' must be in_progress before submit-result.`);
    }
    if (
      authority.kind === "local" &&
      options.submissionAttemptId !== undefined &&
      blockState.submissionAttemptId !== options.submissionAttemptId
    ) {
      throw new Error(`Executor claim '${options.ref}' attempt conflicts with current submission.`);
    }
    const attemptId =
      authority.kind === "remote"
        ? JSON.stringify([
            authority.identity.operationId,
            authority.identity.controlPlane ?? "collaboration",
            authority.identity.sourceRevision,
            authority.identity.graphFingerprint,
            authority.identity.dispatchId,
            authority.identity.executionAttemptId
          ])
        : blockState.submissionAttemptId;
    const reservedRunId =
      blockState.submissionAttemptId === attemptId ? blockState.submissionRunId : undefined;
    if (options.runId && reservedRunId && options.runId !== reservedRunId) {
      throw new Error(`Run '${options.runId}' conflicts with submission run '${reservedRunId}'.`);
    }
    const selectedRunId =
      options.runId ??
      reservedRunId ??
      (blockState.status === "completed" ? (blockState.lastRunId ?? undefined) : undefined);
    if (options.runId === undefined && selectedRunId !== undefined) {
      assertResultsRunId(selectedRunId);
    }
    return withPreparedBlockRunIndex(runRoot, async (prepareIndex) => {
      const { candidateRunId, candidateMetadata, candidateDirectoryExists } =
        await resolveSubmissionRun({
          runRoot,
          blockState,
          attemptId,
          selectedRunId,
          reservedRunId,
          ref: options.ref,
          taskId,
          blockId,
          local: authority.kind === "local"
        });
      const candidateDir = candidateRunId ? join(runRoot, candidateRunId) : null;
      if (candidateDir) {
        if (artifact.mode === "legacy") await resolveResultsPath(candidateDir, "report.md");
        if (authority.kind === "remote" && authority.transcript) {
          await assertRemoteAcpTranscriptPaths(candidateDir);
        }
      }
      if (
        (candidateMetadata.reportHash && candidateMetadata.reportHash !== reportHash) ||
        (candidateMetadata.submissionReportHash &&
          candidateMetadata.submissionReportHash !== reportHash)
      ) {
        throw new Error(`Run '${candidateRunId}' report conflicts with submission.`);
      }
      const persistedRunId =
        candidateRunId &&
        candidateDir &&
        (await runHasSubmittedResult(candidateDir, options.ref, candidateRunId, artifact))
          ? candidateRunId
          : null;
      if (persistedRunId) {
        const publishIndex = await prepareIndex(persistedRunId, {
          metadata: candidateMetadata,
          hasArtifact: true
        });
        await publishIndex();
        await updateTaskIndex(workspace, taskId, (index) => ({
          ...index,
          latestRunByBlock: {
            ...(index.latestRunByBlock ?? {}),
            [options.ref]: persistedRunId
          },
          counts:
            index.latestRunByBlock?.[options.ref] === persistedRunId
              ? index.counts
              : incrementTaskIndexCount(index, "runs")
        }));
        state.blocks[options.ref] =
          authority.kind === "remote"
            ? completeRemoteBlockOwnership({
                blockType: block.type,
                blockState: state.blocks[options.ref],
                ownership: authority.identity,
                runId: persistedRunId
              })
            : {
                ...withoutRemoteBlockOwnership(state.blocks[options.ref], "completed"),
                lastRunId: persistedRunId
              };
        state.currentRefs = state.currentRefs.filter((ref) => ref !== options.ref);
        state = refreshDerivedState(manifest, state);
        await writeState(workspace.stateFile, state);
        return { ref: options.ref, runId: persistedRunId, status: "completed" };
      }
      if (authority.kind === "local" && blockState?.status !== "in_progress") {
        throw new Error(`Block '${options.ref}' must be in_progress before submit-result.`);
      }
      const durableAttemptId = attemptId ?? randomUUID();
      const runId = candidateRunId ?? (await findAvailableRunId(runRoot));
      const runDir = join(runRoot, runId);
      const submittedAt = new Date().toISOString();
      const remoteTranscript =
        authority.kind === "remote" && authority.transcript
          ? {
              transcript: authority.transcript,
              startedAt: remoteAcpStartTime(authority.transcript, submittedAt)
            }
          : null;
      const publishIndex = await prepareIndex(runId, {
        metadata: {
          ...candidateMetadata,
          ref: options.ref,
          submittedAt,
          ...(remoteTranscript ? { startedAt: remoteTranscript.startedAt } : {})
        },
        hasArtifact: true
      });
      if (!attemptId) {
        state.blocks[options.ref] = {
          ...state.blocks[options.ref],
          submissionAttemptId: durableAttemptId
        };
        await writeState(workspace.stateFile, state);
      }
      const createdRunDirectory = !candidateDirectoryExists;
      if (createdRunDirectory) await mkdir(runDir, { recursive: false });
      try {
        await writeJsonFile(join(runDir, "metadata.json"), {
          ...candidateMetadata,
          ref: options.ref,
          taskId,
          blockId,
          runId,
          submissionAttemptId: durableAttemptId,
          submissionReportHash: reportHash
        });
      } catch (error) {
        if (createdRunDirectory) {
          try {
            await rmdir(runDir);
          } catch (cleanupError) {
            if (!(error instanceof Error))
              throw new AggregateError(
                [error, cleanupError],
                "RUN reservation and empty-directory cleanup failed."
              );
            error.cause =
              error.cause === undefined
                ? cleanupError
                : new AggregateError(
                    [error.cause, cleanupError],
                    "RUN reservation cleanup failed."
                  );
          }
        }
        throw error;
      }
      state.blocks[options.ref] = {
        ...state.blocks[options.ref],
        submissionAttemptId: durableAttemptId,
        submissionRunId: runId
      };
      await writeState(workspace.stateFile, state);
      const reportDestination = join(runDir, "report.md");
      const metadataPath = join(runDir, "metadata.json");
      const artifactReference =
        artifact.mode === "verified"
          ? await materializeArtifactBytes(
              {
                rootDir: runDir,
                relativePath: "report.md",
                kind: "implementation",
                content: artifact.bytes
              },
              hooks
            )
          : null;
      if (artifact.mode === "legacy") {
        await writeFile(reportDestination, artifact.bytes);
      }
      const remoteTiming = remoteTranscript
        ? await materializeRemoteAcpTranscript({
            workspace,
            ref: options.ref,
            runId,
            ...remoteTranscript,
            artifact:
              artifactReference ??
              (() => {
                throw new Error("Remote ACP transcript requires a verified artifact reference.");
              })()
          })
        : null;
      const previousMetadata: ImplementationRunMetadata = (await exists(metadataPath))
        ? await readImplementationRunMetadataFile(metadataPath)
        : {};
      await writeJsonFile(metadataPath, {
        ...previousMetadata,
        ref: options.ref,
        taskId,
        blockId,
        runId,
        submittedAt,
        reportHash,
        submissionAttemptId: durableAttemptId,
        ...(artifactReference ? { artifactReference } : {}),
        ...(authority.kind === "remote" && authority.transcript
          ? {
              claimRef: options.ref,
              projectId: workspace.id,
              canvasId: basename(dirname(workspace.packageDir)),
              executor: authority.transcript.executor,
              adapter: "agent",
              agentId: authority.transcript.agentId,
              runnerKind: "acp",
              executorRunId: runId,
              runSessionId: null,
              desktopRunId: null,
              sessionId: authority.transcript.sessionId,
              agentSessionId: authority.transcript.sessionId,
              status: "completed",
              startedAt: remoteTiming?.startedAt,
              finishedAt: remoteTiming?.finishedAt,
              exitCode: 0
            }
          : {}),
        ...(options.reportPath ? { sourceReportPath: options.reportPath } : {})
      });
      await publishIndex();
      await updateTaskIndex(workspace, taskId, (index) => ({
        ...index,
        latestRunByBlock: {
          ...(index.latestRunByBlock ?? {}),
          [options.ref]: runId
        },
        counts: incrementTaskIndexCount(index, "runs")
      }));
      state.blocks[options.ref] =
        authority.kind === "remote"
          ? completeRemoteBlockOwnership({
              blockType: block.type,
              blockState: state.blocks[options.ref],
              ownership: authority.identity,
              runId
            })
          : {
              ...withoutRemoteBlockOwnership(state.blocks[options.ref], "completed"),
              lastRunId: runId
            };
      state.currentRefs = state.currentRefs.filter((ref) => ref !== options.ref);
      state = refreshDerivedState(manifest, state);
      await writeState(workspace.stateFile, state);
      return { ref: options.ref, runId, status: "completed" };
    });
  });
}
