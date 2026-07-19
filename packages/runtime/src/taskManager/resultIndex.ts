import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { optionalReaddir, optionalStat } from "../fs/optionalFile.js";
import { withCanvasLock } from "../fs/withCanvasLock.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import {
  feedbackStatuses,
  reviewCompletionReasons,
  reviewVerdicts,
  type ProjectWorkspace,
  type ReviewCompletionReason,
  type TaskResultIndex,
  type ValidationIssue
} from "../types.js";

export function nextId(prefix: string, count: number): string {
  return `${prefix}-${String(count + 1).padStart(3, "0")}`;
}

export async function listDirCount(path: string): Promise<number> {
  const entries = await optionalReaddir(path, { withFileTypes: true });
  return entries?.filter((entry) => entry.isDirectory()).length ?? 0;
}

/** Reserve a `<prefix>-NNN` directory atomically via exclusive mkdir. */
export async function allocatePrefixedId(root: string, prefix: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const pattern = new RegExp(`^${prefix}-\\d+$`);
  for (let attempt = 1; attempt <= 1000; attempt++) {
    const existing = await optionalReaddir(root, { withFileTypes: true });
    const count =
      existing?.filter((entry) => entry.isDirectory() && pattern.test(entry.name)).length ?? 0;
    const candidate = nextId(prefix, count + attempt - 1);
    try {
      await mkdir(join(root, candidate), { recursive: false });
      return candidate;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Unable to allocate a ${prefix} id under ${root}`);
}

const nonNegativeIntSchema = z.number().int().nonnegative();
const stringIdMapSchema = z.record(z.string(), z.string());

const taskResultIndexWarningSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    path: z.string().optional(),
    transitionId: z.string().optional()
  })
  .strict();

/**
 * On-disk `results/<task>/index.json` shape.
 * Unknown fields are rejected (`.strict()`): the runtime owns this file family and only
 * writes known keys, so extra properties indicate corruption or a schema mismatch rather
 * than intentional forward-compat payload.
 */
export const taskResultIndexSchema = z
  .object({
    latestRunByBlock: stringIdMapSchema.optional(),
    latestReviewAttemptByBlock: stringIdMapSchema.optional(),
    latestReviewVerdictByBlock: z.record(z.string(), z.enum(reviewVerdicts)).optional(),
    latestReviewedWorkRevisionByBlock: stringIdMapSchema.optional(),
    latestFeedbackByReviewBlock: stringIdMapSchema.optional(),
    latestFeedbackSubmissionByFeedback: stringIdMapSchema.optional(),
    feedbackStatusById: z.record(z.string(), z.enum(feedbackStatuses)).optional(),
    reviewCompletionReasonByBlock: z
      .record(z.string(), z.enum(reviewCompletionReasons))
      .optional(),
    counts: z
      .object({
        runs: nonNegativeIntSchema.optional(),
        reviewAttempts: nonNegativeIntSchema.optional(),
        feedbackEnvelopes: nonNegativeIntSchema.optional(),
        feedbackSubmissions: nonNegativeIntSchema.optional()
      })
      .strict()
      .optional(),
    warnings: z.array(taskResultIndexWarningSchema).optional()
  })
  .strict() satisfies z.ZodType<TaskResultIndex>;

export function formatTaskResultIndexIssues(
  issues: z.ZodError["issues"],
  indexPath: string
): string {
  const details = issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  return `Task result index at ${indexPath} is invalid: ${details}`;
}

export function parseTaskResultIndex(raw: unknown, indexPath: string): TaskResultIndex {
  const parsed = taskResultIndexSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(formatTaskResultIndexIssues(parsed.error.issues, indexPath));
  }
  return parsed.data;
}

function taskIndexPath(workspace: ProjectWorkspace, taskId: string): string {
  return join(workspace.resultsDir, taskId, "index.json");
}

/**
 * Read and validate `results/<task>/index.json` at the result-repository boundary.
 * Missing file maps to `{}` (no submissions yet). Malformed JSON and schema failures
 * throw path-specific errors and must not become an empty successful index.
 * Non-missing I/O failures surface unchanged.
 */
export async function readTaskIndex(
  workspace: ProjectWorkspace,
  taskId: string
): Promise<TaskResultIndex> {
  const path = taskIndexPath(workspace, taskId);
  if (!(await optionalStat(path))) {
    return {};
  }
  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(path);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Task result index at ${path} is malformed JSON: ${error.message}`
      );
    }
    throw error;
  }
  return parseTaskResultIndex(raw, path);
}

async function writeTaskIndex(
  workspace: ProjectWorkspace,
  taskId: string,
  index: TaskResultIndex
): Promise<void> {
  await mkdir(join(workspace.resultsDir, taskId), { recursive: true });
  await writeJsonFile(taskIndexPath(workspace, taskId), index);
}

export async function updateTaskIndex(
  workspace: ProjectWorkspace,
  taskId: string,
  update: (index: TaskResultIndex) => TaskResultIndex
): Promise<TaskResultIndex> {
  return withCanvasLock(dirname(workspace.stateFile), async () => {
    const next = update(await readTaskIndex(workspace, taskId));
    await writeTaskIndex(workspace, taskId, next);
    return next;
  });
}

export async function clearReviewCompletionReason(
  workspace: ProjectWorkspace,
  taskId: string,
  reviewBlockRef: string
): Promise<void> {
  await updateTaskIndex(workspace, taskId, (index) => {
    const completionReasons = { ...(index.reviewCompletionReasonByBlock ?? {}) };
    delete completionReasons[reviewBlockRef];
    const warnings = (index.warnings ?? []).filter(
      (warning) =>
        !(warning.code === "review_max_cycles_reached" && warning.path === reviewBlockRef)
    );
    return {
      ...index,
      reviewCompletionReasonByBlock:
        Object.keys(completionReasons).length > 0 ? completionReasons : undefined,
      warnings: warnings.length > 0 ? warnings : undefined
    };
  });
}

export async function recordReviewCompletionReason(options: {
  workspace: ProjectWorkspace;
  taskId: string;
  reviewBlockRef: string;
  completionReason: ReviewCompletionReason;
  warning?: ValidationIssue;
}): Promise<void> {
  await updateTaskIndex(options.workspace, options.taskId, (index) => ({
    ...index,
    reviewCompletionReasonByBlock: {
      ...(index.reviewCompletionReasonByBlock ?? {}),
      [options.reviewBlockRef]: options.completionReason
    },
    warnings: options.warning ? [...(index.warnings ?? []), options.warning] : index.warnings
  }));
}

export function incrementTaskIndexCount(
  index: TaskResultIndex,
  field: keyof NonNullable<TaskResultIndex["counts"]>
): TaskResultIndex["counts"] {
  return {
    ...(index.counts ?? {}),
    [field]: ((index.counts ?? {})[field] ?? 0) + 1
  };
}
