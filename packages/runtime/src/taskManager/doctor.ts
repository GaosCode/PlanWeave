import { dirname, join } from "node:path";
import { inspectPendingTransitionsForWorkspace } from "../autoRun/pendingTransitionIntent.js";
import { optionalStat } from "../fs/optionalFile.js";
import { withCanvasLock } from "../fs/withCanvasLock.js";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { requireMapValue } from "../graph/requireMapValue.js";
import { findOrphanResults } from "../package/orphans.js";
import { loadPackage } from "../package/loadPackage.js";
import { RETENTION_DOCTOR_THRESHOLD, countRetentionArtifacts } from "../runSessions/retention.js";
import { ensureStateForManifest, readState, writeState } from "../state.js";
import type {
  DoctorIssue,
  DoctorReport,
  PackageWorkspaceRef,
  ProjectWorkspace,
  RuntimeState,
  TaskResultIndex
} from "../types.js";
import { isDoctorErrorIssue } from "../types.js";
import { readImplementationRunMetadataFile } from "./implementationRunMetadata.js";
import { readTaskIndex, updateTaskIndex } from "./resultIndex.js";

async function exists(path: string): Promise<boolean> {
  return (await optionalStat(path)) !== null;
}

async function resultRunMatchesIndex(
  workspace: ProjectWorkspace,
  ref: string,
  taskId: string,
  runId: string
): Promise<boolean> {
  const blockId = ref.split("#")[1];
  if (!blockId) {
    return false;
  }
  const runDir = join(workspace.resultsDir, taskId, "blocks", blockId, "runs", runId);
  const metadataPath = join(runDir, "metadata.json");
  if (!(await exists(metadataPath)) || !(await exists(join(runDir, "report.md")))) {
    return false;
  }
  // Present metadata must parse under the implementation-run contract; invalid/malformed fails visibly.
  const metadata = await readImplementationRunMetadataFile(metadataPath);
  return (
    metadata.ref === ref &&
    metadata.taskId === taskId &&
    metadata.blockId === blockId &&
    metadata.runId === runId
  );
}

function repairStaleCurrentRef(state: RuntimeState, ref: string): boolean {
  const nextRefs = state.currentRefs.filter((currentRef) => currentRef !== ref);
  if (nextRefs.length === state.currentRefs.length) {
    return false;
  }
  state.currentRefs = nextRefs;
  return true;
}

async function repairStateRunMismatch(options: {
  workspace: ProjectWorkspace;
  state: RuntimeState;
  ref: string;
  taskId: string;
  indexRunId: string;
}): Promise<boolean> {
  if (
    !(await resultRunMatchesIndex(
      options.workspace,
      options.ref,
      options.taskId,
      options.indexRunId
    ))
  ) {
    return false;
  }
  options.state.blocks[options.ref] = {
    ...(options.state.blocks[options.ref] ?? {}),
    status: "completed",
    lastRunId: options.indexRunId
  };
  options.state.currentRefs = options.state.currentRefs.filter((ref) => ref !== options.ref);
  return true;
}

async function repairIndexRunMismatch(options: {
  workspace: ProjectWorkspace;
  ref: string;
  taskId: string;
  stateRunId: string;
}): Promise<boolean> {
  if (
    !(await resultRunMatchesIndex(
      options.workspace,
      options.ref,
      options.taskId,
      options.stateRunId
    ))
  ) {
    return false;
  }
  await updateTaskIndex(options.workspace, options.taskId, (index) => ({
    ...index,
    latestRunByBlock: {
      ...(index.latestRunByBlock ?? {}),
      [options.ref]: options.stateRunId
    }
  }));
  return true;
}

