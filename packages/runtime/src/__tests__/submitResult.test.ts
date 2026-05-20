import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readState } from "../state.js";
import { readResultIndex } from "../results/indexFile.js";
import { submitRunResult } from "../results/submitResult.js";
import { claimNextTask } from "../tasks/claimNext.js";
import { createPackageWorkspace } from "./promptTestHelpers.js";

describe("submitRunResult", () => {
  it("creates an implementation run and updates task state", async () => {
    const { root, init } = await createPackageWorkspace();
    const reportPath = join(init.workspace.workspaceRoot, "implementation.md");
    await writeFile(reportPath, "Implemented.\n", "utf8");
    await claimNextTask({ projectRoot: root });

    const result = await submitRunResult({ projectRoot: root, taskId: "T-001", reportPath });
    const state = await readState(init.workspace.stateFile);
    const copied = await readFile(join(init.workspace.resultsDir, "T-001", "runs", "RUN-001", "implementation.md"), "utf8");

    expect(result.runId).toBe("RUN-001");
    expect(state.tasks["T-001"]?.status).toBe("implemented");
    expect(copied).toBe("Implemented.\n");
    delete process.env.PLANWEAVE_HOME;
  });

  it("rejects submitting a task that has not been claimed", async () => {
    const { root, init } = await createPackageWorkspace();
    const reportPath = join(init.workspace.workspaceRoot, "implementation.md");
    await writeFile(reportPath, "Implemented.\n", "utf8");

    await expect(submitRunResult({ projectRoot: root, taskId: "T-001", reportPath })).rejects.toThrow(
      "must be in_progress"
    );

    const state = await readState(init.workspace.stateFile);
    const index = await readResultIndex(join(init.workspace.resultsDir, "T-001", "index.json"));
    expect(state.tasks["T-001"]?.status).toBe("ready");
    expect(index).toBeNull();
    delete process.env.PLANWEAVE_HOME;
  });

  it("rejects unsupported run statuses before mutating state or results", async () => {
    const { root, init } = await createPackageWorkspace();
    const reportPath = join(init.workspace.workspaceRoot, "implementation.md");
    await writeFile(reportPath, "Implemented.\n", "utf8");

    await expect(
      submitRunResult({
        projectRoot: root,
        taskId: "T-001",
        reportPath,
        // @ts-expect-error exercises runtime validation for untyped callers.
        status: "bogus"
      })
    ).rejects.toThrow("Unsupported submit-result status 'bogus'.");

    const state = await readState(init.workspace.stateFile);
    const index = await readResultIndex(join(init.workspace.resultsDir, "T-001", "index.json"));
    expect(state.tasks["T-001"]).toBeUndefined();
    expect(index).toBeNull();
    delete process.env.PLANWEAVE_HOME;
  });
});
