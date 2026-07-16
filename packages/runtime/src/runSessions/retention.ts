/**
 * Run-session / results retention (prune) contract.
 *
 * ## Prunable set
 * Terminal historical artifacts under the canvas `resultsDir` only:
 * - run sessions: `results/run-sessions/SESSION-*` with phase in
 *   `completed | failed | stopped`
 * - implementation runs: `results/<task>/blocks/<block>/runs/RUN-*`
 * - review attempts: `results/<task>/reviews/<block>/attempts/REV-*`
 * - feedback submissions: `results/<task>/feedback/<feId>/submissions/FS-*`
 *
 * ## Never-delete set
 * - In-flight sessions (`created | resetting | running | manual | blocked`)
 * - Any path referenced by `state.json`:
 *   - `blocks[*].lastRunId`, `latestReviewAttemptId`
 *   - `blocks[*].activeFeedbackId` / `pendingFeedbackId` (all submissions under that FE)
 *   - `feedback[*].latestSubmissionId`
 *   - `currentRefs`, `currentFeedbackId`, `currentReviewBlockRef`
 * - Any path referenced by per-task `index.json`:
 *   - `latestRunByBlock`, `latestReviewAttemptByBlock`,
 *     `latestFeedbackSubmissionByFeedback`
 * - Blocks with status `in_progress | blocked | diverged | needs_changes`
 *   (all runs / review attempts under that block)
 * - Lexicographically latest id under each run/review/submission container
 *   (floor so "latest per block/session container" always survives)
 * - Index files, `feedback.json`, package, state, auto-runs, feedback-runs,
 *   or anything outside `resultsDir`
 *
 * ## Selection rules (combinable; intersection when both given)
 * - `--older-than <duration>`: duration is `<int><d|h|m|s>` (e.g. `30d`, `12h`).
 *   Age comes from session `finishedAt ?? startedAt`, artifact metadata timestamps
 *   (`submittedAt` / `reviewedAt`), else directory mtime.
 * - `--keep-last <n>`: keep the newest `n` terminal items per container
 *   (sessions: canvas-global; runs/reviews: per block; submissions: per feedback id).
 * - At least one of `olderThan` / `keepLast` is required. There is **no** implicit
 *   default age or keep-last (avoids destructive defaults).
 *
 * ## Product decisions (resolved for this plan)
 * - Reviews and feedback submissions prune with the same rules as runs; only
 *   superseded historical dirs are candidates. Feedback envelope dirs are not removed.
 * - No scheduled/automatic prune; operator-driven only.
 *
 * ## Safety gate
 * - `computePrunePlan` never deletes; returns the exact would-delete set + reason per item.
 * - `applyPrunePlan` requires a non-empty `reason`, holds `withCanvasLock`, re-computes
 *   the referenced set immediately before deletion, and only removes paths that are
 *   still in the plan, still unreferenced, and path-contained under known artifact patterns.
 * - CLI: without `--force` always dry-run; real deletion requires `--force --reason`.
 *
 * ## Doctor
 * Non-fatal warning `retention_threshold_exceeded` when total artifact count
 * (sessions + runs + review attempts + feedback submissions) exceeds
 * {@link RETENTION_DOCTOR_THRESHOLD}.
 */

import { rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { optionalReaddir, optionalStat } from "../fs/optionalFile.js";
import { withCanvasLock } from "../fs/withCanvasLock.js";
import { readJsonFile } from "../json.js";
import { loadPackage, resolvePackageWorkspace } from "../package/loadPackage.js";
import { readState } from "../state.js";
import { readTaskIndex } from "../taskManager/resultIndex.js";
import type {
  BlockStatus,
  PackageWorkspaceRef,
  ProjectWorkspace,
  RuntimeState,
  TaskResultIndex
} from "../types.js";
import { listRunSessions } from "./repository.js";
import { removeBlockRunFromIndex } from "../autoRun/blockRunIndex.js";
import type { RunSessionPhase, RunSessionState } from "./types.js";

export const RETENTION_DOCTOR_THRESHOLD = 200;

const terminalSessionPhases = new Set<RunSessionPhase>(["completed", "failed", "stopped"]);
const protectedBlockStatuses = new Set<BlockStatus>([
  "in_progress",
  "blocked",
  "diverged",
  "needs_changes"
]);

const sessionIdPattern = /^SESSION-\d+$/;
const runIdPattern = /^RUN-\d+$/;
const reviewIdPattern = /^REV-\d+$/;
const feedbackSubmissionIdPattern = /^FS-\d+$/;
const durationPattern = /^(\d+)(d|h|m|s)$/i;

export type PrunePlanItemKind = "session" | "run" | "review_attempt" | "feedback_submission";

export type PrunePlanItem = {
  kind: PrunePlanItemKind;
  path: string;
  id: string;
  reason: string;
  taskId?: string;
  blockId?: string;
  ref?: string;
  feedbackId?: string;
  ageMs?: number;
  timestamp?: string | null;
};

export type ComputePrunePlanOptions = {
  olderThan?: string;
  keepLast?: number;
  now?: Date;
};

export type PrunePlan = {
  items: PrunePlanItem[];
  excludedCount: number;
  options: {
    olderThanMs: number | null;
    keepLast: number | null;
    cutoffIso: string | null;
    nowIso: string;
  };
  totals: {
    sessions: number;
    runs: number;
    reviewAttempts: number;
    feedbackSubmissions: number;
  };
};

export type ApplyPrunePlanResult = {
  deleted: PrunePlanItem[];
  skipped: Array<PrunePlanItem & { skipReason: string }>;
  reason: string;
};

type ArtifactCandidate = {
  kind: PrunePlanItemKind;
  path: string;
  id: string;
  containerKey: string;
  taskId?: string;
  blockId?: string;
  ref?: string;
  feedbackId?: string;
  timestampMs: number;
  timestamp: string | null;
  protected: boolean;
  protectReason?: string;
};

function parseDurationToMs(value: string): number {
  const match = durationPattern.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid duration '${value}'. Expected format like 30d, 12h, 45m, or 90s.`);
  }
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`Invalid duration amount in '${value}'.`);
  }
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * multipliers[unit];
}

function resolvePruneFilters(options: ComputePrunePlanOptions): {
  olderThanMs: number | null;
  keepLast: number | null;
  now: Date;
} {
  const olderThanMs = options.olderThan === undefined ? null : parseDurationToMs(options.olderThan);
  const keepLast = options.keepLast === undefined ? null : options.keepLast;
  if (olderThanMs === null && keepLast === null) {
    throw new Error("Prune requires at least one of olderThan or keepLast.");
  }
  if (keepLast !== null && (!Number.isInteger(keepLast) || keepLast < 0)) {
    throw new Error(`keepLast must be a non-negative integer, got ${String(options.keepLast)}.`);
  }
  return { olderThanMs, keepLast, now: options.now ?? new Date() };
}

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

export function isPathInsideResultsDir(resultsDir: string, targetPath: string): boolean {
  const root = resolve(resultsDir);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function isPrunableArtifactPath(resultsDir: string, targetPath: string): boolean {
  if (!isPathInsideResultsDir(resultsDir, targetPath)) {
    return false;
  }
  const rel = toPosix(relative(resolve(resultsDir), resolve(targetPath)));
  return (
    /^run-sessions\/SESSION-\d+$/.test(rel) ||
    /^[^/]+\/blocks\/[^/]+\/runs\/RUN-\d+$/.test(rel) ||
    /^[^/]+\/reviews\/[^/]+\/attempts\/REV-\d+$/.test(rel) ||
    /^[^/]+\/feedback\/[^/]+\/submissions\/FS-\d+$/.test(rel)
  );
}

async function readTimestampMs(
  dirPath: string,
  metadataKeys: string[]
): Promise<{ timestampMs: number; timestamp: string | null }> {
  const metadataPath = join(dirPath, "metadata.json");
  try {
    if (await optionalStat(metadataPath)) {
      const metadata = await readJsonFile<Record<string, unknown>>(metadataPath);
      for (const key of metadataKeys) {
        const value = metadata[key];
        if (typeof value === "string") {
          const parsed = Date.parse(value);
          if (!Number.isNaN(parsed)) {
            return { timestampMs: parsed, timestamp: value };
          }
        }
      }
    }
  } catch {
    // fall through to mtime
  }
  const stats = await optionalStat(dirPath);
  if (stats) {
    return { timestampMs: stats.mtimeMs, timestamp: new Date(stats.mtimeMs).toISOString() };
  }
  return { timestampMs: 0, timestamp: null };
}

async function listPrefixedDirs(root: string, pattern: RegExp): Promise<string[]> {
  const entries = await optionalReaddir(root, { withFileTypes: true });
  if (!entries) {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function protectedPathsFromState(
  workspace: ProjectWorkspace,
  state: RuntimeState
): Map<string, string> {
  const protectedPaths = new Map<string, string>();
  const protect = (path: string, reason: string) => {
    if (isPathInsideResultsDir(workspace.resultsDir, path)) {
      protectedPaths.set(resolve(path), reason);
    }
  };

  const protectRun = (taskId: string, blockId: string, runId: string, reason: string) => {
    protect(join(workspace.resultsDir, taskId, "blocks", blockId, "runs", runId), reason);
  };
  const protectReview = (taskId: string, blockId: string, attemptId: string, reason: string) => {
    protect(join(workspace.resultsDir, taskId, "reviews", blockId, "attempts", attemptId), reason);
  };
  const protectSubmission = (
    taskId: string,
    feedbackId: string,
    submissionId: string,
    reason: string
  ) => {
    protect(
      join(workspace.resultsDir, taskId, "feedback", feedbackId, "submissions", submissionId),
      reason
    );
  };

  for (const [ref, block] of Object.entries(state.blocks ?? {})) {
    const [taskId, blockId] = ref.split("#");
    if (!taskId || !blockId) {
      continue;
    }
    if (block.lastRunId) {
      protectRun(taskId, blockId, block.lastRunId, `state lastRunId for ${ref}`);
    }
    if (block.latestReviewAttemptId) {
      protectReview(
        taskId,
        blockId,
        block.latestReviewAttemptId,
        `state latestReviewAttemptId for ${ref}`
      );
    }
    if (protectedBlockStatuses.has(block.status)) {
      protectedPaths.set(`block-status:${ref}`, `block status ${block.status}`);
    }
    for (const feedbackId of [block.activeFeedbackId, block.pendingFeedbackId]) {
      if (feedbackId) {
        protectedPaths.set(`feedback-envelope:${feedbackId}`, `active/pending feedback for ${ref}`);
      }
    }
  }

  for (const ref of state.currentRefs ?? []) {
    protectedPaths.set(`block-status:${ref}`, `currentRefs includes ${ref}`);
  }
  if (state.currentReviewBlockRef) {
    protectedPaths.set(`block-status:${state.currentReviewBlockRef}`, "currentReviewBlockRef");
  }
  if (state.currentFeedbackId) {
    protectedPaths.set(`feedback-envelope:${state.currentFeedbackId}`, "currentFeedbackId");
  }

  for (const [feedbackId, feedback] of Object.entries(state.feedback ?? {})) {
    const sourceRef = feedback.sourceReviewBlockRef;
    const taskId = sourceRef?.split("#")[0];
    if (feedback.latestSubmissionId && taskId) {
      protectSubmission(
        taskId,
        feedbackId,
        feedback.latestSubmissionId,
        `state feedback latestSubmissionId for ${feedbackId}`
      );
    }
    if (feedback.status === "open" || feedback.status === "in_progress") {
      protectedPaths.set(`feedback-envelope:${feedbackId}`, `feedback status ${feedback.status}`);
    }
  }

  return protectedPaths;
}

function protectedPathsFromIndex(
  workspace: ProjectWorkspace,
  taskId: string,
  index: TaskResultIndex
): Map<string, string> {
  const protectedPaths = new Map<string, string>();
  const protect = (path: string, reason: string) => {
    protectedPaths.set(resolve(path), reason);
  };

  for (const [ref, runId] of Object.entries(index.latestRunByBlock ?? {})) {
    const blockId = ref.split("#")[1];
    if (!blockId || !runId) {
      continue;
    }
    protect(
      join(workspace.resultsDir, taskId, "blocks", blockId, "runs", runId),
      `index latestRunByBlock for ${ref}`
    );
  }
  for (const [ref, attemptId] of Object.entries(index.latestReviewAttemptByBlock ?? {})) {
    const blockId = ref.split("#")[1];
    if (!blockId || !attemptId) {
      continue;
    }
    protect(
      join(workspace.resultsDir, taskId, "reviews", blockId, "attempts", attemptId),
      `index latestReviewAttemptByBlock for ${ref}`
    );
  }
  for (const [feedbackId, submissionId] of Object.entries(
    index.latestFeedbackSubmissionByFeedback ?? {}
  )) {
    if (!submissionId) {
      continue;
    }
    protect(
      join(workspace.resultsDir, taskId, "feedback", feedbackId, "submissions", submissionId),
      `index latestFeedbackSubmissionByFeedback for ${feedbackId}`
    );
  }
  return protectedPaths;
}

function isCandidateProtected(
  candidate: ArtifactCandidate,
  protectedPaths: Map<string, string>
): { protected: boolean; reason?: string } {
  const direct = protectedPaths.get(resolve(candidate.path));
  if (direct) {
    return { protected: true, reason: direct };
  }
  if (candidate.ref) {
    const blockStatus = protectedPaths.get(`block-status:${candidate.ref}`);
    if (blockStatus && (candidate.kind === "run" || candidate.kind === "review_attempt")) {
      return { protected: true, reason: blockStatus };
    }
  }
  if (candidate.feedbackId) {
    const envelope = protectedPaths.get(`feedback-envelope:${candidate.feedbackId}`);
    if (envelope && candidate.kind === "feedback_submission") {
      return { protected: true, reason: envelope };
    }
  }
  return { protected: false };
}

async function collectSessionCandidates(
  workspace: ProjectWorkspace,
  sessions: RunSessionState[],
  protectedPaths: Map<string, string>
): Promise<ArtifactCandidate[]> {
  const candidates: ArtifactCandidate[] = [];
  for (const session of sessions) {
    const path = join(workspace.resultsDir, "run-sessions", session.sessionId);
    const timestamp = session.finishedAt ?? session.startedAt;
    const timestampMs = Date.parse(timestamp);
    const inFlight = !terminalSessionPhases.has(session.phase);
    const candidate: ArtifactCandidate = {
      kind: "session",
      path,
      id: session.sessionId,
      containerKey: "sessions",
      timestampMs: Number.isNaN(timestampMs) ? 0 : timestampMs,
      timestamp,
      protected: false
    };
    if (inFlight) {
      candidate.protected = true;
      candidate.protectReason = `in-flight session phase ${session.phase}`;
    } else {
      const check = isCandidateProtected(candidate, protectedPaths);
      candidate.protected = check.protected;
      candidate.protectReason = check.reason;
    }
    candidates.push(candidate);
  }
  return candidates;
}

async function collectRunCandidates(
  workspace: ProjectWorkspace,
  taskId: string,
  protectedPaths: Map<string, string>
): Promise<ArtifactCandidate[]> {
  const candidates: ArtifactCandidate[] = [];
  const blocksRoot = join(workspace.resultsDir, taskId, "blocks");
  const blockEntries = await optionalReaddir(blocksRoot, { withFileTypes: true });
  if (!blockEntries) {
    return candidates;
  }
  for (const blockEntry of blockEntries.filter((entry) => entry.isDirectory())) {
    const blockId = blockEntry.name;
    const ref = `${taskId}#${blockId}`;
    const runRoot = join(blocksRoot, blockId, "runs");
    const runIds = await listPrefixedDirs(runRoot, runIdPattern);
    const latestId = runIds[runIds.length - 1];
    for (const runId of runIds) {
      const path = join(runRoot, runId);
      const { timestampMs, timestamp } = await readTimestampMs(path, [
        "submittedAt",
        "finishedAt",
        "startedAt"
      ]);
      const candidate: ArtifactCandidate = {
        kind: "run",
        path,
        id: runId,
        containerKey: `run:${ref}`,
        taskId,
        blockId,
        ref,
        timestampMs,
        timestamp,
        protected: false
      };
      if (runId === latestId) {
        candidate.protected = true;
        candidate.protectReason = `latest run under ${ref}`;
      } else {
        const check = isCandidateProtected(candidate, protectedPaths);
        candidate.protected = check.protected;
        candidate.protectReason = check.reason;
      }
      candidates.push(candidate);
    }
  }
  return candidates;
}

