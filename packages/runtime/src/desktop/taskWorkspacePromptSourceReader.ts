import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isNodeFileNotFoundError } from "../fs/optionalFile.js";
import { resolvePackagePath } from "../package/resolvePackagePath.js";
import { resolvePlanweaveHome } from "../paths.js";
import { readProjectPromptPolicy, type ProjectPromptPolicy } from "../projectPromptPolicy.js";
import type { ProjectWorkspace } from "../types.js";

interface TaskWorkspacePromptSource {
  markdown: string;
  missing: boolean;
}

interface TaskWorkspacePromptSourceReader {
  readProjectPromptPolicy: () => Promise<ProjectPromptPolicy>;
  readGlobalPrompt: () => Promise<TaskWorkspacePromptSource>;
  readProjectPrompt: () => Promise<TaskWorkspacePromptSource>;
  readPackagePrompt: (
    packagePath: string,
    options?: { allowMissing?: boolean }
  ) => Promise<TaskWorkspacePromptSource>;
  readLatestReportSnippet: (path: string) => Promise<string>;
}

const latestReportSnippetLimit = 400;

function memoizeAsync<Key, Value>(
  load: (key: Key) => Promise<Value>
): (key: Key) => Promise<Value> {
  const values = new Map<Key, Promise<Value>>();
  return (key) => {
    const existing = values.get(key);
    if (existing) {
      return existing;
    }
    const pending = load(key);
    values.set(key, pending);
    return pending;
  };
}

async function readPromptFile(input: {
  path: string;
  allowMissing: boolean;
}): Promise<TaskWorkspacePromptSource> {
  try {
    return {
      markdown: await readFile(input.path, "utf8"),
      missing: false
    };
  } catch (error) {
    if (input.allowMissing && isNodeFileNotFoundError(error)) {
      return { markdown: "", missing: true };
    }
    throw error;
  }
}

async function readLatestReportSnippet(path: string): Promise<string> {
  try {
    const content = await readFile(path, "utf8");
    return content.trim().slice(0, latestReportSnippetLimit) || "(empty)";
  } catch (error) {
    if (isNodeFileNotFoundError(error)) {
      return "(unavailable)";
    }
    throw error;
  }
}

function promptCacheKey(path: string, allowMissing: boolean): string {
  if (allowMissing) {
    return `missing-allowed:${path}`;
  }
  return `required:${path}`;
}

function createTaskWorkspacePromptSourceReader(
  workspace: ProjectWorkspace
): TaskWorkspacePromptSourceReader {
  let projectPromptPolicy: Promise<ProjectPromptPolicy> | undefined;
  const promptFiles = new Map<string, Promise<TaskWorkspacePromptSource>>();
  const packagePrompts = new Map<string, Promise<TaskWorkspacePromptSource>>();
  const reportSnippets = memoizeAsync(readLatestReportSnippet);
  const memoizedPromptFile = (path: string, allowMissing: boolean) => {
    const key = promptCacheKey(path, allowMissing);
    const existing = promptFiles.get(key);
    if (existing) {
      return existing;
    }
    const pending = readPromptFile({ path, allowMissing });
    promptFiles.set(key, pending);
    return pending;
  };

  return {
    readProjectPromptPolicy: () => {
      projectPromptPolicy ??= readProjectPromptPolicy(workspace);
      return projectPromptPolicy;
    },
    readGlobalPrompt: () =>
      memoizedPromptFile(join(resolvePlanweaveHome(), "config", "global-prompt.md"), true),
    readProjectPrompt: () => memoizedPromptFile(workspace.projectPromptFile, true),
    readPackagePrompt: (packagePath, options = {}) => {
      const allowMissing = options.allowMissing ?? false;
      const key = promptCacheKey(packagePath, allowMissing);
      const existing = packagePrompts.get(key);
      if (existing) {
        return existing;
      }
      const pending = resolvePackagePath(workspace.packageDir, packagePath, {
        requireExisting: !allowMissing
      }).then((path) => readPromptFile({ path, allowMissing }));
      packagePrompts.set(key, pending);
      return pending;
    },
    readLatestReportSnippet: reportSnippets
  };
}

export { createTaskWorkspacePromptSourceReader };
export type { TaskWorkspacePromptSource, TaskWorkspacePromptSourceReader };
