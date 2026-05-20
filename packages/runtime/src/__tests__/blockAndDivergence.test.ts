import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readResultIndex } from "../results/indexFile.js";
import { readState } from "../state.js";
import { markBlocked } from "../tasks/markBlocked.js";
import { markDiverged } from "../tasks/markDiverged.js";
import { resolveDivergence } from "../tasks/resolveDivergence.js";
import { unblockTask } from "../tasks/unblock.js";
import { claimNextTask } from "../tasks/claimNext.js";
import { submitRunResult } from "../results/submitResult.js";
import { submitReview } from "../results/submitReview.js";
import { baseManifest, createPackageWorkspace } from "./promptTestHelpers.js";

describe("blocked and divergence task lifecycle", () => {
  it("marks and unblocks an explicit blocked task", async () => {
    const { root, init } = await createPackageWorkspace();

    await markBlocked({ projectRoot: root, taskId: "T-001", reason: "Waiting for credentials." });
    await unblockTask({ projectRoot: root, taskId: "T-001" });
    const state = await readState(init.workspace.stateFile);
    const index = await readResultIndex(join(init.workspace.resultsDir, "T-001", "index.json"));

    expect(state.tasks["T-001"]?.status).toBe("ready");
    expect(state.tasks["T-001"]?.blockage).toBeUndefined();
    expect(index?.events?.map((event) => event.type)).toEqual(["blocked", "unblocked"]);
    delete process.env.PLANWEAVE_HOME;
  });

  it("unblocks a task with needs_changes review back to needs_changes", async () => {
    const { root, init } = await createPackageWorkspace();
    const reportPath = join(init.workspace.workspaceRoot, "implementation.md");
    const reviewPath = join(init.workspace.workspaceRoot, "review.md");
    await writeFile(reportPath, "Implemented.\n", "utf8");
    await writeFile(reviewPath, "Needs changes.\n", "utf8");
    await claimNextTask({ projectRoot: root });
    await submitRunResult({ projectRoot: root, taskId: "T-001", reportPath });
    await submitReview({ projectRoot: root, taskId: "T-001", status: "needs_changes", reportPath: reviewPath });
    await markBlocked({ projectRoot: root, taskId: "T-001", reason: "Waiting for user decision." });

    const result = await unblockTask({ projectRoot: root, taskId: "T-001" });
    const state = await readState(init.workspace.stateFile);
    const index = await readResultIndex(join(init.workspace.resultsDir, "T-001", "index.json"));

    expect(result.status).toBe("needs_changes");
    expect(state.tasks["T-001"]?.status).toBe("needs_changes");
    expect(state.tasks["T-001"]?.blockage).toBeUndefined();
    expect(index?.status).toBe("needs_changes");
    expect(index?.review?.status).toBe("needs_changes");
    expect(index?.events?.map((event) => event.type)).toEqual(["claimed", "run_submitted", "review_submitted", "blocked", "unblocked"]);
    delete process.env.PLANWEAVE_HOME;
  });

  it("resolves divergence back to needs_changes when the latest review requested changes", async () => {
    const { root, init } = await createPackageWorkspace();
    const reportPath = join(init.workspace.workspaceRoot, "implementation.md");
    const reviewPath = join(init.workspace.workspaceRoot, "review.md");
    await writeFile(reportPath, "Implemented.\n", "utf8");
    await writeFile(reviewPath, "Needs changes.\n", "utf8");
    await claimNextTask({ projectRoot: root });
    await submitRunResult({ projectRoot: root, taskId: "T-001", reportPath });
    await submitReview({ projectRoot: root, taskId: "T-001", status: "needs_changes", reportPath: reviewPath });
    await markDiverged({ projectRoot: root, taskId: "T-001", reason: "Plan changed." });

    const result = await resolveDivergence({ projectRoot: root, taskId: "T-001", reason: "Plan Package updated." });
    const state = await readState(init.workspace.stateFile);

    expect(result.status).toBe("needs_changes");
    expect(state.tasks["T-001"]?.status).toBe("needs_changes");
    expect(state.tasks["T-001"]?.divergence).toBeUndefined();
    delete process.env.PLANWEAVE_HOME;
  });

  it("requires non-empty reasons for divergence marking and recovery", async () => {
    const { root } = await createPackageWorkspace();

    await expect(markDiverged({ projectRoot: root, taskId: "T-001", reason: "   " })).rejects.toThrow("non-empty reason");
    await expect(resolveDivergence({ projectRoot: root, taskId: "T-001", reason: "   " })).rejects.toThrow(
      "non-empty reason"
    );
    delete process.env.PLANWEAVE_HOME;
  });

  it("resolves divergence back to planned when dependencies are not satisfied", async () => {
    const { root, init } = await createPackageWorkspace(
      baseManifest({
        nodes: [
          ...baseManifest().nodes,
          {
            id: "T-002",
            type: "task",
            title: "Second task",
            prompt: "nodes/T-001.prompt.md",
            acceptance: ["done"],
            parallel: { safe: true, locks: [] }
          }
        ],
        edges: [...baseManifest().edges, { from: "T-002", to: "T-001", type: "depends_on" }]
      })
    );
    await markDiverged({ projectRoot: root, taskId: "T-002", reason: "Plan changed." });

    const result = await resolveDivergence({ projectRoot: root, taskId: "T-002", reason: "Plan Package updated." });
    const state = await readState(init.workspace.stateFile);

    expect(result.status).toBe("planned");
    expect(state.tasks["T-002"]?.blockedBy).toEqual(["T-001"]);
    delete process.env.PLANWEAVE_HOME;
  });
});
