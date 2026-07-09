import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { optionalReaddir, optionalStat } from "../fs/optionalFile.js";
import { withCanvasLock } from "../fs/withCanvasLock.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import type { ProjectWorkspace, TaskResultIndex, ValidationIssue } from "../types.js";

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
    const count = existing?.filter((entry) => entry.isDirectory() && pattern.test(entry.name)).length ?? 0;
    const candidate = nextId(prefix, count + attempt - 1);
    try {
      await mkdir(join(root, candidate), { recursive: false });
      return candidate;
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Unable to allocate a ${prefix} id under ${root}`);
}

function taskIndexPath(workspace: ProjectWorkspace, taskId: string): string {
  return join(workspace.resultsDir, taskId, "index.json");
}

export async function readTaskIndex(workspace: ProjectWorkspace, taskId: string): Promise<TaskResultIndex> {
  const path = taskIndexPath(workspace, taskId);
  return (await optionalStat(path)) ? readJsonFile<TaskResultIndex>(path) : {};
}

async function writeTaskIndex(workspace: ProjectWorkspace, taskId: string, index: TaskResultIndex): Promise<void> {
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

export async function clearReviewCompletionReason(workspace: ProjectWorkspace, taskId: string, reviewBlockRef: string): Promise<void> {
  await updateTaskIndex(workspace, taskId, (index) => {
    const completionReasons = { ...(index.reviewCompletionReasonByBlock ?? {}) };
    delete completionReasons[reviewBlockRef];
    const warnings = (index.warnings ?? []).filter(
      (warning) => !(warning.code === "review_max_cycles_reached" && warning.path === reviewBlockRef)
    );
    return {
      ...index,
      reviewCompletionReasonByBlock: Object.keys(completionReasons).length > 0 ? completionReasons : undefined,
      warnings: warnings.length > 0 ? warnings : undefined
    };
  });
}

export async function recordReviewCompletionReason(options: {
  workspace: ProjectWorkspace;
  taskId: string;
  reviewBlockRef: string;
  completionReason: "passed" | "max_cycles_reached";
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

export function incrementTaskIndexCount(index: TaskResultIndex, field: keyof NonNullable<TaskResultIndex["counts"]>): TaskResultIndex["counts"] {
  return {
    ...(index.counts ?? {}),
    [field]: ((index.counts ?? {})[field] ?? 0) + 1
  };
}