export async function runDoctor(options: {
  projectRoot: PackageWorkspaceRef;
  repair?: boolean;
}): Promise<DoctorReport> {
  const { workspace, manifest } = await loadPackage(options.projectRoot);
  const graph = compileTaskGraph(manifest);

  const diagnose = async (): Promise<DoctorReport> => {
    let state = await readState(workspace.stateFile);
    const issues: DoctorIssue[] = [];
    let stateChanged = false;

    for (const ref of state.currentRefs ?? []) {
      if (!graph.blocksByRef.has(ref)) {
        const repaired = options.repair ? repairStaleCurrentRef(state, ref) : false;
        stateChanged = stateChanged || repaired;
        issues.push({
          code: "stale_current_ref",
          ref,
          repaired,
          message: `Current ref '${ref}' does not exist in the manifest.`
        });
      }
    }

    for (const orphan of await findOrphanResults(workspace, manifest)) {
      issues.push({
        code: "orphan_result",
        taskId: orphan.taskId,
        path: orphan.path,
        message: `Result directory '${orphan.taskId}' does not belong to a manifest task.`
      });
    }

    for (const taskId of graph.taskNodesInManifestOrder) {
      const indexPath = join(workspace.resultsDir, taskId, "index.json");
      let index: TaskResultIndex;
      try {
        index = await readTaskIndex(workspace, taskId);
      } catch (error) {
        issues.push({
          code: "task_result_index_invalid",
          taskId,
          path: indexPath,
          repaired: false,
          message: error instanceof Error ? error.message : String(error)
        });
        continue;
      }
      const checkedRefs = new Set<string>();
      for (const [ref, indexRunId] of Object.entries(index.latestRunByBlock ?? {})) {
        checkedRefs.add(ref);
        const stateRunId = state.blocks?.[ref]?.lastRunId ?? null;
        if (stateRunId !== indexRunId) {
          const repaired = options.repair
            ? await repairStateRunMismatch({ workspace, state, ref, taskId, indexRunId })
            : false;
          stateChanged = stateChanged || repaired;
          issues.push({
            code: "index_state_mismatch",
            ref,
            taskId,
            path: indexPath,
            stateRunId,
            indexRunId,
            repaired,
            message: `Task index points '${ref}' to '${indexRunId}', but state has '${stateRunId ?? "none"}'.`
          });
        }
      }
      for (const ref of requireMapValue(graph.blocksByTask, taskId, "blocksByTask")) {
        if (checkedRefs.has(ref)) {
          continue;
        }
        const stateRunId = state.blocks?.[ref]?.lastRunId ?? null;
        if (!stateRunId) {
          continue;
        }
        const repaired = options.repair
          ? await repairIndexRunMismatch({ workspace, ref, taskId, stateRunId })
          : false;
        issues.push({
          code: "index_state_mismatch",
          ref,
          taskId,
          path: indexPath,
          stateRunId,
          indexRunId: null,
          repaired,
          message: `State points '${ref}' to '${stateRunId}', but task index has no latest run for it.`
        });
      }
    }

    if (stateChanged) {
      state = ensureStateForManifest(manifest, state);
      await writeState(workspace.stateFile, state);
    }

    // Retention candidate collection also reads task indexes for protection; skip when an
    // index is already known invalid so doctor can report the index issue without a second throw.
    if (!issues.some((issue) => issue.code === "task_result_index_invalid")) {
      const retention = await countRetentionArtifacts(workspace);
      if (retention.total > RETENTION_DOCTOR_THRESHOLD) {
        issues.push({
          code: "retention_threshold_exceeded",
          severity: "warning",
          path: workspace.resultsDir,
          count: retention.total,
          threshold: RETENTION_DOCTOR_THRESHOLD,
          message:
            `Results/run-session artifact count is ${retention.total} (threshold ${RETENTION_DOCTOR_THRESHOLD}). ` +
            `Preview with \`planweave run-sessions prune --older-than 30d --dry-run\` then delete with \`--force --reason <text>\`.`
        });
      }
    }

    // Auto Run pending-transition fail-closed checks (shared inspect path with latest/start gate).
    // Healing runs via desktop getLatest/start gate (recoverAllPendingTransitions); doctor reports only.
    for (const d of await inspectPendingTransitionsForWorkspace(workspace)) {
      if (
        d.code === "auto_run_pending_transition_unreadable" ||
        d.code === "auto_run_pending_transition_incomplete"
      ) {
        issues.push({
          code: d.code,
          message: d.message,
          path: d.path,
          ...(d.transitionId ? { transitionId: d.transitionId } : {}),
          repaired: false
        });
      }
    }

    return {
      ok: issues.every((issue) => !isDoctorErrorIssue(issue) || issue.repaired === true),
      issues
    };
  };

  // Repair mutates state.json (and may nest updateTaskIndex); hold the canvas lock for the full RMW.
  if (options.repair) {
    return withCanvasLock(dirname(workspace.stateFile), diagnose);
  }
  return diagnose();
}
