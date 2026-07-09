import { createHash } from "node:crypto";
import { copyFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isNodeFileNotFoundError, optionalReaddir } from "../fs/optionalFile.js";
import { withCanvasLock } from "../fs/withCanvasLock.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { loadPackage } from "../package/loadPackage.js";
import { writeState } from "../state.js";
import type {
  ExecutionGraphSession,
  PackageWorkspaceRef,
  ProjectWorkspace,
  SubmitFeedbackResult
} from "../types.js";
import { patchFeedbackArtifact } from "./feedbackArtifacts.js";
import { loadRuntime, refreshDerivedState } from "./runtimeContext.js";
import { allocatePrefixedId, incrementTaskIndexCount, updateTaskIndex } from "./resultIndex.js";

function withCurrentRef(currentRefs: string[], ref: string): string[] {
  return currentRefs.includes(ref) ? currentRefs : [...currentRefs, ref];
}

function isNonMissingNodeFileError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && !isNodeFileNotFoundError(error)
  );
}

async function fileHash(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function feedbackSubmissionMatches(options: {
  submissionDir: string;
  feedbackId: string;
  submissionId: string;
  sourceReviewBlockRef: string;
  reportHash: string;
}): Promise<boolean> {
  try {
    const metadata = await readJsonFile<Record<string, unknown>>(
      join(options.submissionDir, "metadata.json")
    );
    if (
      metadata.feedbackId !== options.feedbackId ||
      metadata.submissionId !== options.submissionId ||
      metadata.sourceReviewBlockRef !== options.sourceReviewBlockRef
    ) {
      return false;
    }
    return (await fileHash(join(options.submissionDir, "report.md"))) === options.reportHash;
  } catch (error) {
    if (isNonMissingNodeFileError(error)) {
      throw error;
    }
    return false;
  }
}

async function findPersistedFeedbackSubmission(options: {
  submissionRoot: string;
  feedbackId: string;
  sourceReviewBlockRef: string;
  reportHash: string;
}): Promise<string | null> {
  const entries = await optionalReaddir(options.submissionRoot, { withFileTypes: true });
  if (!entries) {
    return null;
  }
  const submissionIds = entries
    .filter((entry) => entry.isDirectory() && /^FS-\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const submissionId of submissionIds) {
    if (
      await feedbackSubmissionMatches({
        submissionDir: join(options.submissionRoot, submissionId),
        feedbackId: options.feedbackId,
        submissionId,
        sourceReviewBlockRef: options.sourceReviewBlockRef,
        reportHash: options.reportHash
      })
    ) {
      return submissionId;
    }
  }
  return null;
}

async function recordFeedbackSubmissionIndexes(options: {
  workspace: ProjectWorkspace;
  taskId: string;
  feedbackId: string;
  submissionId: string;
  incrementCount: boolean;
}): Promise<void> {
  await updateTaskIndex(options.workspace, options.taskId, (index) => ({
    ...index,
    latestFeedbackSubmissionByFeedback: {
      ...(index.latestFeedbackSubmissionByFeedback ?? {}),
      [options.feedbackId]: options.submissionId
    },
    feedbackStatusById: {
      ...(index.feedbackStatusById ?? {}),
      [options.feedbackId]: "resolved"
    },
    counts: options.incrementCount
      ? incrementTaskIndexCount(index, "feedbackSubmissions")
      : index.counts
  }));
}

export async function submitFeedback(options: {
  projectRoot: PackageWorkspaceRef;
  reportPath: string;
  session?: ExecutionGraphSession;
}): Promise<SubmitFeedbackResult> {
  const reportHash = await fileHash(options.reportPath);
  const { workspace: lockWorkspace } = await loadPackage(options.projectRoot);
  return withCanvasLock(dirname(lockWorkspace.stateFile), async () => {
    const context = await loadRuntime(options);
    const { workspace, manifest, graph } = context;
    let { state } = context;
    const feedbackId = state.currentFeedbackId;
    if (!feedbackId || !state.feedback[feedbackId]) {
      throw new Error("submit-feedback requires an active feedback event.");
    }
    const feedback = state.feedback[feedbackId];
    const taskId = graph.blockTaskByRef.get(feedback.sourceReviewBlockRef);
    if (!taskId) {
      throw new Error(`Feedback '${feedbackId}' points to an unknown review block.`);
    }
    const submissionRoot = join(
      workspace.resultsDir,
      taskId,
      "feedback",
      feedbackId,
      "submissions"
    );
    const persistedSubmissionId = await findPersistedFeedbackSubmission({
      submissionRoot,
      feedbackId,
      sourceReviewBlockRef: feedback.sourceReviewBlockRef,
      reportHash
    });
    const submissionId = persistedSubmissionId ?? (await allocatePrefixedId(submissionRoot, "FS"));
    if (!persistedSubmissionId) {
      const submissionDir = join(submissionRoot, submissionId);
      await copyFile(options.reportPath, join(submissionDir, "report.md"));
      await writeJsonFile(join(submissionDir, "metadata.json"), {
        feedbackId,
        submissionId,
        sourceReviewBlockRef: feedback.sourceReviewBlockRef,
        reportHash,
        submittedAt: new Date().toISOString()
      });
    }
    await recordFeedbackSubmissionIndexes({
      workspace,
      taskId,
      feedbackId,
      submissionId,
      incrementCount: !persistedSubmissionId
    });
    await patchFeedbackArtifact(workspace, taskId, feedbackId, {
      status: "resolved",
      latestSubmissionId: submissionId,
      resolvedAt: new Date().toISOString()
    });
    state.feedback[feedbackId] = {
      ...feedback,
      status: "resolved",
      latestSubmissionId: submissionId
    };
    state.blocks[feedback.sourceReviewBlockRef] = {
      ...state.blocks[feedback.sourceReviewBlockRef],
      status: "in_progress",
      activeFeedbackId: null,
      pendingFeedbackId: feedbackId
    };
    state.currentFeedbackId = null;
    state.currentReviewBlockRef = feedback.sourceReviewBlockRef;
    state.currentRefs = withCurrentRef(state.currentRefs, feedback.sourceReviewBlockRef);
    state = refreshDerivedState(manifest, state);
    await writeState(workspace.stateFile, state);
    return {
      status: "accepted",
      nextCommand: "planweave claim-next",
      message: "Feedback submitted. Run `planweave claim-next` to continue the review loop.",
      feedbackId,
      submissionId
    };
  });
}
