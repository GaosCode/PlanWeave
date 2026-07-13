import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import {
  ArtifactReferenceVerificationError,
  readVerifiedArtifactReference
} from "../autoRun/artifactReferenceContract.js";
import { finalArtifactRelativePath } from "../autoRun/finalArtifactContract.js";
import {
  readRunnerRecordReadModel,
  desktopAgentPromptIdentitySchema,
  type DesktopAgentPromptIdentity,
  type RunnerRecordReadConsumer,
  type RunnerRecordReadSubscriber
} from "../autoRun/runnerRecordReadModel.js";
import type { RunnerEventCursor } from "../autoRun/runnerEventReplay.js";
import {
  artifactReferenceSchema,
  type ArtifactReference
} from "../autoRun/runnerContractSchemas.js";
import { optionalReadFile, optionalReaddir, optionalStat } from "../fs/optionalFile.js";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { readJsonFile } from "../json.js";
import { loadPackage } from "../package/loadPackage.js";
import { readState } from "../state.js";
import { reviewResultSchema } from "../taskManager/reviewResultContract.js";
import {
  type ExecutorIntegrationName,
  type PackageWorkspaceRef,
  type ProjectWorkspace,
  type ReviewVerdict
} from "../types.js";
import {
  acpPromptReadOptions,
  consumeAcpPromptRunRecord,
  continueAcpPrompt,
  queueLiveAcpPrompt,
  resolveAcpPromptContext
} from "./acpPromptApi.js";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import {
  desktopAgentPromptTextSchema
} from "./types/acpBridgeTypes.js";
import {
  cleanOutputSummary,
  displayMarkdownForRecord,
  outputSummaryForRecord
} from "./runRecordOutput.js";
import {
  feedbackRunRecordId,
  parseRunRecordId,
  runRecordId,
  type ParsedRunRecordId
} from "./runRecordIdentity.js";
import type {
  DesktopBlockRunRecordSummary,
  DesktopFeedbackRecord,
  DesktopReviewAttemptSummary,
  DesktopRunRecord
} from "./types.js";

async function exists(path: string): Promise<boolean> {
  return (await optionalStat(path)) !== null;
}

async function readOptionalFile(path: string): Promise<string> {
  return (await optionalReadFile(path, "utf8")) ?? "";
}

async function verifyRunArtifactMetadata(
  runDir: string,
  metadata: Record<string, unknown>,
  expectedKinds: ReadonlyArray<"implementation" | "review" | "feedback">
): Promise<{ kind: "legacy" } | { kind: "verified"; bytes: Buffer }> {
  if (metadata.artifactReference === undefined) {
    return { kind: "legacy" };
  }
  let verified: Awaited<ReturnType<typeof readVerifiedArtifactReference>>;
  try {
    verified = await readVerifiedArtifactReference({
      rootDir: runDir,
      value: metadata.artifactReference
    });
  } catch {
    throw new ArtifactReferenceVerificationError(
      "Persisted runner artifact is corrupt or no longer matches its verified bytes."
    );
  }
  const expectedPath = finalArtifactRelativePath(verified.reference.kind);
  if (
    !expectedKinds.includes(verified.reference.kind) ||
    verified.reference.relativePath !== expectedPath
  ) {
    throw new ArtifactReferenceVerificationError(
      "Persisted runner artifact is corrupt or no longer matches its verified bytes."
    );
  }
  return { kind: "verified", bytes: verified.bytes };
}

async function listDirectories(path: string): Promise<string[]> {
  const entries = await optionalReaddir(path, { withFileTypes: true });
  return (
    entries
      ?.filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort() ?? []
  );
}

function blockRunRoot(resultsDir: string, blockRef: string): string {
  const { taskId, blockId } = parseBlockRef(blockRef);
  return join(resultsDir, taskId, "blocks", blockId, "runs");
}

function feedbackRunRoot(resultsDir: string): string {
  return join(resultsDir, "feedback-runs");
}

function assertContainedPath(root: string, candidate: string): void {
  if (!isAbsolute(root) || !isAbsolute(candidate)) {
    throw new Error("ACP run record paths must be absolute.");
  }
  const nested = relative(resolve(root), resolve(candidate));
  if (nested === "" || (!nested.startsWith(`..${sep}`) && nested !== ".." && !isAbsolute(nested))) {
    return;
  }
  throw new Error("ACP run record path escapes the selected canvas results directory.");
}

