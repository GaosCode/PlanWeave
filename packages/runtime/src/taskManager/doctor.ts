import { join } from "node:path";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { findOrphanResults } from "../package/orphans.js";
import { loadPackage } from "../package/loadPackage.js";
import { readState } from "../state.js";
import type { DoctorIssue, DoctorReport, PackageWorkspaceRef } from "../types.js";
import { readTaskIndex } from "./resultIndex.js";

export async function runDoctor(options: { projectRoot: PackageWorkspaceRef }): Promise<DoctorReport> {
  const { workspace, manifest } = await loadPackage(options.projectRoot);
  const graph = compileTaskGraph(manifest);
  const state = await readState(workspace.stateFile);
  const issues: DoctorIssue[] = [];

  for (const ref of state.currentRefs ?? []) {
    if (!graph.blocksByRef.has(ref)) {
      issues.push({
        code: "stale_current_ref",
        ref,
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
    const index = await readTaskIndex(workspace, taskId);
    for (const [ref, indexRunId] of Object.entries(index.latestRunByBlock ?? {})) {
      const stateRunId = state.blocks?.[ref]?.lastRunId ?? null;
      if (stateRunId !== indexRunId) {
        issues.push({
          code: "index_state_mismatch",
          ref,
          taskId,
          path: join(workspace.resultsDir, taskId, "index.json"),
          stateRunId,
          indexRunId,
          message: `Task index points '${ref}' to '${indexRunId}', but state has '${stateRunId ?? "none"}'.`
        });
      }
    }
  }

  return { ok: issues.length === 0, issues };
}
