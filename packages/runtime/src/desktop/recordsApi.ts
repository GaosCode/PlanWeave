import { constants } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { readJsonFile } from "../json.js";
import { loadPackage } from "../package/loadPackage.js";
import { readState } from "../state.js";
import type { ExecutorProfile, ReviewVerdict } from "../types.js";
import type {
  DesktopBlockRunRecordSummary,
  DesktopFeedbackRecord,
  DesktopReviewAttemptSummary,
  DesktopRunRecord
} from "./types.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalFile(path: string): Promise<string> {
  return (await exists(path)) ? readFile(path, "utf8") : "";
}

async function listDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function blockRunRoot(resultsDir: string, blockRef: string): string {
  const { taskId, blockId } = parseBlockRef(blockRef);
  return join(resultsDir, taskId, "blocks", blockId, "runs");
}

function runRecordId(blockRef: string, runId: string): string {
  return `${blockRef}::${runId}`;
}

function parseRunRecordId(recordId: string): { blockRef: string; runId: string } {
  const [blockRef, runId, extra] = recordId.split("::");
  if (!blockRef || !runId || extra !== undefined) {
    throw new Error(`Run record id '${recordId}' is invalid.`);
  }
  parseBlockRef(blockRef);
  return { blockRef, runId };
}

function reviewAttemptRoot(resultsDir: string, blockRef: string): string {
  const { taskId, blockId } = parseBlockRef(blockRef);
  return join(resultsDir, taskId, "reviews", blockId, "attempts");
}

function stringField(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" ? value : null;
}

function numberField(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key];
  return typeof value === "number" ? value : null;
}

function adapterField(metadata: Record<string, unknown>): ExecutorProfile["adapter"] | null {
  const value = metadata.adapter;
  return value === "manual" || value === "codex-exec" ? value : null;
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
  const metadata = (await exists(metadataPath)) ? await readJsonFile<Record<string, unknown>>(metadataPath) : {};
  const promptPath = join(runDir, "prompt.md");
  const reportPath = join(runDir, "report.md");
  return {
    recordId: runRecordId(options.blockRef, options.runId),
    ref: options.blockRef,
    taskId,
    blockId,
    runId: options.runId,
    executor: stringField(metadata, "executor"),
    adapter: adapterField(metadata),
    exitCode: numberField(metadata, "exitCode"),
    startedAt: stringField(metadata, "startedAt"),
    finishedAt: stringField(metadata, "finishedAt"),
    promptPath: (await exists(promptPath)) ? promptPath : null,
    reportPath: (await exists(reportPath)) ? reportPath : null,
    metadataPath,
    stdoutSummary: (await readOptionalFile(join(runDir, "stdout.md"))).trim().slice(0, 400),
    stderrSummary: (await readOptionalFile(join(runDir, "stderr.log"))).trim().slice(0, 400)
  };
}

export async function listBlockRunRecords(projectRoot: string, blockRef: string): Promise<DesktopBlockRunRecordSummary[]> {
  const { workspace } = await loadPackage(projectRoot);
  const runIds = await listDirectories(blockRunRoot(workspace.resultsDir, blockRef));
  return Promise.all(runIds.map((runId) => runRecordSummary({ resultsDir: workspace.resultsDir, blockRef, runId })));
}

export async function getRunRecord(projectRoot: string, recordId: string): Promise<DesktopRunRecord> {
  const { blockRef, runId } = parseRunRecordId(recordId);
  const { workspace } = await loadPackage(projectRoot);
  const summary = await runRecordSummary({ resultsDir: workspace.resultsDir, blockRef, runId });
  const runDir = join(blockRunRoot(workspace.resultsDir, blockRef), runId);
  const metadata = (await exists(summary.metadataPath)) ? await readJsonFile<Record<string, unknown>>(summary.metadataPath) : {};
  return {
    ...summary,
    promptMarkdown: await readOptionalFile(join(runDir, "prompt.md")),
    reportMarkdown: await readOptionalFile(join(runDir, "report.md")),
    metadata
  };
}

export async function getReviewAttempts(projectRoot: string, blockRef: string): Promise<DesktopReviewAttemptSummary[]> {
  const { workspace } = await loadPackage(projectRoot);
  const { taskId, blockId } = parseBlockRef(blockRef);
  const attemptIds = await listDirectories(reviewAttemptRoot(workspace.resultsDir, blockRef));
  return Promise.all(
    attemptIds.map(async (attemptId) => {
      const attemptDir = join(reviewAttemptRoot(workspace.resultsDir, blockRef), attemptId);
      const resultPath = join(attemptDir, "review-result.json");
      const metadataPath = join(attemptDir, "metadata.json");
      const result = (await exists(resultPath)) ? await readJsonFile<Record<string, unknown>>(resultPath) : {};
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

export async function getFeedbackRecords(projectRoot: string, blockRef: string): Promise<DesktopFeedbackRecord[]> {
  const { workspace } = await loadPackage(projectRoot);
  const state = await readState(workspace.stateFile);
  return Object.entries(state.feedback)
    .filter(([, feedback]) => feedback.sourceReviewBlockRef === blockRef)
    .map(([feedbackId, feedback]) => ({
      feedbackId,
      sourceReviewBlockRef: feedback.sourceReviewBlockRef,
      status: feedback.status,
      latestSubmissionId: feedback.latestSubmissionId,
      content: feedback.content
    }));
}