async function collectReviewCandidates(
  workspace: ProjectWorkspace,
  taskId: string,
  protectedPaths: Map<string, string>
): Promise<ArtifactCandidate[]> {
  const candidates: ArtifactCandidate[] = [];
  const reviewsRoot = join(workspace.resultsDir, taskId, "reviews");
  const reviewEntries = await optionalReaddir(reviewsRoot, { withFileTypes: true });
  if (!reviewEntries) {
    return candidates;
  }
  for (const reviewEntry of reviewEntries.filter((entry) => entry.isDirectory())) {
    const blockId = reviewEntry.name;
    const ref = `${taskId}#${blockId}`;
    const attemptRoot = join(reviewsRoot, blockId, "attempts");
    const attemptIds = await listPrefixedDirs(attemptRoot, reviewIdPattern);
    const latestId = attemptIds[attemptIds.length - 1];
    for (const attemptId of attemptIds) {
      const path = join(attemptRoot, attemptId);
      const { timestampMs, timestamp } = await readTimestampMs(path, ["reviewedAt", "submittedAt"]);
      const candidate: ArtifactCandidate = {
        kind: "review_attempt",
        path,
        id: attemptId,
        containerKey: `review:${ref}`,
        taskId,
        blockId,
        ref,
        timestampMs,
        timestamp,
        protected: false
      };
      if (attemptId === latestId) {
        candidate.protected = true;
        candidate.protectReason = `latest review attempt under ${ref}`;
      } else {
        const check = isCandidateProtected(candidate, protectedPaths);
        candidate.protected = check.protected;
        candidate.protectReason = check.reason;
      }
      candidates.push(candidate);
    }
  }
  return candidates;
}