function blockRunDirectory(
  workspace: ProjectWorkspace,
  parsed: Extract<ParsedRunRecordId, { kind: "block" }>
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(parsed.runId)) {
    throw new Error(`Run id '${parsed.runId}' is invalid.`);
  }
  const runRoot = blockRunRoot(workspace.resultsDir, parsed.blockRef);
  const runDir = join(runRoot, parsed.runId);
  assertContainedPath(workspace.resultsDir, runDir);
  return runDir;
}

async function assertRealRunDirectory(resultsDir: string, runDir: string): Promise<void> {
  const [realResultsDir, realRunDir] = await Promise.all([
    realpath(resultsDir),
    realpath(runDir)
  ]);
  assertContainedPath(realResultsDir, realRunDir);
}

function reviewAttemptRoot(resultsDir: string, blockRef: string): string {
  const { taskId, blockId } = parseBlockRef(blockRef);
  return join(resultsDir, taskId, "reviews", blockId, "attempts");
}

function stringField(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" ? value : null;
}

function firstStringField(metadata: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = stringField(metadata, key);
    if (value) {
      return value;
    }
  }
  return null;
}

function numberField(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key];
  return typeof value === "number" ? value : null;
}

async function fileUpdatedAt(path: string): Promise<string | null> {
  const stat = await optionalStat(path);
  return stat ? stat.mtime.toISOString() : null;
}

function latestTimestamp(...values: Array<string | null>): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const parsed = Date.parse(value ?? "");
    if (Number.isFinite(parsed) && parsed > latestMs) {
      latest = value;
      latestMs = parsed;
    }
  }
  return latest;
}

async function runFileUpdateTimes(
  runDir: string,
  metadataPath: string
): Promise<{
  stdoutUpdatedAt: string | null;
  stderrUpdatedAt: string | null;
  metadataUpdatedAt: string | null;
  heartbeatPath: string | null;
  heartbeatUpdatedAt: string | null;
  heartbeatStatus: string | null;
  heartbeatPid: number | null;
  lastHeartbeatAt: string | null;
  lastActivityAt: string | null;
  lastOutputAt: string | null;
}> {
  const stdoutUpdatedAt = await fileUpdatedAt(join(runDir, "stdout.md"));
  const stderrUpdatedAt = await fileUpdatedAt(join(runDir, "stderr.log"));
  const metadataUpdatedAt = await fileUpdatedAt(metadataPath);
  const heartbeatPath = join(runDir, "heartbeat.json");
  const heartbeatUpdatedAt = await fileUpdatedAt(heartbeatPath);
  const heartbeat: Record<string, unknown> = heartbeatUpdatedAt
    ? await readJsonFile<Record<string, unknown>>(heartbeatPath).catch(() => ({}))
    : {};
  const lastHeartbeatAt =
    typeof heartbeat.lastHeartbeatAt === "string" ? heartbeat.lastHeartbeatAt : null;
  return {
    stdoutUpdatedAt,
    stderrUpdatedAt,
    metadataUpdatedAt,
    heartbeatPath: heartbeatUpdatedAt ? heartbeatPath : null,
    heartbeatUpdatedAt,
    heartbeatStatus: typeof heartbeat.status === "string" ? heartbeat.status : null,
    heartbeatPid: typeof heartbeat.pid === "number" ? heartbeat.pid : null,
    lastHeartbeatAt,
    lastActivityAt: latestTimestamp(
      stdoutUpdatedAt,
      stderrUpdatedAt,
      lastHeartbeatAt,
      heartbeatUpdatedAt
    ),
    lastOutputAt: latestTimestamp(stdoutUpdatedAt, stderrUpdatedAt)
  };
}

function adapterField(metadata: Record<string, unknown>): ExecutorIntegrationName | null {
  const value = metadata.adapter;
  return value === "manual" ||
    value === "codex-exec" ||
    value === "opencode-exec" ||
    value === "claude-code-exec" ||
    value === "pi-exec" ||
    value === "local-review"
    ? value
    : null;
}

