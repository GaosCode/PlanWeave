import { resolveResultsPath } from "./resultPaths.js";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { NormalizedFailure } from "@planweave-ai/agent-host-protocol/browser";
import { materializeArtifactBytes } from "../autoRun/artifactReferenceContract.js";
import { AcpEventStore } from "../autoRun/acpEventStore.js";
import { withPreparedBlockRunIndex } from "../autoRun/blockRunIndex.js";
import { findAvailableRunId } from "../autoRun/executorShared.js";
import { remoteAcpEventBody } from "../autoRun/remoteAcpEventProjection.js";
import {
  acpCorrelationSchema,
  runnerIdentitySchema,
  runnerRunIdentitySchema,
  type ArtifactReference
} from "../autoRun/runnerContractSchemas.js";
import { isNodeFileNotFoundError, optionalReaddir } from "../fs/optionalFile.js";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { writeJsonFile } from "../json.js";
import type { ProjectWorkspace } from "../types.js";
import { readImplementationRunMetadataFile } from "./implementationRunMetadata.js";
import { incrementTaskIndexCount, updateTaskIndex } from "./resultIndex.js";
import type { ActiveRemoteOperationIdentity } from "./remoteOwnershipTransitions.js";
import type { RemoteBlockCompletionInput } from "./remoteBlockRuntimeContracts.js";

type RemoteAcpTranscript = NonNullable<RemoteBlockCompletionInput["transcript"]>;

async function findRunIdByExecutionAttempt(
  runRoot: string,
  executionAttemptId: string
): Promise<string | null> {
  const entries = await optionalReaddir(runRoot, { withFileTypes: true });
  if (!entries) {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^RUN-\d+$/.test(entry.name)) {
      continue;
    }
    try {
      const metadata = await readImplementationRunMetadataFile(
        await resolveResultsPath(runRoot, entry.name, "metadata.json")
      );
      if (metadata.executionAttemptId === executionAttemptId) {
        return entry.name;
      }
    } catch (error) {
      if (!isNodeFileNotFoundError(error)) {
        throw error;
      }
    }
  }
  return null;
}

export async function withRemoteReviewAcpConversationRun<T>(
  options: {
    workspace: ProjectWorkspace;
    ref: string;
    executionAttemptId: string;
    transcript: RemoteAcpTranscript;
  },
  action: (
    persist: (input: {
      reportBytes: Uint8Array;
      identity: ActiveRemoteOperationIdentity;
      reviewAttemptId: string;
    }) => Promise<string>
  ) => Promise<T>
): Promise<T> {
  const { taskId, blockId } = parseBlockRef(options.ref);
  const runRoot = await resolveResultsPath(
    options.workspace.resultsDir,
    taskId,
    "blocks",
    blockId,
    "runs"
  );
  await resolveResultsPath(options.workspace.resultsDir, taskId, "index.json");
  return withPreparedBlockRunIndex(runRoot, async (prepareIndex) => {
    const existingRunId = await findRunIdByExecutionAttempt(runRoot, options.executionAttemptId);
    if (existingRunId) {
      const publishIndex = await prepareIndex(existingRunId, { hasArtifact: true });
      return action(async () => {
        await publishIndex();
        return existingRunId;
      });
    }
    const runId = await findAvailableRunId(runRoot);
    const submittedAt = new Date().toISOString();
    const startedAt = remoteAcpStartTime(options.transcript, submittedAt);
    const publishIndex = await prepareIndex(runId, {
      metadata: { ref: options.ref, submittedAt, startedAt },
      hasArtifact: true
    });
    return action((input) =>
      persistRemoteReviewAcpConversationRun({
        ...input,
        ...options,
        runRoot,
        runId,
        startedAt,
        submittedAt,
        publishIndex
      })
    );
  });
}