async function collectFeedbackSubmissionCandidates(
  workspace: ProjectWorkspace,
  taskId: string,
  protectedPaths: Map<string, string>
): Promise<ArtifactCandidate[]> {
  const candidates: ArtifactCandidate[] = [];
  const feedbackRoot = join(workspace.resultsDir, taskId, "feedback");
  const feedbackEntries = await optionalReaddir(feedbackRoot, { withFileTypes: true });
  if (!feedbackEntries) {
    return candidates;
  }
  for (const feedbackEntry of feedbackEntries.filter((entry) => entry.isDirectory())) {
    const feedbackId = feedbackEntry.name;
    const submissionRoot = join(feedbackRoot, feedbackId, "submissions");
    const submissionIds = await listPrefixedDirs(submissionRoot, feedbackSubmissionIdPattern);
    const latestId = submissionIds[submissionIds.length - 1];
    for (const submissionId of submissionIds) {
      const path = join(submissionRoot, submissionId);
      const { timestampMs, timestamp } = await readTimestampMs(path, ["submittedAt"]);
      const candidate: ArtifactCandidate = {
        kind: "feedback_submission",
        path,
        id: submissionId,
        containerKey: `feedback:${taskId}:${feedbackId}`,
        taskId,
        feedbackId,
        timestampMs,
        timestamp,
        protected: false
      };
      if (submissionId === latestId) {
        candidate.protected = true;
        candidate.protectReason = `latest feedback submission under ${feedbackId}`;
      } else {
        const check = isCandidateProtected(candidate, protectedPaths);
        candidate.protected = check.protected;
        candidate.protectReason = check.reason;
      }
      candidates.push(candidate);
    }
  }
  return candidates;
}