function runOrderValue(record: DesktopBlockRunRecordSummary): number {
  const timestamp = Date.parse(record.finishedAt ?? record.startedAt ?? "");
  if (Number.isFinite(timestamp)) {
    return timestamp;
  }
  const runNumber = /^RUN-(\d+)$/.exec(record.runId)?.[1];
  return runNumber ? Number.parseInt(runNumber, 10) : 0;
}

function compareRunRecordsNewestFirst(
  left: DesktopBlockRunRecordSummary,
  right: DesktopBlockRunRecordSummary
): number {
  const byTime = runOrderValue(right) - runOrderValue(left);
  if (byTime !== 0) {
    return byTime;
  }
  return right.runId.localeCompare(left.runId, undefined, { numeric: true });
}

function compareIdsNewestFirst(left: string, right: string): number {
  return right.localeCompare(left, undefined, { numeric: true });
}

function verdictField(value: unknown): ReviewVerdict | null {
  return value === "passed" || value === "needs_changes" ? value : null;
}

async function runRecordSummary(options: {
  resultsDir: string;
  blockRef: string;
  runId: string;
}): Promise<DesktopBlockRunRecordSummary> {
  const { taskId, blockId } = parseBlockRef(options.blockRef);
  const runDir = join(blockRunRoot(options.resultsDir, options.blockRef), options.runId);
  const metadataPath = join(runDir, "metadata.json");
  const metadata = (await exists(metadataPath))
    ? await readJsonFile<Record<string, unknown>>(metadataPath)
    : {};
  const adapter = adapterField(metadata);
  const stdout = await readOptionalFile(join(runDir, "stdout.md"));
  const stderr = await readOptionalFile(join(runDir, "stderr.log"));
  const promptPath = join(runDir, "prompt.md");
  const reportPath = join(runDir, finalArtifactRelativePath("implementation"));
  const updateTimes = await runFileUpdateTimes(runDir, metadataPath);
  return {
    recordId: runRecordId(options.blockRef, options.runId),
    kind: "block",
    ref: options.blockRef,
    taskId,
    blockId,
    runId: options.runId,
    executor: stringField(metadata, "executor"),
    adapter,
    executionCwd: stringField(metadata, "executionCwd"),
    projectRoot: stringField(metadata, "projectRoot"),
    agentSessionId: firstStringField(metadata, [
      "agentSessionId",
      "codexSessionId",
      "opencodeSessionId",
      "sessionId",
      "session_id",
      "threadId",
      "thread_id"
    ]),
    codexSessionId: stringField(metadata, "codexSessionId"),
    tmuxSessionId: firstStringField(metadata, ["tmuxSessionId", "tmuxSessionName"]),
    tmuxAttachCommand: stringField(metadata, "tmuxAttachCommand"),
    tmuxReadOnlyAttachCommand: stringField(metadata, "tmuxReadOnlyAttachCommand"),
    exitCode: numberField(metadata, "exitCode"),
    startedAt: stringField(metadata, "startedAt"),
    finishedAt: stringField(metadata, "finishedAt"),
    promptPath: (await exists(promptPath)) ? promptPath : null,
    reportPath: (await exists(reportPath)) ? reportPath : null,
    metadataPath,
    ...updateTimes,
    stdoutSummary: outputSummaryForRecord(adapter, stdout, ""),
    stderrSummary: cleanOutputSummary(stderr)
  };
}

