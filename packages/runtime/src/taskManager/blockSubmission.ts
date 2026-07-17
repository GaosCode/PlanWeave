import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  materializeArtifactBytes,
  readVerifiedArtifactReference,
  type ArtifactMaterializationHooks
} from "../autoRun/artifactReferenceContract.js";
import type { ArtifactReference } from "../autoRun/runnerContractSchemas.js";
import { allocateRunId } from "../autoRun/executorShared.js";
import { upsertBlockRunInIndex } from "../autoRun/blockRunIndex.js";
import { optionalReaddir } from "../fs/optionalFile.js";
import { withCanvasLock } from "../fs/withCanvasLock.js";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { loadPackage } from "../package/loadPackage.js";
import { writeState } from "../state.js";
import type {
  ExecutionGraphSession,
  PackageWorkspaceRef,
  ProjectWorkspace,
  SubmitResult
} from "../types.js";
import { exists, loadRuntime, refreshDerivedState } from "./runtimeContext.js";
import { getBlock } from "./selectors.js";
import { incrementTaskIndexCount, readTaskIndex, updateTaskIndex } from "./resultIndex.js";

type BlockSubmissionArtifact =
  | { mode: "legacy"; bytes: Buffer }
  | { mode: "verified"; reference: ArtifactReference; bytes: Buffer };

async function runHasSubmittedResult(
  runDir: string,
  ref: string,
  runId: string,
  artifact: BlockSubmissionArtifact
): Promise<boolean> {
  const metadataPath = join(runDir, "metadata.json");
  const reportPath = join(runDir, "report.md");
  if (!((await exists(metadataPath)) && (await exists(reportPath)))) {
    return false;
  }
  const metadata = await readJsonFile<Record<string, unknown>>(metadataPath);
  if (metadata.ref !== ref || metadata.runId !== runId) {
    return false;
  }
  const reportHash = createHash("sha256").update(artifact.bytes).digest("hex");
  if (metadata.reportHash !== reportHash) {
    return false;
  }
  let persistedBytes: Buffer;
  if (artifact.mode === "verified") {
    const persisted = await readVerifiedArtifactReference({
      rootDir: runDir,
      value: metadata.artifactReference
    });
    if (
      persisted.reference.version !== artifact.reference.version ||
      persisted.reference.kind !== artifact.reference.kind ||
      persisted.reference.relativePath !== artifact.reference.relativePath ||
      persisted.reference.sha256 !== artifact.reference.sha256 ||
      persisted.reference.sizeBytes !== artifact.reference.sizeBytes ||
      persisted.reference.mediaType !== artifact.reference.mediaType
    ) {
      throw new Error(`Persisted artifact reference for run '${runId}' does not match submission.`);
    }
    persistedBytes = persisted.bytes;
  } else {
    persistedBytes = await readFile(reportPath);
  }
  if (!persistedBytes.equals(artifact.bytes)) {
    throw new Error(`Persisted report for run '${runId}' does not match its submitted hash.`);
  }
  return true;
}

