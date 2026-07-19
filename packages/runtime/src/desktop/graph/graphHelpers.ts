import { readFile } from "node:fs/promises";
import { isNodeFileNotFoundError } from "../../fs/optionalFile.js";
import { parseBlockRef } from "../../graph/compileTaskGraph.js";
import { requireMapValue } from "../../graph/requireMapValue.js";
import type {
  BlockStatus,
  CompiledExecutionGraph,
  ManifestBlock,
  ManifestTaskNode,
  ValidationIssue
} from "../../types.js";
import type { DesktopTaskException } from "../types.js";

export type PromptFileReadResult = {
  markdown: string;
  missing: boolean;
  diagnostic: ValidationIssue | null;
};

export async function readOptionalFile(
  path: string,
  packagePath: string
): Promise<PromptFileReadResult> {
  try {
    return {
      markdown: await readFile(path, "utf8"),
      missing: false,
      diagnostic: null
    };
  } catch (error) {
    const missing = isNodeFileNotFoundError(error);
    return {
      markdown: "",
      missing,
      diagnostic: {
        code: missing ? "prompt_missing" : "prompt_read_failed",
        message: missing
          ? `Prompt file '${packagePath}' does not exist.`
          : `Prompt '${packagePath}' could not be read.`,
        path: packagePath
      }
    };
  }
}

export function blockRef(taskId: string, blockId: string): string {
  return `${taskId}#${blockId}`;
}

export function getTask(graph: CompiledExecutionGraph, taskId: string): ManifestTaskNode {
  const task = graph.tasksById.get(taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' does not exist.`);
  }
  return task;
}

export function getBlock(graph: CompiledExecutionGraph, ref: string): ManifestBlock {
  const block = graph.blocksByRef.get(ref);
  if (!block) {
    throw new Error(`Block '${ref}' does not exist.`);
  }
  return block;
}

export function sortBlockRefsForTask(graph: CompiledExecutionGraph, taskId: string): string[] {
  const refs = requireMapValue(graph.blocksByTask, taskId, "blocksByTask");
  const order = new Map(refs.map((ref, index) => [ref, index]));
  const dependencies = new Map(
    refs.map((ref) => [
      ref,
      new Set(requireMapValue(graph.blockDependenciesByRef, ref, "blockDependenciesByRef"))
    ])
  );
  const sorted: string[] = [];
  const ready = refs.filter((ref) => (dependencies.get(ref)?.size ?? 0) === 0);

  while (ready.length > 0) {
    ready.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
    const current = ready.shift();
    if (!current || sorted.includes(current)) {
      continue;
    }
    sorted.push(current);
    for (const dependent of requireMapValue(
      graph.blockDependentsByRef,
      current,
      "blockDependentsByRef"
    )) {
      const remaining = dependencies.get(dependent);
      if (!remaining) {
        continue;
      }
      remaining.delete(current);
      if (remaining.size === 0) {
        ready.push(dependent);
      }
    }
  }

  return sorted.length === refs.length ? sorted : refs;
}

export function exceptionForBlock(
  ref: string,
  status: BlockStatus,
  reason?: string | null
): DesktopTaskException | null {
  if (status === "blocked") {
    return { ref, source: "blocked", reason: reason ?? `${ref} is blocked.` };
  }
  if (status === "diverged") {
    return { ref, source: "diverged", reason: reason ?? `${ref} diverged from expected work.` };
  }
  if (status === "needs_changes") {
    return { ref, source: "needs_changes", reason: reason ?? `${ref} needs changes.` };
  }
  return null;
}

export function executorLabel(task: ManifestTaskNode): string {
  const blockExecutors = new Set(
    task.blocks.map((block) => block.executor ?? task.executor ?? null)
  );
  if (blockExecutors.size > 1) {
    return "Mixed";
  }
  return [...blockExecutors][0] ?? task.executor ?? "manual";
}

export function promptPreview(markdown: string): string {
  return markdown.replace(/\s+/g, " ").trim().slice(0, 220);
}

export function parseRefBlockId(ref: string): string {
  return parseBlockRef(ref).blockId;
}