async function feedbackRunRecordSummary(options: {
  resultsDir: string;
  feedbackId: string;
  runId: string;
}): Promise<DesktopBlockRunRecordSummary> {
  const runDir = join(feedbackRunRoot(options.resultsDir), options.runId);
  const metadataPath = join(runDir, "metadata.json");
  const metadata = (await exists(metadataPath))
    ? await readJsonFile<Record<string, unknown>>(metadataPath)
    : {};
  const feedbackId = stringField(metadata, "feedbackId") ?? options.feedbackId;
  if (feedbackId !== options.feedbackId) {
    throw new Error(
      `Run record id '${feedbackRunRecordId(options.feedbackId, options.runId)}' does not match feedback metadata '${feedbackId}'.`
    );
  }
  const sourceReviewBlockRef = stringField(metadata, "sourceReviewBlockRef");
  if (!sourceReviewBlockRef) {
    throw new Error(`Feedback run '${options.runId}' is missing sourceReviewBlockRef metadata.`);
  }
  const { taskId, blockId } = parseBlockRef(sourceReviewBlockRef);
  const adapter = adapterField(metadata);
  const stdout = await readOptionalFile(join(runDir, "stdout.md"));
  const stderr = await readOptionalFile(join(runDir, "stderr.log"));
  const promptPath = (await exists(join(runDir, "prompt.md")))
    ? join(runDir, "prompt.md")
    : join(runDir, "feedback.md");
  const reportPath = join(runDir, finalArtifactRelativePath("feedback"));
  const updateTimes = await runFileUpdateTimes(runDir, metadataPath);
  return {
    recordId: feedbackRunRecordId(feedbackId, options.runId),
    kind: "feedback",
    ref: sourceReviewBlockRef,
    feedbackId,
    sourceReviewBlockRef,
    taskId,
    blockId,
    runId: options.runId,
    executor: stringField(metadata, "executor"),
    adapter,
    executionCwd: stringField(metadata, "executionCwd"),
    projectRoot: stringField(metadata, "projectRoot"),
    agentSessionId: firstStringField(metadata, [
      "agentSessionId",
      "codexSessionId",
      "opencodeSessionId",
      "sessionId",
      "session_id",
      "threadId",
      "thread_id"
    ]),
    codexSessionId: stringField(metadata, "codexSessionId"),
    tmuxSessionId: firstStringField(metadata, ["tmuxSessionId", "tmuxSessionName"]),
    tmuxAttachCommand: stringField(metadata, "tmuxAttachCommand"),
    tmuxReadOnlyAttachCommand: stringField(metadata, "tmuxReadOnlyAttachCommand"),
    exitCode: numberField(metadata, "exitCode"),
    startedAt: stringField(metadata, "startedAt"),
    finishedAt: stringField(metadata, "finishedAt"),
    promptPath: (await exists(promptPath)) ? promptPath : null,
    reportPath: (await exists(reportPath)) ? reportPath : null,
    metadataPath,
    ...updateTimes,
    stdoutSummary: outputSummaryForRecord(adapter, stdout, ""),
    stderrSummary: cleanOutputSummary(stderr)
  };
}

async function feedbackRunRecordSummariesForBlock(
  resultsDir: string,
  blockRef: string
): Promise<DesktopBlockRunRecordSummary[]> {
  const runIds = await listDirectories(feedbackRunRoot(resultsDir));
  const records = await Promise.all(
    runIds.map(async (runId) => {
      const metadataPath = join(feedbackRunRoot(resultsDir), runId, "metadata.json");
      const metadata = (await exists(metadataPath))
        ? await readJsonFile<Record<string, unknown>>(metadataPath)
        : {};
      if (stringField(metadata, "sourceReviewBlockRef") !== blockRef) {
        return null;
      }
      const feedbackId = stringField(metadata, "feedbackId");
      return feedbackId ? feedbackRunRecordSummary({ resultsDir, feedbackId, runId }) : null;
    })
  );
  return records.filter((record): record is DesktopBlockRunRecordSummary => record !== null);
}

export async function listBlockRunRecords(
  projectRoot: PackageWorkspaceRef,
  blockRef: string
): Promise<DesktopBlockRunRecordSummary[]> {
  const { workspace } = await loadPackage(projectRoot);
  const runIds = await listDirectories(blockRunRoot(workspace.resultsDir, blockRef));
  const blockRecords = await Promise.all(
    runIds.map((runId) => runRecordSummary({ resultsDir: workspace.resultsDir, blockRef, runId }))
  );
  const feedbackRecords = await feedbackRunRecordSummariesForBlock(workspace.resultsDir, blockRef);
  return [...blockRecords, ...feedbackRecords].sort(compareRunRecordsNewestFirst);
}

