import { describe, expect, it } from "vitest";
import { claimNextTask } from "../tasks/claimNext.js";
import { readState, writeState } from "../state.js";
import { writeJsonFile } from "../json.js";
import type { PlanPackageManifest } from "../types.js";
import { baseManifest, createPackageWorkspace } from "./promptTestHelpers.js";

describe("claimNextTask", () => {
  it("claims the first ready task and returns it while in progress", async () => {
    const { root, init } = await createPackageWorkspace();

    const first = await claimNextTask({ projectRoot: root });
    const second = await claimNextTask({ projectRoot: root });

    expect(first).toMatchObject({ taskId: "T-001", status: "claimed" });
    expect(second).toMatchObject({ taskId: "T-001", status: "current" });
    delete process.env.PLANWEAVE_HOME;
    await readState(init.workspace.stateFile);
  });

  it("prioritizes needs_changes over ready tasks", async () => {
    const { root, init } = await createPackageWorkspace();
    const state = await readState(init.workspace.stateFile);
    state.tasks["T-001"] = { status: "needs_changes", claimedBy: null, lastRunId: "RUN-001", blockedBy: [] };
    await writeState(init.workspace.stateFile, state);

    const result = await claimNextTask({ projectRoot: root });

    expect(result).toMatchObject({ taskId: "T-001", status: "claimed" });
    delete process.env.PLANWEAVE_HOME;
  });

  it("reconciles stale in-progress task state after the task is removed from the manifest", async () => {
    const { root, init } = await createPackageWorkspace();
    await claimNextTask({ projectRoot: root });

    const manifest: PlanPackageManifest = baseManifest({
      nodes: [{ id: "G-001", type: "goal", title: "Goal", summary: "Keep context visible." }],
      edges: []
    });
    await writeJsonFile(init.workspace.manifestFile, manifest);

    const result = await claimNextTask({ projectRoot: root });
    const state = await readState(init.workspace.stateFile);

    expect(result).toEqual({ taskId: null, status: "none" });
    expect(state.currentTaskId).toBeNull();
    expect(state.tasks["T-001"]).toBeUndefined();
    delete process.env.PLANWEAVE_HOME;
  });
});