async function findPersistedRun(
  workspace: ProjectWorkspace,
  taskId: string,
  blockId: string,
  ref: string,
  artifact: BlockSubmissionArtifact
): Promise<string | null> {
  const runRoot = join(workspace.resultsDir, taskId, "blocks", blockId, "runs");
  const index = await readTaskIndex(workspace, taskId);
  const indexedRunId = index.latestRunByBlock?.[ref];
  if (
    indexedRunId &&
    (await runHasSubmittedResult(join(runRoot, indexedRunId), ref, indexedRunId, artifact))
  ) {
    return indexedRunId;
  }
  const entries = await optionalReaddir(runRoot, { withFileTypes: true });
  if (!entries) {
    return null;
  }
  const runIds = entries
    .filter((entry) => entry.isDirectory() && /^RUN-\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const runId of runIds) {
    if (await runHasSubmittedResult(join(runRoot, runId), ref, runId, artifact)) {
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
  return submitBlockResultFromBytes(options, await readFile(options.reportPath));
}

export async function submitBlockResultFromBytes(
  options: {
    projectRoot: PackageWorkspaceRef;
    ref: string;
    reportPath: string;
    runId?: string;
    session?: ExecutionGraphSession;
  },
  reportBytes: Buffer
): Promise<SubmitResult> {
  return submitBlockResultArtifact(options, { mode: "legacy", bytes: reportBytes });
}

export async function submitVerifiedBlockResult(
  options: {
    projectRoot: PackageWorkspaceRef;
    ref: string;
    reportPath: string;
    runId?: string;
    session?: ExecutionGraphSession;
  },
  artifact: { reference: ArtifactReference; bytes: Buffer },
  hooks: ArtifactMaterializationHooks = {}
): Promise<SubmitResult> {
  return submitBlockResultArtifact(
    options,
    { mode: "verified", reference: artifact.reference, bytes: artifact.bytes },
    hooks
  );
}

async function submitBlockResultArtifact(
  options: {
    projectRoot: PackageWorkspaceRef;
    ref: string;
    reportPath: string;
    runId?: string;
    session?: ExecutionGraphSession;
  },
  artifact: BlockSubmissionArtifact,
  hooks: ArtifactMaterializationHooks = {}
): Promise<SubmitResult> {
  const reportHash = createHash("sha256").update(artifact.bytes).digest("hex");
  if (
    artifact.mode === "verified" &&
    (artifact.reference.kind !== "implementation" ||
      artifact.reference.relativePath !== "report.md" ||
      artifact.reference.sha256 !== reportHash ||
      artifact.reference.sizeBytes !== artifact.bytes.byteLength)
  ) {
    throw new Error("Verified implementation artifact reference does not match its bytes.");
  }
  const { workspace: lockWorkspace } = await loadPackage(options.projectRoot);
  return withCanvasLock(dirname(lockWorkspace.stateFile), async () => {
    const context = await loadRuntime(options);
    const { workspace, manifest, graph } = context;
    let { state } = context;
    const { taskId, blockId } = parseBlockRef(options.ref);
    const block = getBlock(graph, options.ref);
    if (block.type === "review") {
      throw new Error("submit-result only accepts implementation blocks.");
    }
    const inProgress = state.blocks[options.ref]?.status === "in_progress";
    const persistedRunId = await findPersistedRun(
      workspace,
      taskId,
      blockId,
      options.ref,
      artifact
    );
    if (persistedRunId) {
      const persistedRunRoot = join(workspace.resultsDir, taskId, "blocks", blockId, "runs");
      await upsertBlockRunInIndex(persistedRunRoot, persistedRunId, true);
      await updateTaskIndex(workspace, taskId, (index) => ({
        ...index,
        latestRunByBlock: {
          ...(index.latestRunByBlock ?? {}),
          [options.ref]: persistedRunId
        }
      }));
      state.blocks[options.ref] = {
        ...state.blocks[options.ref],
        status: "completed",
        lastRunId: persistedRunId
      };
      state.currentRefs = state.currentRefs.filter((ref) => ref !== options.ref);
      state = refreshDerivedState(manifest, state);
      await writeState(workspace.stateFile, state);
      return { ref: options.ref, runId: persistedRunId, status: "completed" };
    }
    if (!inProgress) {
      throw new Error(`Block '${options.ref}' must be in_progress before submit-result.`);
    }
    const runRoot = join(workspace.resultsDir, taskId, "blocks", blockId, "runs");
    let runId: string;
    if (options.runId) {
      runId = options.runId;
      await mkdir(join(runRoot, runId), { recursive: true });
    } else {
      runId = await allocateRunId(runRoot);
    }
    const runDir = join(runRoot, runId);
    const reportDestination = join(runDir, "report.md");
    const metadataPath = join(runDir, "metadata.json");
    const artifactReference =
      artifact.mode === "verified"
        ? await materializeArtifactBytes(
            {
              rootDir: runDir,
              relativePath: "report.md",
              kind: "implementation",
              content: artifact.bytes
            },
            hooks
          )
        : null;
    if (artifact.mode === "legacy") {
      await writeFile(reportDestination, artifact.bytes);
    }
    const previousMetadata = (await exists(metadataPath))
      ? await readJsonFile<Record<string, unknown>>(metadataPath)
      : {};
    await writeJsonFile(metadataPath, {
      ...previousMetadata,
      ref: options.ref,
      taskId,
      blockId,
      runId,
      submittedAt: new Date().toISOString(),
      reportHash,
      ...(artifactReference ? { artifactReference } : {}),
      sourceReportPath: options.reportPath
    });
    await upsertBlockRunInIndex(runRoot, runId, true);
    await updateTaskIndex(workspace, taskId, (index) => ({
      ...index,
      latestRunByBlock: {
        ...(index.latestRunByBlock ?? {}),
        [options.ref]: runId
      },
      counts: incrementTaskIndexCount(index, "runs")
    }));
    state.blocks[options.ref] = {
      ...state.blocks[options.ref],
      status: "completed",
      lastRunId: runId
    };
    state.currentRefs = state.currentRefs.filter((ref) => ref !== options.ref);
    state = refreshDerivedState(manifest, state);
    await writeState(workspace.stateFile, state);
    return { ref: options.ref, runId, status: "completed" };
  });
}
