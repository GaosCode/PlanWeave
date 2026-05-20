import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readState } from "../state.js";
import { readResultIndex } from "../results/indexFile.js";
import { submitRunResult } from "../results/submitResult.js";
import { submitReview } from "../results/submitReview.js";
import { claimNextTask } from "../tasks/claimNext.js";
import { markVerified } from "../tasks/markVerified.js";
import { createPackageWorkspace } from "./promptTestHelpers.js";

describe("submitReview and markVerified", () => {
  it("updates review without creating a run and moves task to needs_changes", async () => {
    const { root, init } = await createPackageWorkspace();
    const implementation = join(init.workspace.workspaceRoot, "implementation.md");
    const review = join(init.workspace.workspaceRoot, "review.md");
    await writeFile(implementation, "Implemented.\n", "utf8");
    await writeFile(review, "Please revise.\n", "utf8");
    await claimNextTask({ projectRoot: root });
    await submitRunResult({ projectRoot: root, taskId: "T-001", reportPath: implementation });

    const result = await submitReview({ projectRoot: root, taskId: "T-001", reportPath: review, status: "needs_changes" });
    const state = await readState(init.workspace.stateFile);

    expect(result.taskStatus).toBe("needs_changes");
    expect(result.index.runCount).toBe(1);
    expect(state.tasks["T-001"]?.status).toBe("needs_changes");
    delete process.env.PLANWEAVE_HOME;
  });

  it("rejects passed review when the task has no latest implementation run", async () => {
    const { root, init } = await createPackageWorkspace();
    const review = join(init.workspace.workspaceRoot, "review.md");
    await writeFile(review, "Passed.\n", "utf8");

    await expect(submitReview({ projectRoot: root, taskId: "T-001", reportPath: review, status: "passed" })).rejects.toThrow(
      "requires an implemented run"
    );

    const state = await readState(init.workspace.stateFile);
    const index = await readResultIndex(join(init.workspace.resultsDir, "T-001", "index.json"));
    expect(state.tasks["T-001"]?.status).toBe("ready");
    expect(index).toBeNull();
    delete process.env.PLANWEAVE_HOME;
  });

  it("rejects unsupported review statuses before mutating state or review", async () => {
    const { root, init } = await createPackageWorkspace();
    const implementation = join(init.workspace.workspaceRoot, "implementation.md");
    const review = join(init.workspace.workspaceRoot, "review.md");
    await writeFile(implementation, "Implemented.\n", "utf8");
    await writeFile(review, "Bogus review.\n", "utf8");
    await claimNextTask({ projectRoot: root });
    await submitRunResult({ projectRoot: root, taskId: "T-001", reportPath: implementation });

    await expect(
      submitReview({
        projectRoot: root,
        taskId: "T-001",
        reportPath: review,
        // @ts-expect-error exercises runtime validation for untyped callers.
        status: "bogus"
      })
    ).rejects.toThrow("Unsupported submit-review status 'bogus'.");

    const state = await readState(init.workspace.stateFile);
    const index = await readResultIndex(join(init.workspace.resultsDir, "T-001", "index.json"));
    expect(state.tasks["T-001"]?.status).toBe("implemented");
    expect(index?.status).toBe("implemented");
    expect(index?.review).toBeUndefined();
    delete process.env.PLANWEAVE_HOME;
  });

  it("can explicitly mark a task verified", async () => {
    const { root, init } = await createPackageWorkspace();

    await markVerified({ projectRoot: root, taskId: "T-001" });
    const state = await readState(init.workspace.stateFile);
    const index = await readResultIndex(join(init.workspace.resultsDir, "T-001", "index.json"));

    expect(state.tasks["T-001"]?.status).toBe("verified");
    expect(index?.verification?.source).toBe("manual");
    delete process.env.PLANWEAVE_HOME;
  });

  it("preserves review attempt history instead of only keeping the latest review body", async () => {
    const { root, init } = await createPackageWorkspace();
    const implementation1 = join(init.workspace.workspaceRoot, "implementation-1.md");
    const implementation2 = join(init.workspace.workspaceRoot, "implementation-2.md");
    const review1 = join(init.workspace.workspaceRoot, "review-1.md");
    const review2 = join(init.workspace.workspaceRoot, "review-2.md");
    await writeFile(implementation1, "First implementation.\n", "utf8");
    await writeFile(implementation2, "Second implementation.\n", "utf8");
    await writeFile(review1, "Please revise.\n", "utf8");
    await writeFile(review2, "Passed.\n", "utf8");

    await claimNextTask({ projectRoot: root });
    await submitRunResult({ projectRoot: root, taskId: "T-001", reportPath: implementation1 });
    await submitReview({ projectRoot: root, taskId: "T-001", reportPath: review1, status: "needs_changes" });
    await claimNextTask({ projectRoot: root });
    await submitRunResult({ projectRoot: root, taskId: "T-001", reportPath: implementation2 });
    const result = await submitReview({ projectRoot: root, taskId: "T-001", reportPath: review2, status: "passed" });

    expect(result.index.reviewHistory?.map((review) => review.reviewId)).toEqual(["REVIEW-001", "REVIEW-002"]);
    await expect(readFile(join(init.workspace.resultsDir, "T-001", "reviews", "REVIEW-001.md"), "utf8")).resolves.toBe(
      "Please revise.\n"
    );
    await expect(readFile(join(init.workspace.resultsDir, "T-001", "reviews", "REVIEW-002.md"), "utf8")).resolves.toBe(
      "Passed.\n"
    );
    delete process.env.PLANWEAVE_HOME;
  });
});