export async function getRunRecord(
  projectRoot: PackageWorkspaceRef,
  recordId: string
): Promise<DesktopRunRecord> {
  const parsed = parseRunRecordId(recordId);
  const { workspace } = await loadPackage(projectRoot);
  const summary =
    parsed.kind === "block"
      ? await runRecordSummary({
          resultsDir: workspace.resultsDir,
          blockRef: parsed.blockRef,
          runId: parsed.runId
        })
      : await feedbackRunRecordSummary({
          resultsDir: workspace.resultsDir,
          feedbackId: parsed.feedbackId,
          runId: parsed.runId
        });
  const runDir =
    parsed.kind === "block"
      ? join(blockRunRoot(workspace.resultsDir, parsed.blockRef), parsed.runId)
      : join(feedbackRunRoot(workspace.resultsDir), parsed.runId);
  const metadata = (await exists(summary.metadataPath))
    ? await readJsonFile<Record<string, unknown>>(summary.metadataPath)
    : {};
  const artifact = await verifyRunArtifactMetadata(
    runDir,
    metadata,
    parsed.kind === "feedback" ? ["feedback"] : ["implementation", "review"]
  );
  const reportMarkdown =
    artifact.kind === "verified"
      ? artifact.bytes.toString("utf8")
      : await readOptionalFile(
          join(
            runDir,
            finalArtifactRelativePath(
              parsed.kind === "feedback" ? "feedback" : "implementation"
            )
          )
        );
  const stdout = await readOptionalFile(join(runDir, "stdout.md"));
  const stderr = await readOptionalFile(join(runDir, "stderr.log"));
  const promptMarkdown = summary.promptPath ? await readOptionalFile(summary.promptPath) : "";
  const display = displayMarkdownForRecord({
    adapter: adapterField({ adapter: summary.adapter }),
    reportMarkdown,
    stdout,
    stderr
  });
  const conversation = resolveAcpPromptContext({
    workspace,
    recordId,
    blockRef: parsed.kind === "block" ? parsed.blockRef : null,
    runId: parsed.kind === "block" ? parsed.runId : null,
    runDir: parsed.kind === "block" ? runDir : null,
    metadata
  });
  return {
    ...summary,
    promptMarkdown,
    reportMarkdown,
    ...display,
    metadata,
    runnerReadModel: await readRunnerRecordReadModel({
      runDir,
      metadata,
      ...acpPromptReadOptions(conversation)
    })
  };
}

export async function subscribeRunRecord(
  projectRoot: PackageWorkspaceRef,
  recordId: string,
  cursor: RunnerEventCursor | undefined,
  subscriber: RunnerRecordReadSubscriber
): Promise<RunnerRecordReadConsumer> {
  const parsed = parseRunRecordId(recordId);
  const { workspace } = await loadPackage(projectRoot);
  const runDir =
    parsed.kind === "block"
      ? join(blockRunRoot(workspace.resultsDir, parsed.blockRef), parsed.runId)
      : join(feedbackRunRoot(workspace.resultsDir), parsed.runId);
  const metadataPath = join(runDir, "metadata.json");
  const metadata = (await exists(metadataPath))
    ? await readJsonFile<Record<string, unknown>>(metadataPath)
    : {};
  const conversation = resolveAcpPromptContext({
    workspace,
    recordId,
    blockRef: parsed.kind === "block" ? parsed.blockRef : null,
    runId: parsed.kind === "block" ? parsed.runId : null,
    runDir: parsed.kind === "block" ? runDir : null,
    metadata
  });
  return consumeAcpPromptRunRecord({
    context: conversation,
    runDir,
    metadata,
    cursor,
    subscriber
  });
}