async function collectAllCandidates(
  workspace: ProjectWorkspace,
  state: RuntimeState
): Promise<{
  candidates: ArtifactCandidate[];
  totals: PrunePlan["totals"];
}> {
  const protectedPaths = protectedPathsFromState(workspace, state);
  const taskEntries = (await optionalReaddir(workspace.resultsDir, { withFileTypes: true })) ?? [];
  const taskIds = taskEntries
    .filter(
      (entry) =>
        entry.isDirectory() && !["run-sessions", "auto-runs", "feedback-runs"].includes(entry.name)
    )
    .map((entry) => entry.name);

  for (const taskId of taskIds) {
    const index = await readTaskIndex(workspace, taskId);
    for (const [path, reason] of protectedPathsFromIndex(workspace, taskId, index)) {
      protectedPaths.set(path, reason);
    }
  }

  const listed = await listRunSessions(workspace);
  const sessionCandidates = await collectSessionCandidates(
    workspace,
    listed.sessions,
    protectedPaths
  );
  // Also include session dirs that failed validation (orphaned SESSION-* dirs not in list)
  const sessionRoot = join(workspace.resultsDir, "run-sessions");
  const existingSessionIds = new Set(sessionCandidates.map((item) => item.id));
  for (const sessionId of await listPrefixedDirs(sessionRoot, sessionIdPattern)) {
    if (existingSessionIds.has(sessionId)) {
      continue;
    }
    const path = join(sessionRoot, sessionId);
    const { timestampMs, timestamp } = await readTimestampMs(path, ["finishedAt", "startedAt"]);
    sessionCandidates.push({
      kind: "session",
      path,
      id: sessionId,
      containerKey: "sessions",
      timestampMs,
      timestamp,
      protected: false,
      protectReason: undefined
    });
  }

  const runCandidates: ArtifactCandidate[] = [];
  const reviewCandidates: ArtifactCandidate[] = [];
  const feedbackCandidates: ArtifactCandidate[] = [];
  for (const taskId of taskIds) {
    runCandidates.push(...(await collectRunCandidates(workspace, taskId, protectedPaths)));
    reviewCandidates.push(...(await collectReviewCandidates(workspace, taskId, protectedPaths)));
    feedbackCandidates.push(
      ...(await collectFeedbackSubmissionCandidates(workspace, taskId, protectedPaths))
    );
  }

  return {
    candidates: [
      ...sessionCandidates,
      ...runCandidates,
      ...reviewCandidates,
      ...feedbackCandidates
    ],
    totals: {
      sessions: sessionCandidates.length,
      runs: runCandidates.length,
      reviewAttempts: reviewCandidates.length,
      feedbackSubmissions: feedbackCandidates.length
    }
  };
}

