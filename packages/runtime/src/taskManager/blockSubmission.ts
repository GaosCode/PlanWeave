import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { writeState } from "../state.js";
import type { ExecutionGraphSession, PackageWorkspaceRef, ProjectWorkspace, SubmitResult } from "../types.js";
import { exists, loadRuntime, refreshDerivedState } from "./runtimeContext.js";
import { getBlock } from "./selectors.js";
import { incrementTaskIndexCount, listDirCount, nextId, readTaskIndex, updateTaskIndex } from "./resultIndex.js";

async function fileHash(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function runHasSubmittedResult(runDir: string, ref: string, runId: string, reportHash?: string): Promise<boolean> {
  const metadataPath = join(runDir, "metadata.json");
  const reportPath = join(runDir, "report.md");
  if (!(await exists(metadataPath)) || !(await exists(reportPath))) {
    return false;
  }
  const metadata = await readJsonFile<Record<string, unknown>>(metadataPath);
  if (metadata.ref !== ref || metadata.runId !== runId) {
    return false;
  }
  if (!reportHash) {
    return true;
  }
  if (metadata.reportHash === reportHash) {
    return true;
  }
  return (await fileHash(reportPath)) === reportHash;
}

async function findPersistedRun(
  workspace: ProjectWorkspace,
  taskId: string,
  blockId: string,
  ref: string,
  reportHash?: string
): Promise<string | null> {
  const runRoot = join(workspace.resultsDir, taskId, "blocks", blockId, "runs");
  const index = await readTaskIndex(workspace, taskId);
  const indexedRunId = index.latestRunByBlock?.[ref];
  if (indexedRunId && (await runHasSubmittedResult(join(runRoot, indexedRunId), ref, indexedRunId, reportHash))) {
    return indexedRunId;
  }
  let entries;
  try {
    entries = await readdir(runRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const runIds = entries
    .filter((entry) => entry.isDirectory() && /^RUN-\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const runId of runIds) {
    if (await runHasSubmittedResult(join(runRoot, runId), ref, runId, reportHash)) {
      return runId;
    }
  }
  return null;
}

export async function submitBlockResult(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  reportPath: string;
  runId?: string;
  session?: ExecutionGraphSession;
}): Promise<SubmitResult> {
  const context = await loadRuntime(options);
  const { workspace, manifest, graph } = context;
  let { state } = context;
  const { taskId, blockId } = parseBlockRef(options.ref);
  const block = getBlock(graph, options.ref);
  if (block.type === "review") {
    throw new Error("submit-result only accepts implementation blocks.");
  }
  const reportHash = await fileHash(options.reportPath);
  const inProgress = state.blocks[options.ref]?.status === "in_progress";
  const persistedRunId =
    (await findPersistedRun(workspace, taskId, blockId, options.ref, reportHash)) ??
    (inProgress ? await findPersistedRun(workspace, taskId, blockId, options.ref) : null);
  if (persistedRunId) {
    await updateTaskIndex(workspace, taskId, (index) => ({
      ...index,
      latestRunByBlock: {
        ...(index.latestRunByBlock ?? {}),
        [options.ref]: persistedRunId
      }
    }));
    state.blocks[options.ref] = { ...state.blocks[options.ref], status: "completed", lastRunId: persistedRunId };
    state.currentRefs = state.currentRefs.filter((ref) => ref !== options.ref);
    state = refreshDerivedState(manifest, state);
    await writeState(workspace.stateFile, state);
    return { ref: options.ref, runId: persistedRunId, status: "completed" };
  }
  if (!inProgress) {
    throw new Error(`Block '${options.ref}' must be in_progress before submit-result.`);
  }
  const runRoot = join(workspace.resultsDir, taskId, "blocks", blockId, "runs");
  const runId = options.runId ?? nextId("RUN", await listDirCount(runRoot));
  const runDir = join(runRoot, runId);
  const reportDestination = join(runDir, "report.md");
  const metadataPath = join(runDir, "metadata.json");
  await mkdir(runDir, { recursive: true });
  if (options.reportPath !== reportDestination) {
    await copyFile(options.reportPath, reportDestination);
  }
  const previousMetadata = (await exists(metadataPath)) ? await readJsonFile<Record<string, unknown>>(metadataPath) : {};
  await writeJsonFile(metadataPath, {
    ...previousMetadata,
    ref: options.ref,
    taskId,
    blockId,
    runId,
    submittedAt: new Date().toISOString(),
    reportHash,
    sourceReportPath: options.reportPath
  });
  await updateTaskIndex(workspace, taskId, (index) => ({
    ...index,
    latestRunByBlock: {
      ...(index.latestRunByBlock ?? {}),
      [options.ref]: runId
    },
    counts: incrementTaskIndexCount(index, "runs")
  }));
  state.blocks[options.ref] = { ...state.blocks[options.ref], status: "completed", lastRunId: runId };
  state.currentRefs = state.currentRefs.filter((ref) => ref !== options.ref);
  state = refreshDerivedState(manifest, state);
  await writeState(workspace.stateFile, state);
  return { ref: options.ref, runId, status: "completed" };
}
