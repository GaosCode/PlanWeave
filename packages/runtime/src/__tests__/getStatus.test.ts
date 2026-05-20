import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { markDiverged } from "../tasks/markDiverged.js";
import { getStatus } from "../status/getStatus.js";
import { writeJsonFile } from "../json.js";
import { createPackageWorkspace } from "./promptTestHelpers.js";

describe("getStatus", () => {
  it("reports project id, root, task total, counts, and current task", async () => {
    const { root } = await createPackageWorkspace();
    await markDiverged({ projectRoot: root, taskId: "T-001", reason: "Plan changed." });

    const status = await getStatus({ projectRoot: root });

    expect(status.projectRoot).toBe(await realpath(root));
    expect(status.taskTotal).toBe(1);
    expect(status.counts.diverged).toBe(1);
    expect(status.diverged).toBe(1);
    expect(status.divergedTasks).toEqual([{ taskId: "T-001", reason: "Plan changed." }]);
    delete process.env.PLANWEAVE_HOME;
  });

  it("reports orphan state and orphan results", async () => {
    const { root, init } = await createPackageWorkspace();
    await writeJsonFile(init.workspace.stateFile, {
      currentTaskId: "T-ORPHAN",
      tasks: {
        "T-ORPHAN": { status: "in_progress", claimedBy: "agent", lastRunId: null, blockedBy: [] }
      }
    });
    await mkdir(join(init.workspace.resultsDir, "T-ORPHAN"), { recursive: true });
    await writeJsonFile(join(init.workspace.resultsDir, "T-ORPHAN", "index.json"), {
      taskId: "T-ORPHAN",
      status: "implemented",
      latestRunId: "RUN-001",
      runCount: 1
    });

    const status = await getStatus({ projectRoot: root });

    expect(status.currentTaskId).toBeNull();
    expect(status.orphanState).toEqual([{ taskId: "T-ORPHAN", status: "in_progress", lastRunId: null }]);
    expect(status.orphanResults).toEqual([
      { taskId: "T-ORPHAN", path: join(init.workspace.resultsDir, "T-ORPHAN") }
    ]);
    delete process.env.PLANWEAVE_HOME;
  });
});