function selectPrunable(
  candidates: ArtifactCandidate[],
  olderThanMs: number | null,
  keepLast: number | null,
  nowMs: number
): {
  items: PrunePlanItem[];
  excludedCount: number;
} {
  const byContainer = new Map<string, ArtifactCandidate[]>();
  for (const candidate of candidates) {
    const list = byContainer.get(candidate.containerKey) ?? [];
    list.push(candidate);
    byContainer.set(candidate.containerKey, list);
  }

  const items: PrunePlanItem[] = [];
  let excludedCount = 0;

  for (const group of byContainer.values()) {
    const sortedNewestFirst = [...group].sort((left, right) => {
      if (right.timestampMs !== left.timestampMs) {
        return right.timestampMs - left.timestampMs;
      }
      return right.id.localeCompare(left.id);
    });

    sortedNewestFirst.forEach((candidate, indexFromNewest) => {
      if (candidate.protected) {
        excludedCount += 1;
        return;
      }

      const ageMs = Math.max(0, nowMs - candidate.timestampMs);
      const reasons: string[] = [];
      let selected = true;

      if (olderThanMs !== null) {
        if (ageMs >= olderThanMs) {
          reasons.push(`older than cutoff (ageMs=${ageMs})`);
        } else {
          selected = false;
        }
      }

      if (keepLast !== null) {
        if (indexFromNewest >= keepLast) {
          reasons.push(`beyond keep-last ${keepLast} in container`);
        } else {
          selected = false;
        }
      }

      // Intersection: both rules must select when both provided.
      if (olderThanMs !== null && keepLast !== null) {
        selected = ageMs >= olderThanMs && indexFromNewest >= keepLast;
        if (selected) {
          reasons.length = 0;
          reasons.push(`older than cutoff and beyond keep-last ${keepLast}`);
        }
      }

      if (!selected || reasons.length === 0) {
        excludedCount += 1;
        return;
      }

      items.push({
        kind: candidate.kind,
        path: candidate.path,
        id: candidate.id,
        reason: reasons.join("; "),
        taskId: candidate.taskId,
        blockId: candidate.blockId,
        ref: candidate.ref,
        feedbackId: candidate.feedbackId,
        ageMs,
        timestamp: candidate.timestamp
      });
    });
  }

  items.sort((left, right) => left.path.localeCompare(right.path));
  return { items, excludedCount };
}