async function persistRemoteReviewAcpConversationRun(options: {
  workspace: ProjectWorkspace;
  ref: string;
  transcript: RemoteAcpTranscript;
  reportBytes: Uint8Array;
  identity: ActiveRemoteOperationIdentity;
  reviewAttemptId: string;
  runRoot: string;
  runId: string;
  startedAt: string;
  submittedAt: string;
  publishIndex: () => Promise<void>;
}): Promise<string> {
  const { taskId, blockId } = parseBlockRef(options.ref);
  const { runRoot, runId } = options;
  const runDir = join(runRoot, runId);
  await mkdir(runDir, { recursive: false });
  const reportBytes = Buffer.from(options.reportBytes);
  const artifactReference = await materializeArtifactBytes({
    rootDir: runDir,
    relativePath: "review-result.json",
    kind: "review",
    content: reportBytes
  });
  const remoteTiming = await materializeRemoteAcpTranscript({
    workspace: options.workspace,
    ref: options.ref,
    runId,
    transcript: options.transcript,
    startedAt: options.startedAt,
    artifact: artifactReference
  });
  await writeJsonFile(join(runDir, "metadata.json"), {
    ref: options.ref,
    taskId,
    blockId,
    runId,
    submittedAt: options.submittedAt,
    reportHash: createHash("sha256").update(reportBytes).digest("hex"),
    artifactReference,
    reviewAttemptId: options.reviewAttemptId,
    claimRef: options.ref,
    projectId: options.workspace.id,
    canvasId: basename(dirname(options.workspace.packageDir)),
    executor: options.transcript.executor,
    adapter: "agent",
    agentId: options.transcript.agentId,
    runnerKind: "acp",
    executorRunId: runId,
    runSessionId: null,
    desktopRunId: null,
    sessionId: options.transcript.sessionId,
    agentSessionId: options.transcript.sessionId,
    status: "completed",
    startedAt: remoteTiming.startedAt,
    finishedAt: remoteTiming.finishedAt,
    exitCode: 0,
    operationId: options.identity.operationId,
    dispatchId: options.identity.dispatchId,
    executionAttemptId: options.identity.executionAttemptId
  });
  await options.publishIndex();
  await updateTaskIndex(options.workspace, taskId, (index) => ({
    ...index,
    latestRunByBlock: {
      ...(index.latestRunByBlock ?? {}),
      [options.ref]: runId
    },
    counts: incrementTaskIndexCount(index, "runs")
  }));
  return runId;
}

export async function assertRemoteAcpTranscriptPaths(runDir: string): Promise<void> {
  await Promise.all([
    resolveResultsPath(runDir, "events.ndjson"),
    resolveResultsPath(runDir, "protocol.ndjson"),
    resolveResultsPath(runDir, "conversation.json"),
    resolveResultsPath(runDir, "conversation.md")
  ]);
}

export function remoteAcpStartTime(transcript: RemoteAcpTranscript, submittedAt: string): string {
  return transcript.events[0]?.timestamp ?? submittedAt;
}

export async function materializeRemoteAcpTranscript(options: {
  workspace: ProjectWorkspace;
  ref: string;
  runId: string;
  transcript: RemoteAcpTranscript;
  startedAt: string;
  artifact: ArtifactReference;
}): Promise<{ startedAt: string; finishedAt: string }> {
  const { taskId, blockId } = parseBlockRef(options.ref);
  const runDir = await resolveResultsPath(
    options.workspace.resultsDir,
    taskId,
    "blocks",
    blockId,
    "runs",
    options.runId
  );
  const firstTimestamp = options.startedAt;
  const finishedAt = new Date().toISOString();
  const correlation = acpCorrelationSchema.parse({ sessionId: options.transcript.sessionId });
  await assertRemoteAcpTranscriptPaths(runDir);
  const store = new AcpEventStore({
    runDir,
    identity: runnerRunIdentitySchema.parse({
      projectId: options.workspace.id,
      canvasId: basename(dirname(options.workspace.packageDir)),
      taskId,
      blockId,
      claimRef: options.ref,
      runId: options.runId,
      runOwner: "executor",
      runSessionId: null,
      desktopRunId: null,
      executorRunId: options.runId
    }),
    runner: runnerIdentitySchema.parse({
      version: "planweave.runner/v1",
      runnerKind: "acp",
      agentId: options.transcript.agentId
    })
  });
  await store.open();
  await store.appendObserved(
    { kind: "lifecycle", state: "running", message: "Remote ACP run observed." },
    correlation,
    firstTimestamp
  );
  const seenToolCalls = new Set<string>();
  for (const item of options.transcript.events) {
    await store.appendObserved(
      remoteAcpEventBody(item.event, seenToolCalls),
      correlation,
      item.timestamp
    );
  }
  await store.appendObserved(
    { kind: "artifact", artifact: options.artifact },
    correlation,
    finishedAt
  );
  await store.appendObserved(
    {
      kind: "terminal",
      outcome: {
        version: "planweave.runner/v1",
        state: "succeeded",
        reason: "completed",
        cleanup: { status: "succeeded" },
        exitCode: 0,
        finishedAt,
        diagnostic: null,
        artifactValidated: true,
        nextActions: { version: "planweave.runner-next-actions/v1", actions: [] }
      }
    },
    correlation,
    finishedAt
  );
  await store.drain();
  return { startedAt: firstTimestamp, finishedAt };
}