export async function sendAgentPrompt(
  rawIdentity: DesktopAgentPromptIdentity,
  rawText: string
): Promise<void> {
  const identity = desktopAgentPromptIdentitySchema.parse(rawIdentity);
  const text = desktopAgentPromptTextSchema.parse(rawText);
  const workspace = await resolveTaskCanvasWorkspace(
    identity.ref.projectRoot,
    identity.ref.canvasId
  );
  const parsed = parseRunRecordId(identity.recordId);
  if (parsed.kind !== "block") {
    throw new Error("ACP conversation turns are only available for block run records.");
  }
  const runDir = blockRunDirectory(workspace, parsed);
  await assertRealRunDirectory(workspace.resultsDir, runDir);
  const metadataPath = join(runDir, "metadata.json");
  const metadata = (await exists(metadataPath))
    ? await readJsonFile<Record<string, unknown>>(metadataPath)
    : {};
  const context = resolveAcpPromptContext({
    workspace,
    recordId: identity.recordId,
    blockRef: parsed.blockRef,
    runId: parsed.runId,
    runDir,
    metadata
  });
  if (!context.available) throw new Error(context.reason);
  const expected = context.identity;
  if (
    expected.ref.projectRoot !== identity.ref.projectRoot ||
    expected.ref.canvasId !== identity.ref.canvasId ||
    expected.recordId !== identity.recordId ||
    expected.executorRunId !== identity.executorRunId ||
    expected.claimRef !== identity.claimRef ||
    expected.sessionId !== identity.sessionId
  ) {
    throw new Error("ACP prompt identity does not match the selected persisted run record.");
  }
  if (context.mode === "live") {
    await queueLiveAcpPrompt({ context, text });
    return;
  }
  await continueAcpPrompt({ workspace, context, text });
}

export async function resolveRunRecordArtifactPath(
  projectRoot: PackageWorkspaceRef,
  recordId: string,
  value: ArtifactReference
): Promise<string> {
  const reference = artifactReferenceSchema.parse(value);
  const parsed = parseRunRecordId(recordId);
  const { workspace } = await loadPackage(projectRoot);
  const runDir =
    parsed.kind === "block"
      ? join(blockRunRoot(workspace.resultsDir, parsed.blockRef), parsed.runId)
      : join(feedbackRunRoot(workspace.resultsDir), parsed.runId);
  const verified = await readVerifiedArtifactReference({ rootDir: runDir, value: reference });
  return join(runDir, verified.reference.relativePath);
}

export async function getReviewAttempts(
  projectRoot: PackageWorkspaceRef,
  blockRef: string
): Promise<DesktopReviewAttemptSummary[]> {
  const { workspace } = await loadPackage(projectRoot);
  const { taskId, blockId } = parseBlockRef(blockRef);
  const attemptIds = (
    await listDirectories(reviewAttemptRoot(workspace.resultsDir, blockRef))
  ).sort(compareIdsNewestFirst);
  return Promise.all(
    attemptIds.map(async (attemptId) => {
      const attemptDir = join(reviewAttemptRoot(workspace.resultsDir, blockRef), attemptId);
      const resultPath = join(attemptDir, "review-result.json");
      const metadataPath = join(attemptDir, "metadata.json");
      const metadata = (await exists(metadataPath))
        ? await readJsonFile<Record<string, unknown>>(metadataPath)
        : {};
      const artifact = await verifyRunArtifactMetadata(attemptDir, metadata, ["review"]);
      let result: Record<string, unknown>;
      if (artifact.kind === "verified") {
        try {
          result = reviewResultSchema.parse(JSON.parse(artifact.bytes.toString("utf8")));
        } catch {
          throw new ArtifactReferenceVerificationError(
            "Persisted runner artifact is corrupt or no longer matches its verified bytes."
          );
        }
      } else {
        result = (await exists(resultPath))
          ? await readJsonFile<Record<string, unknown>>(resultPath)
          : {};
      }
      const content = typeof result.content === "string" ? result.content : "";
      return {
        ref: blockRef,
        taskId,
        blockId,
        attemptId,
        verdict: verdictField(result.verdict),
        resultPath,
        metadataPath,
        contentPreview: content.trim().slice(0, 400)
      };
    })
  );
}

export async function getFeedbackRecords(
  projectRoot: PackageWorkspaceRef,
  blockRef: string
): Promise<DesktopFeedbackRecord[]> {
  const { workspace } = await loadPackage(projectRoot);
  const state = await readState(workspace.stateFile);
  return Object.entries(state.feedback)
    .filter(([, feedback]) => feedback.sourceReviewBlockRef === blockRef)
    .sort(([leftId], [rightId]) => compareIdsNewestFirst(leftId, rightId))
    .map(([feedbackId, feedback]) => ({
      feedbackId,
      sourceReviewBlockRef: feedback.sourceReviewBlockRef,
      status: feedback.status,
      latestSubmissionId: feedback.latestSubmissionId,
      content: feedback.content
    }));
}