export async function computePrunePlan(
  projectRoot: PackageWorkspaceRef,
  options: ComputePrunePlanOptions = {}
): Promise<PrunePlan> {
  const filters = resolvePruneFilters(options);
  const workspace = await resolvePackageWorkspace(projectRoot);
  const state = await readState(workspace.stateFile);
  const { candidates, totals } = await collectAllCandidates(workspace, state);
  const { items, excludedCount } = selectPrunable(
    candidates,
    filters.olderThanMs,
    filters.keepLast,
    filters.now.getTime()
  );
  const cutoffIso =
    filters.olderThanMs === null
      ? null
      : new Date(filters.now.getTime() - filters.olderThanMs).toISOString();

  return {
    items,
    excludedCount,
    options: {
      olderThanMs: filters.olderThanMs,
      keepLast: filters.keepLast,
      cutoffIso,
      nowIso: filters.now.toISOString()
    },
    totals
  };
}

export async function applyPrunePlan(
  projectRoot: PackageWorkspaceRef,
  plan: PrunePlan,
  options: { reason: string }
): Promise<ApplyPrunePlanResult> {
  const reason = options.reason.trim();
  if (!reason) {
    throw new Error("applyPrunePlan requires a non-empty reason.");
  }

  const { workspace } = await loadPackage(projectRoot);

  return withCanvasLock(dirname(workspace.stateFile), async () => {
    const state = await readState(workspace.stateFile);
    const { candidates } = await collectAllCandidates(workspace, state);
    const protectedNow = new Set(
      candidates.filter((item) => item.protected).map((item) => resolve(item.path))
    );
    const deleted: PrunePlanItem[] = [];
    const skipped: Array<PrunePlanItem & { skipReason: string }> = [];

    for (const item of plan.items) {
      const absolutePath = resolve(item.path);
      if (!isPrunableArtifactPath(workspace.resultsDir, absolutePath)) {
        skipped.push({
          ...item,
          skipReason: "path is outside the allowed results artifact patterns"
        });
        continue;
      }
      if (protectedNow.has(absolutePath)) {
        skipped.push({ ...item, skipReason: "referenced or protected at apply time" });
        continue;
      }
      if (!(await optionalStat(absolutePath))) {
        skipped.push({ ...item, skipReason: "path no longer exists" });
        continue;
      }
      if (item.kind === "run") {
        await removeBlockRunFromIndex(dirname(absolutePath), item.id);
      }
      await rm(absolutePath, { recursive: true, force: false });
      deleted.push(item);
    }

    return { deleted, skipped, reason };
  });
}

export async function countRetentionArtifacts(projectRoot: PackageWorkspaceRef): Promise<{
  total: number;
  sessions: number;
  runs: number;
  reviewAttempts: number;
  feedbackSubmissions: number;
}> {
  const workspace = await resolvePackageWorkspace(projectRoot);
  const state = await readState(workspace.stateFile);
  const { totals } = await collectAllCandidates(workspace, state);
  const total = totals.sessions + totals.runs + totals.reviewAttempts + totals.feedbackSubmissions;
  return { total, ...totals };
}