/**
 * Persist a failed remote attempt as a normal Task Workspace run so the left timeline and
 * conversation no longer stick to an older local Auto Run record after remote failure.
 */
export async function materializeRemoteAcpFailure(options: {
  workspace: ProjectWorkspace;
  ref: string;
  runId: string;
  failure: NormalizedFailure;
  startedAt: string;
  identity: ActiveRemoteOperationIdentity;
  agentId?: string;
}): Promise<{ startedAt: string; finishedAt: string }> {
  const { taskId, blockId } = parseBlockRef(options.ref);
  const runDir = await resolveResultsPath(
    options.workspace.resultsDir,
    taskId,
    "blocks",
    blockId,
    "runs",
    options.runId
  );
  const startedAt = options.startedAt;
  const finishedAt = startedAt;
  const correlation = acpCorrelationSchema.parse({
    sessionId: `remote-failed:${options.identity.executionAttemptId}`
  });
  // Prefer the Server-provided endpoint agent; only fall back when callers omit it (legacy tests).
  const agentId = options.agentId ?? "codex";
  await assertRemoteAcpTranscriptPaths(runDir);
  const store = new AcpEventStore({
    runDir,
    identity: runnerRunIdentitySchema.parse({
      projectId: options.workspace.id,
      canvasId: basename(dirname(options.workspace.packageDir)),
      taskId,
      blockId,
      claimRef: options.ref,
      runId: options.runId,
      runOwner: "executor",
      runSessionId: null,
      desktopRunId: null,
      executorRunId: options.runId
    }),
    runner: runnerIdentitySchema.parse({
      version: "planweave.runner/v1",
      runnerKind: "acp",
      agentId
    })
  });
  await store.open();
  await store.appendObserved(
    { kind: "lifecycle", state: "running", message: "Remote ACP run observed." },
    correlation,
    startedAt
  );
  await store.appendObserved(
    remoteAcpEventBody(
      {
        cursor: 1,
        kind: "diagnostic",
        severity: "error",
        message: `[${options.failure.code}] ${options.failure.message}`
      },
      new Set()
    ),
    correlation,
    finishedAt
  );
  await store.appendObserved(
    {
      kind: "terminal",
      outcome: {
        version: "planweave.runner/v1",
        state: "failed",
        reason: "failed",
        cleanup: { status: "succeeded" },
        exitCode: 1,
        finishedAt,
        diagnostic: `[${options.failure.code}] ${options.failure.message}`,
        artifactValidated: false,
        nextActions: { version: "planweave.runner-next-actions/v1", actions: [] }
      }
    },
    correlation,
    finishedAt
  );
  await store.drain();
  await writeJsonFile(await resolveResultsPath(runDir, "metadata.json"), {
    ref: options.ref,
    taskId,
    blockId,
    runId: options.runId,
    submittedAt: finishedAt,
    claimRef: options.ref,
    projectId: options.workspace.id,
    canvasId: basename(dirname(options.workspace.packageDir)),
    executor: agentId,
    adapter: "agent",
    agentId,
    runnerKind: "acp",
    executorRunId: options.runId,
    runSessionId: null,
    desktopRunId: null,
    sessionId: correlation.sessionId,
    agentSessionId: correlation.sessionId,
    status: "failed",
    startedAt,
    finishedAt,
    exitCode: 1,
    failureCode: options.failure.code,
    failureMessage: options.failure.message,
    operationId: options.identity.operationId,
    dispatchId: options.identity.dispatchId,
    executionAttemptId: options.identity.executionAttemptId
  });
  return { startedAt, finishedAt };
}
