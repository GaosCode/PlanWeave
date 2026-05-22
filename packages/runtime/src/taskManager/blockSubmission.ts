import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { writeState } from "../state.js";
import type { ExecutionGraphSession, PackageWorkspaceRef, SubmitResult } from "../types.js";
import { exists, loadRuntime, refreshDerivedState } from "./runtimeContext.js";
import { getBlock } from "./selectors.js";
import { incrementTaskIndexCount, listDirCount, nextId, updateTaskIndex } from "./resultIndex.js";

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
    throw new Error("submit-result only accepts implementation/check blocks.");
  }
  if (state.blocks[options.ref]?.status !== "in_progress") {
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
